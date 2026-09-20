#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') {
  throw new Error('Browser-window documentation capture requires macOS.');
}
const result = spawnSync(
  process.execPath,
  [
    'node_modules/@playwright/test/cli.js',
    'test',
    'tests/e2e/documentation-browser.spec.js',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      BROWSER_RECALL_DOCUMENTATION_NATIVE: '1',
      BROWSER_RECALL_DOCUMENTATION_OUTPUT: fileURLToPath(
        new URL('../docs/images/', import.meta.url),
      ),
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
