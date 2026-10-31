import { spawn, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { frameNativeUpdateWindow } from '../smoke/native-update-window.mjs';
import { stopFirefoxProcess } from '../smoke/firefox-process.mjs';

// Exercise native command readiness without launching a tray app or requiring
// Accessibility permission in the user's login session.
test.skipIf(process.platform === 'win32').each([true, false])(
  'native update waits for a window and preserves readiness errors; window appears: %s',
  async (appears) => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-window-ready-'),
    );
    const helper = path.join(work, 'window-helper');
    const attempts = path.join(work, 'attempts');
    writeFileSync(
      helper,
      `#!${process.execPath}
const fs = require('node:fs');
const attempts = ${JSON.stringify(attempts)};
const count = fs.existsSync(attempts) ? Number(fs.readFileSync(attempts)) + 1 : 1;
fs.writeFileSync(attempts, String(count));
if (${!appears} || count < 3) {
  console.error('Browser Recall window unavailable; check Accessibility permission');
  process.exit(1);
}
if (process.argv.slice(2).join(' ') !== '123 frame 960 620') process.exit(2);
`,
    );
    chmodSync(helper, 0o755);
    try {
      if (appears) {
        await frameNativeUpdateWindow(helper, 123);
        expect(readFileSync(attempts, 'utf8')).toBe('3');
      } else {
        await expect(
          frameNativeUpdateWindow(helper, 123, { timeoutMs: 500 }),
        ).rejects.toThrow(
          'Browser Recall window unavailable; check Accessibility permission',
        );
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32').each([false, true])(
  'Firefox cleanup terminates descendants when the launcher has exited: %s',
  async (launcherExits) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
${launcherExits ? 'descendant.unref();' : 'setInterval(() => {}, 1000);'}
`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    const closed = once(child, 'close');
    let descendant;
    let timer;
    try {
      const [output] = await once(child.stdout, 'data');
      descendant = Number(String(output).trim());
      if (launcherExits) await exited;
      await stopFirefoxProcess(child, { timeoutMs: 100 });
      const result = await Promise.race([
        closed.then(() => 'closed'),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('pipes still open'), 1000);
        }),
      ]);
      expect(result).toBe('closed');
      await expect
        .poll(() => {
          const processState = spawnSync(
            '/bin/ps',
            ['-o', 'stat=', '-p', String(descendant)],
            { encoding: 'utf8' },
          );
          if (processState.error) throw processState.error;
          // Linux can retain an orphan's zombie until the CI init process reaps
          // the orphan. A zombie has exited and holds no pipes or connections.
          return (
            processState.status === 1 ||
            processState.stdout.trim().startsWith('Z')
          );
        })
        .toBe(true);
    } finally {
      clearTimeout(timer);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      if (descendant) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await closed;
    }
  },
);

test.skipIf(process.platform === 'win32').each([true, false])(
  'Firefox cleanup preserves denied SIGKILL for live groups; graceful: %s',
  async (graceful) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => { ${graceful ? 'process.exit(0);' : ''} }); console.log('ready'); setInterval(() => {}, 1000)`,
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const closed = once(child, 'close');
    const kill = process.kill.bind(process);
    await once(child.stdout, 'data');
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
      if (pid === -child.pid && name === 'SIGKILL')
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return kill(pid, name);
    });
    try {
      const stopping = stopFirefoxProcess(child, { timeoutMs: 100 });
      if (graceful) {
        await expect(stopping).resolves.toBeUndefined();
        expect(signal.mock.calls).not.toContainEqual([-child.pid, 'SIGKILL']);
      } else await expect(stopping).rejects.toMatchObject({ code: 'EPERM' });
    } finally {
      signal.mockRestore();
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await closed;
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'Firefox cleanup accepts a confirmed dead macOS process group when signals are denied',
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const closed = once(child, 'close');
    await once(child.stdout, 'data');
    const kill = process.kill.bind(process);
    kill(-child.pid, 'SIGTERM');
    // Hold the parent event loop until the real child is defunct. Reaping the
    // child first would lose the macOS state that produced the permission error.
    const deadline = performance.now() + 1000;
    let state;
    do {
      state = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(child.pid)], {
        encoding: 'utf8',
      }).stdout.trim();
      if (state.startsWith('Z')) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    } while (performance.now() < deadline);
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
      if (pid === -child.pid)
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return kill(pid, name);
    });
    try {
      expect(state).toMatch(/^Z/);
      await expect(stopFirefoxProcess(child)).resolves.toBeUndefined();
    } finally {
      signal.mockRestore();
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await closed;
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'Firefox process inspection obeys the cleanup deadline and preserves EPERM',
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const closed = once(child, 'close');
    await once(child.stdout, 'data');
    const kill = process.kill.bind(process);
    const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
      if (pid === -child.pid && name === 'SIGKILL') throw denied;
      return kill(pid, name);
    });
    let inspected;
    const inspection = vi
      .spyOn(childProcess, 'spawnSync')
      .mockImplementation((file, args, options) => {
        if (file !== '/bin/ps') return spawnSync(file, args, options);
        // A real inspector that ignores SIGTERM. The fallback bounds the failing
        // implementation too, so the regression cannot leak a hung test process.
        inspected = spawnSync(
          process.execPath,
          [
            '-e',
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
          ],
          {
            ...options,
            timeout: options.timeout ?? 1500,
            killSignal: 'SIGKILL',
          },
        );
        return inspected;
      });
    const started = performance.now();
    try {
      await expect(stopFirefoxProcess(child, { timeoutMs: 100 })).rejects.toBe(
        denied,
      );
      expect(performance.now() - started).toBeLessThan(1000);
      expect(inspected.error.code).toBe('ETIMEDOUT');
      expect(inspected.signal).toBe('SIGKILL');
    } finally {
      inspection.mockRestore();
      signal.mockRestore();
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await closed;
    }
  },
);
