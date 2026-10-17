import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function frameNativeUpdateWindow(
  helper,
  pid,
  { timeoutMs = 45_000 } = {},
) {
  // NSWorkspace can register the process before AppKit exposes its window.
  const deadline = performance.now() + timeoutMs;
  let lastError;
  do {
    try {
      execFileSync(helper, [String(pid), 'frame', '960', '620'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
      });
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(100, Math.max(0, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw new Error(
    `Native update window did not become ready: ${lastError.message}`,
    { cause: lastError },
  );
}
