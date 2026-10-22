import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/website',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173/browser-recall/',
    channel: 'chromium',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run preview:website',
    url: 'http://127.0.0.1:4173/browser-recall/',
    reuseExistingServer: !process.env.CI,
  },
});
