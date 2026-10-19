import { execFile, execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runTestProcess(
  file,
  args,
  { env, timeoutMs = 25_000 } = {},
) {
  const request = execFileAsync(file, args, {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
  request.child.stdin.end();
  request.child.stdout.pipe(process.stdout);
  request.child.stderr.pipe(process.stderr);
  const { stdout } = await request;
  return stdout;
}

export function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

export async function stopTestProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Terminate the tree while its parent still exists. Killing only the parent
  // first can orphan WebView2 processes and leave the profile locked.
  execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
  });
  await waitForExit(child, 5000);
}

export async function removeTestProfile(workDir, onRetry) {
  // Node 24's native rmSync path skips retries for Windows permission-denied
  // errors and cannot clear read-only files. The asynchronous rimraf path
  // handles read-only files. Own the bounded retry loop so tests can observe
  // a real failed removal before releasing a lock, without timing assumptions.
  const retryable = new Set([
    'EBUSY',
    'EMFILE',
    'ENFILE',
    'ENOTEMPTY',
    'EPERM',
  ]);
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(workDir, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      if (!retryable.has(error.code) || attempt === 20) throw error;
      await onRetry?.(error);
      await delay((attempt + 1) * 100);
    }
  }
}
