import { setTimeout as delay } from 'node:timers/promises';
import { stopTestProcess } from './windows-desktop-process.mjs';

export async function stopFirefoxProcess(child, { timeoutMs = 2000 } = {}) {
  if (!child?.pid) return;
  if (process.platform === 'win32') return stopTestProcess(child);
  // The detached launcher owns this process group. npx may exit before web-ext
  // or Firefox, so exitCode is not evidence that the browser has stopped.
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
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
    if (signalGroup('SIGTERM')) {
      const deadline = performance.now() + timeoutMs;
      while (signalGroup(0) && performance.now() < deadline) await delay(25);
      signalGroup('SIGKILL');
    }
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Firefox process group did not close its output pipes after SIGKILL',
              ),
            ),
          2000,
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
