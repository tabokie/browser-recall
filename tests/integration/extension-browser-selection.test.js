import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

// Exercise explicit browser choices in real subprocesses so extension fixtures
// cannot silently fall back to Chromium or depend on installed branded browsers.
test.each(['msedge', 'chrome', 'webkit'])(
  'extension rendering rejects unsupported browser choices before launching: %s',
  (channel) => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        'tests/e2e/extension-font-fallback.spec.js',
        '--reporter=json',
        '--global-timeout=10000',
        '--output=test-results/extension-browser-selection/' + channel,
      ],
      {
        cwd: root,
        env: { ...process.env, BROWSER_RECALL_PLAYWRIGHT_ENGINE: channel },
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    const output = result.stdout + result.stderr;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain(
      `Extension browser checks do not support ${channel}; use pinned Chromium`,
    );
  },
  25000,
);
