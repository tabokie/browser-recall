import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { withPopupLayout } from '../fixtures/popup-layout.mjs';

test('popup diagnostics retain the assertion when writing the layout also fails', async () => {
  const work = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-popup-cleanup-'),
  );
  const blocker = path.join(work, 'not-a-directory');
  writeFileSync(blocker, 'block layout output');
  const testInfo = {
    outputPath: (name) => path.join(blocker, name),
    attach: async () => {},
  };
  let assertion;
  try {
    const error = await withPopupLayout(
      testInfo,
      'layout',
      async () => {
        try {
          assert.equal(512, 296, 'popup width mismatch');
        } catch (error) {
          assertion = error;
          throw error;
        }
      },
      () => ({ width: 512 }),
    ).catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(assertion);
    expect(error.errors[0]).toBe(assertion);
    expect(['ENOTDIR', 'ENOENT']).toContain(error.errors[1].code);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Firefox runner retains a setup failure and cleanup failure and removes allocated files', () => {
  const work = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-firefox-cleanup-'),
  );
  const report = path.join(work, 'allocation.json');
  const entry = new URL('../smoke/firefox-real-content.mjs', import.meta.url)
    .href;
  const harness = new URL('./daemon-test-harness.js', import.meta.url).href;
  const harnessSource = `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { readFileSync, writeFileSync } from 'node:fs';
    export function launchTestDaemon(configDir) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({configDir,pid:child.pid}));
      return child;
    }
    export async function waitForDaemonListening() { throw new Error('primary Firefox setup failure'); }
    export async function stopTestDaemon(child) {
      if (!child) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const allocation = JSON.parse(readFileSync(${JSON.stringify(report)}, 'utf8'));
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({...allocation,stopped:true}));
      throw new Error('secondary Firefox cleanup failure');
    }
  `;
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, nextLoad) {
        if (url === ${JSON.stringify(harness)}) return {format:'module',shortCircuit:true,source:${JSON.stringify(harnessSource)}};
        return nextLoad(url, context);
      }});
      try { await import(${JSON.stringify(entry)}); }
      catch(error) { console.log(JSON.stringify({cause:error.cause?.message,errors:error.errors?.map(item=>item.message)})); }
    `,
      ],
      {
        env: { ...process.env, FIREFOX_BINARY: process.execPath },
        encoding: 'utf8',
        timeout: 10000,
        killSignal: 'SIGKILL',
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      cause: 'primary Firefox setup failure',
      errors: [
        'primary Firefox setup failure',
        'secondary Firefox cleanup failure',
      ],
    });
    expect(existsSync(JSON.parse(readFileSync(report, 'utf8')).configDir)).toBe(
      false,
    );
  } finally {
    if (existsSync(report)) {
      const allocation = JSON.parse(readFileSync(report, 'utf8'));
      if (!allocation.stopped) {
        try {
          process.kill(allocation.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      rmSync(allocation.configDir, { recursive: true, force: true });
    }
    rmSync(work, { recursive: true, force: true });
  }
});
