import { defineConfig } from '@playwright/test';

const browserEngine = process.env.BROWSER_RECALL_PLAYWRIGHT_ENGINE;
if (browserEngine && browserEngine !== 'webkit') {
  throw new Error(
    `Unsupported BROWSER_RECALL_PLAYWRIGHT_ENGINE: ${browserEngine}`,
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  globalTimeout: 300000, // 5 min total — fail fast if tests are stuck
  retries: 0,
  workers: 1, // extensions require serial execution (one persistent context)
  use: {
    channel: browserEngine === 'webkit' ? undefined : 'chromium',
  },
});
