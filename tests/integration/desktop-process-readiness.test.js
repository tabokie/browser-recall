import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  waitForDesktopStartup,
  waitForProcessProbe,
} from '../smoke/desktop-process-readiness.mjs';
import { runTestProcess } from '../smoke/windows-desktop-process.mjs';

test.each(['ready', 'early logging', 'late logging', 'exit', 'stall'])(
  'native startup observes a real process without accepting a missed deadline: %s',
  async (mode) => {
    const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-startup-'));
    const logs = path.join(work, 'application.log');
    const stages = path.join(work, 'stages.log');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs');
         const [logs, stages, initialLog] = process.argv.slice(1);
         fs.writeFileSync(stages, 'main entered');
         process.on('message', (action) => {
           if (action === 'log') {
             fs.appendFileSync(stages, '\\nlogging initialized');
             fs.writeFileSync(logs, initialLog);
             process.send('logged');
           }
           if (action === 'complete') {
             fs.appendFileSync(stages, '\\nnative setup finished');
             fs.appendFileSync(logs, '\\ndesktop native startup complete');
           }
           if (action === 'exit') process.exit(23);
         });
         process.send('ready');`,
        logs,
        stages,
        mode === 'early logging'
          ? 'starting browser recall desktop shell'
          : 'desktop native startup complete',
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const closed = once(child, 'close');
    try {
      expect(
        (
          await once(child, 'message', { signal: AbortSignal.timeout(5000) })
        )[0],
      ).toBe('ready');
      if (mode === 'ready' || mode === 'early logging') {
        const logged = once(child, 'message', {
          signal: AbortSignal.timeout(5000),
        });
        child.send('log');
        expect((await logged)[0]).toBe('logged');
      }
      let deadlineStages;
      const started = performance.now();
      const result = await waitForDesktopStartup(child, {
        timeoutMs: 100,
        observationMs: mode === 'stall' ? 150 : 2000,
        readLogs: () => {
          try {
            return readFileSync(logs, 'utf8');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return '';
          }
        },
        readStages: () => {
          deadlineStages = readFileSync(stages, 'utf8');
          // Release the child only after the original deadline is observed.
          if (mode === 'late logging') child.send('log');
          if (mode === 'early logging') child.send('complete');
          if (mode === 'exit') child.send('exit');
          return deadlineStages;
        },
      }).catch((error) => error);
      if (mode === 'ready') {
        expect(result).toBe('desktop native startup complete');
        expect(deadlineStages).toBeUndefined();
      } else {
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toContain('did not finish native startup');
        expect(deadlineStages).toBe(
          mode === 'early logging'
            ? 'main entered\nlogging initialized'
            : 'main entered',
        );
        expect(result.followUp).toContain(
          'Stages at the original deadline:\nmain entered',
        );
        if (mode !== 'early logging') {
          expect(result.followUp).not.toContain('logging initialized');
        }
        if (mode === 'late logging' || mode === 'early logging') {
          expect(result.startupLogs).toContain(
            'desktop native startup complete',
          );
          expect(result.followUp).toMatch(/startup completed after \d+ms/);
          expect(readFileSync(stages, 'utf8')).toContain('logging initialized');
        } else if (mode === 'exit') {
          expect(result.followUp).toContain('process exited during diagnostic');
          expect(child.exitCode).toBe(23);
        } else {
          expect(result.followUp).toContain('startup remained incomplete');
          expect(child.exitCode).toBeNull();
          expect(performance.now() - started).toBeLessThan(2000);
        }
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test('native probe retries keep the last subprocess error within one readiness budget', async () => {
  const owner = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
  const closed = once(owner, 'close');
  let probePid;
  let probeExit;
  const budgets = [];
  try {
    await once(owner, 'spawn');
    const started = performance.now();
    const result = await waitForProcessProbe(
      owner,
      async (pid, remainingMs) => {
        expect(pid).toBe(owner.pid);
        budgets.push(remainingMs);
        return runTestProcess(
          process.execPath,
          [
            '-e',
            budgets.length === 1
              ? 'console.error("window handle unavailable"); process.exit(7)'
              : 'console.log(process.pid); console.error("native probe stalled"); setInterval(() => {}, 1000)',
          ],
          { timeoutMs: remainingMs },
        ).catch((error) => {
          if (error.killed) {
            probePid = Number(error.stdout.trim());
            probeExit = error;
          }
          throw error;
        });
      },
      { timeoutMs: 1500, description: 'Desktop window icons' },
    ).catch((error) => error);
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBeLessThanOrEqual(1500);
    expect(budgets[1]).toBeGreaterThan(0);
    expect(budgets[1]).toBeLessThan(budgets[0]);
    expect(result.message).toContain('Desktop window icons');
    expect(result.message).toContain('native probe stalled');
    expect(result.cause).toBe(probeExit);
    expect(probeExit.killed).toBe(true);
    expect(Number.isInteger(probePid)).toBe(true);
    expect(() => process.kill(probePid, 0)).toThrow();
    expect(performance.now() - started).toBeLessThan(5000);
  } finally {
    owner.kill();
    await closed;
  }
});
