import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/website',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173/browser-recall/',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { channel: 'chromium', viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        channel: 'chromium',
      },
    },
    {
      name: 'webkit-phone',
      use: { ...devices['iPhone 13'], browserName: 'webkit' },
    },
    {
      // Playwright cannot send native swipe or wheel input to mobile WebKit.
      // Exercise WebKit's real wheel chaining at the same phone viewport.
      name: 'webkit-scroll',
      testMatch: 'product-page.spec.js',
      grep: /scrolling over every product preview/,
      use: { browserName: 'webkit', viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: {
    command: 'npm run preview:website',
    url: 'http://127.0.0.1:4173/browser-recall/',
    reuseExistingServer: !process.env.CI,
  },
});
