import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect, test } from 'vitest';
import {
  removeTestProfile,
  stopTestProcess,
  waitForExit,
  withCleanup,
} from '../smoke/windows-desktop-process.mjs';

test('teardown preserves the original failure and completes cleanup after an error', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'browser-recall-cleanup-'));
  const marker = path.join(workDir, 'later-cleanup');
  writeFileSync(marker, 'must be removed');
  const original = new Error('native assertion failed');
  try {
    const error = await withCleanup(async () => {
      throw original;
    }, [
      () => unlink(path.join(workDir, 'missing-file')),
      () => unlink(marker),
      () => removeTestProfile(workDir),
    ]).catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(original);
    expect(error.errors[0]).toBe(original);
    expect(error.errors[1].code).toBe('ENOENT');
    expect(error.errors).toHaveLength(2);
    expect(existsSync(workDir)).toBe(false);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('cleanup recognizes a process that has already exited after a signal', async () => {
  const child = spawn(process.execPath, [
    '-e',
    "console.log('ready'); setInterval(() => {}, 1000)",
  ]);
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  child.kill();
  await exited;
  await expect(waitForExit(child, 100)).resolves.toEqual({
    code: child.exitCode,
    signal: child.signalCode,
  });
  await stopTestProcess(child);
});

test('cleanup removes nested read-only profile files', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'browser-recall-cleanup-'));
  const cacheDir = path.join(workDir, 'profile', 'webview2', 'cache');
  const cacheFile = path.join(cacheDir, 'read-only-cache');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, 'disposable profile cache');
  chmodSync(cacheFile, 0o444);
  try {
    await removeTestProfile(workDir);
    expect(existsSync(workDir)).toBe(false);
  } finally {
    if (existsSync(cacheFile)) chmodSync(cacheFile, 0o666);
    await rm(workDir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'win32').each(['terminate', 'release'])(
  'cleanup handles an exclusive descendant lock: %s',
  async (mode) => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'browser-recall-cleanup-'));
    const lockFile = path.join(workDir, 'locked-profile');
    const lockScript = [
      '$file = [IO.File]::Open($env:BROWSER_RECALL_LOCK_FILE, "OpenOrCreate", "ReadWrite", "None")',
      '[Console]::WriteLine($PID)',
      '[Console]::ReadLine() | Out-Null',
      '$file.Dispose()',
    ].join('; ');
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `require('node:child_process').spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', ${JSON.stringify(lockScript)}],
          {stdio: ['inherit', 'inherit', 'inherit']});
         setInterval(() => {}, 1000);`,
      ],
      { env: { ...process.env, BROWSER_RECALL_LOCK_FILE: lockFile } },
    );
    const lines = createInterface({ input: parent.stdout });
    let descendant;
    try {
      const [line] = await once(lines, 'line', {
        signal: AbortSignal.timeout(10_000),
      });
      descendant = Number(line);
      expect(descendant).toBeGreaterThan(0);
      expect(() => rmSync(workDir, { recursive: true, force: true })).toThrow();
      if (mode === 'terminate') {
        await stopTestProcess(parent);
      }
      let retries = 0;
      await removeTestProfile(
        workDir,
        mode === 'release'
          ? (error) => {
              expect(['EPERM', 'EBUSY']).toContain(error.code);
              if (++retries === 1) parent.stdin.write('release\n');
            }
          : undefined,
      );
      if (mode === 'release') expect(retries).toBeGreaterThan(0);
      expect(existsSync(workDir)).toBe(false);
    } finally {
      lines.close();
      for (const pid of [parent.pid, descendant].filter(Boolean)) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch {
          // Successful cleanup has already removed these test-owned processes.
        }
      }
      await removeTestProfile(workDir);
    }
  },
  60_000,
);
