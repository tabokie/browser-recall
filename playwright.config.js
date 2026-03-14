import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  globalTimeout: 300000, // 5 min total — fail fast if tests are stuck
  retries: 0,
  workers: 1, // extensions require serial execution (one persistent context)
  use: {
    channel: 'chromium',
  },
});
