import { spawnSync } from 'node:child_process';

export function replayStore({ steps, baseStore = {} }) {
  const result = spawnSync(
    'cargo',
    ['run', '-q', '-p', 'browser-recall-replay', '--bin', 'replay-tool'],
    {
      input: JSON.stringify({ steps, base_store: baseStore }),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `replay-tool failed: ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  return parsed.store || {};
}
