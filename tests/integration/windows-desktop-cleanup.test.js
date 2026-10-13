import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import {
  removeTestProfile,
  stopTestProcess,
  waitForExit,
} from '../smoke/windows-desktop-process.mjs';
import { withCleanup } from '../smoke/desktop-test-cleanup.mjs';

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
    const profileDir = path.join(workDir, 'profile');
    mkdirSync(profileDir);
    const lockFile = path.join(profileDir, 'locked-profile');
    const readyFile = path.join(workDir, 'ready');
    const releaseFile = path.join(workDir, 'release');
    const lockScript = [
      '$ErrorActionPreference = "Stop"',
      '$file = [IO.File]::Open($env:BROWSER_RECALL_LOCK_FILE, "OpenOrCreate", "ReadWrite", "None")',
      'try {',
      '[IO.File]::WriteAllText($env:BROWSER_RECALL_READY_FILE + ".tmp", [string]$PID)',
      '[IO.File]::Move($env:BROWSER_RECALL_READY_FILE + ".tmp", $env:BROWSER_RECALL_READY_FILE)',
      'while (-not [IO.File]::Exists($env:BROWSER_RECALL_RELEASE_FILE)) { Start-Sleep -Milliseconds 25 }',
      '} finally { $file.Dispose() }',
    ].join('; ');
    // Keep PowerShell's startup input closed. Readiness and release must not
    // depend on console I/O through inherited Node pipes on Windows. Encoding
    // also keeps PowerShell syntax out of Windows command-line quote parsing.
    const encodedScript = Buffer.from(lockScript, 'utf16le').toString('base64');
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const child = require('node:child_process').spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', ${JSON.stringify(encodedScript)}],
          {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
         child.stdout.pipe(process.stdout);
         child.stderr.pipe(process.stderr);
         const keepAlive = setInterval(() => {}, 1000);
         child.on('error', (error) => {
           console.error(error);
           process.exitCode = 1;
           clearInterval(keepAlive);
         });
         child.on('exit', (code) => {
           if (code !== 0) {
             process.exitCode = code ?? 1;
             clearInterval(keepAlive);
           }
         });`,
      ],
      {
        env: {
          ...process.env,
          BROWSER_RECALL_LOCK_FILE: lockFile,
          BROWSER_RECALL_READY_FILE: readyFile,
          BROWSER_RECALL_RELEASE_FILE: releaseFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let output = '';
    let startupError;
    parent.stdout.on('data', (chunk) => (output += chunk));
    parent.stderr.on('data', (chunk) => (output += chunk));
    parent.on('error', (error) => (startupError = error));
    let descendant;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(readyFile)) {
        if (
          startupError ||
          parent.exitCode !== null ||
          parent.signalCode !== null ||
          Date.now() >= deadline
        ) {
          throw new Error(
            `PowerShell lock holder did not become ready (exit ${parent.exitCode}, signal ${parent.signalCode}): ${output}`,
            { cause: startupError },
          );
        }
        await delay(25);
      }
      const ready = readFileSync(readyFile, 'utf8');
      expect(ready).toMatch(/^[1-9]\d*$/);
      descendant = Number(ready);
      expect(() =>
        rmSync(profileDir, { recursive: true, force: true }),
      ).toThrow();
      if (mode === 'terminate') {
        await stopTestProcess(parent);
      }
      let retries = 0;
      await removeTestProfile(
        profileDir,
        mode === 'release'
          ? (error) => {
              expect(['EPERM', 'EBUSY']).toContain(error.code);
              if (++retries === 1) writeFileSync(releaseFile, 'release');
            }
          : undefined,
      );
      if (mode === 'release') expect(retries).toBeGreaterThan(0);
      expect(existsSync(profileDir)).toBe(false);
    } finally {
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
