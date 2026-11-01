import { setTimeout as delay } from 'node:timers/promises';

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

export async function waitForDesktopStartup(
  child,
  { readLogs, readStages, timeoutMs = 15_000, observationMs = 30_000 },
) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let logs = '';
  const failure = (reason, followUp = '') =>
    Object.assign(new Error(reason), { startupLogs: logs, followUp });
  while (performance.now() < deadline) {
    logs = readLogs();
    if (exited(child)) {
      // Exit can precede the last data event on inherited output pipes.
      if (
        [child.stdout, child.stderr].every(
          (stream) => !stream || stream.readableEnded,
        )
      )
        throw failure('The first desktop process exited during native startup');
    } else if (logs.length > 0) {
      return logs;
    }
    await delay(Math.min(100, Math.max(0, deadline - performance.now())));
  }

  const stagesAtDeadline = readStages();
  const observationDeadline = performance.now() + observationMs;
  let observation = 'Application logging remained unavailable';
  // Observation explains a missed deadline; late logging must never pass startup.
  while (performance.now() < observationDeadline) {
    try {
      logs = readLogs();
    } catch (error) {
      observation = `Diagnostic log inspection failed: ${error.message}`;
      break;
    }
    if (logs.length > 0) {
      observation = `Application logging appeared after ${Math.round(performance.now() - started)}ms`;
      break;
    }
    if (exited(child)) {
      observation = 'The process exited during diagnostic observation';
      break;
    }
    await delay(
      Math.min(100, Math.max(0, observationDeadline - performance.now())),
    );
  }
  throw failure(
    'The first desktop process did not finish native startup',
    `Post-timeout observation: ${observation}\nStages at the original deadline:\n${stagesAtDeadline}`,
  );
}

export async function waitForProcessProbe(
  child,
  probe,
  { timeoutMs, description },
) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    if (exited(child)) {
      throw new Error(
        'The desktop process exited before its native window was ready',
      );
    }
    try {
      // Pass the remaining budget to the subprocess, not a fresh full timeout.
      return await probe(
        child.pid,
        Math.max(1, Math.ceil(deadline - performance.now())),
      );
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(100, Math.max(0, deadline - performance.now())));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(
    `${description} were not ready within ${timeoutMs}ms${detail}`,
    {
      cause: lastError,
    },
  );
}
