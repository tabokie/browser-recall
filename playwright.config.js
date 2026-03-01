import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  workers: 1, // extensions require serial execution (one persistent context)
  use: {
    channel: 'chromium',
  },
});
