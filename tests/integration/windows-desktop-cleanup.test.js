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
  runTestProcess,
  stopTestProcess,
  waitForExit,
} from '../smoke/windows-desktop-process.mjs';
import {
  stopNativeUpdateProcesses,
  withCleanup,
} from '../smoke/desktop-test-cleanup.mjs';

test('native test commands close input, terminate stalled subprocesses, and preserve diagnostics', async () => {
  await expect(
    runTestProcess(process.execPath, [
      '-e',
      "process.stdin.resume(); process.stdin.on('end', () => console.log('input closed'))",
    ]),
  ).resolves.toBe('input closed\n');
  await expect(
    runTestProcess(
      process.execPath,
      ['-e', "console.log('waiting for signing'); setTimeout(() => {}, 2000)"],
      { timeoutMs: 1000 },
    ),
  ).rejects.toMatchObject({
    killed: true,
    stdout: 'waiting for signing\n',
    message: expect.stringContaining(
      'Native test process timed out after 1000ms',
    ),
  });
});

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

test('native process waiting reports a failed launch instead of timing out', async () => {
  const work = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-missing-launch-'),
  );
  try {
    const child = spawn(path.join(work, 'missing.exe'), []);
    // An independent observer must not consume the exit waiter's launch error.
    child.on('error', () => {});
    await expect(waitForExit(child, 1000)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
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

test.each(['before PID discovery', 'after relaunch', 'PID discovery fails'])(
  'native update cleanup stops its real subprocess after failure %s',
  async (stage) => {
    const children = [];
    const start = async () => {
      const child = spawn(
        process.execPath,
        ['-e', "console.log('ready'); setInterval(() => {}, 1000)"],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.push(child);
      await once(child.stdout, 'data');
      return child;
    };
    const stopPid = async (pid) => {
      const child = children.findLast((candidate) => candidate.pid === pid);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    };
    try {
      const original = await start();
      let current = original;
      let pid;
      if (stage === 'after relaunch') {
        pid = original.pid;
        await stopPid(pid);
        current = await start();
      }
      const discoveryError = new Error('PID lookup failed');
      const cleanup = stopNativeUpdateProcesses({
        pid,
        child: original,
        findPid: () => {
          if (stage === 'PID discovery fails') throw discoveryError;
          return stage === 'after relaunch' ? current.pid : 0;
        },
        stopPid,
      });
      if (stage === 'PID discovery fails')
        await expect(cleanup).rejects.toBe(discoveryError);
      else await cleanup;
      expect(current.exitCode !== null || current.signalCode !== null).toBe(
        true,
      );
    } finally {
      for (const child of children) await stopPid(child.pid);
    }
  },
);

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

test.skipIf(process.platform !== 'win32')(
  'installed-app smoke runner allows the first native GUI window to be visible',
  async () => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-gui-startup-'),
    );
    const executable = path.join(work, 'visibility-probe.exe');
    const report = path.join(work, 'visibility.json');
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          String.raw`
$source = @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class BrowserRecallStartupVisibilityProbe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern IntPtr CreateWindowExW(uint extendedStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern IntPtr GetModuleHandleW(string name);
  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool DestroyWindow(IntPtr window);
  public static void Main() {
    IntPtr window = CreateWindowExW(0, "STATIC", "Browser Recall startup visibility probe", 0x00CF0000, 100, 100, 320, 200, IntPtr.Zero, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
    if (window == IntPtr.Zero) throw new Win32Exception();
    try {
      ShowWindow(window, 1);
      File.WriteAllText(Environment.GetEnvironmentVariable("BROWSER_RECALL_VISIBILITY_PROBE_REPORT"), "{\"visible\":" + (IsWindowVisible(window) ? "true" : "false") + "}");
    } finally {
      DestroyWindow(window);
    }
  }
}
'@
$parameters = New-Object System.CodeDom.Compiler.CompilerParameters
$parameters.GenerateExecutable = $true
$parameters.OutputAssembly = $env:BROWSER_RECALL_VISIBILITY_PROBE_EXE
$parameters.CompilerOptions = '/target:winexe /win32icon:"' + $env:BROWSER_RECALL_VISIBILITY_PROBE_ICON + '"'
[void]$parameters.ReferencedAssemblies.Add('System.dll')
Add-Type -TypeDefinition $source -CompilerParameters $parameters
`,
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 20_000,
          env: {
            ...process.env,
            BROWSER_RECALL_VISIBILITY_PROBE_EXE: executable,
            BROWSER_RECALL_VISIBILITY_PROBE_ICON: path.resolve(
              'apps/desktop/src-tauri/icons/icon.ico',
            ),
          },
        },
      );
      let failure;
      try {
        execFileSync(
          process.execPath,
          ['tests/smoke/windows-desktop-single-instance.mjs'],
          {
            encoding: 'utf8',
            timeout: 20_000,
            windowsHide: true,
            env: {
              ...process.env,
              GITHUB_ACTIONS: 'false',
              BROWSER_RECALL_DESKTOP_TEST_EXECUTABLE: executable,
              BROWSER_RECALL_VISIBILITY_PROBE_REPORT: report,
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure?.status, failure?.stderr).toBe(1);
      expect(failure.stderr).toContain(
        'The first desktop process exited during native startup',
      );
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({
        visible: true,
      });
    } finally {
      await removeTestProfile(work);
    }
  },
  45_000,
);
