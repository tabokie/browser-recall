import { setTimeout as delay } from 'node:timers/promises';
import childProcess from 'node:child_process';
import { stopTestProcess } from './windows-desktop-process.mjs';

function macosGroupHasExited(pid, remainingMs) {
  if (process.platform !== 'darwin' || remainingMs <= 0) return false;
  const result = childProcess.spawnSync(
    '/bin/ps',
    ['-g', String(pid), '-o', 'stat='],
    {
      encoding: 'utf8',
      timeout: Math.ceil(remainingMs),
      killSignal: 'SIGKILL',
    },
  );
  if (result.error || ![0, 1].includes(result.status) || result.stderr.trim())
    return false;
  // macOS can retain defunct (Z) and exiting (E) processes while denying
  // even signal 0. These states cannot run browser work or be force-killed.
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((state) => state.startsWith('Z') || state.includes('E'));
}

export async function stopFirefoxProcess(child, { timeoutMs = 2000 } = {}) {
  if (!child?.pid) return;
  if (process.platform === 'win32') return stopTestProcess(child);
  const graceDeadline = performance.now() + timeoutMs;
  const deadline = graceDeadline + timeoutMs;
  // The detached launcher owns this process group. npx may exit before web-ext
  // or Firefox, so exitCode is not evidence that the browser has stopped.
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      if (
        error.code === 'EPERM' &&
        macosGroupHasExited(child.pid, deadline - performance.now())
      )
        return false;
      throw error;
    }
  };
  const waitForGroupExit = async () => {
    while (signalGroup(0)) {
      if (performance.now() >= graceDeadline) return false;
      await delay(25);
    }
    return true;
  };
  let onClose;
  const closed =
    (child.exitCode !== null || child.signalCode !== null) &&
    child.stdout.closed &&
    child.stderr.closed
      ? Promise.resolve()
      : new Promise((resolve) => {
          onClose = resolve;
          child.once('close', onClose);
        });
  let timer;
  try {
    if (signalGroup('SIGTERM') && !(await waitForGroupExit())) {
      signalGroup('SIGKILL');
    }
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Firefox process group did not close its output pipes before the cleanup deadline',
              ),
            ),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onClose) child.off('close', onClose);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
}
