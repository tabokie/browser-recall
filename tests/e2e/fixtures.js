import { test as base, chromium } from '@playwright/test';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function timer(label) {
  const t0 = performance.now();
  return () => console.log(`[timer] ${label}: ${(performance.now() - t0).toFixed(0)}ms`);
}

export const test = base.extend({
  extContext: [async ({}, use) => {
    let done = timer('browser launch');
    const extPath = path.join(__dirname, '../../extension');
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ],
    });
    done();
    await use(context);
    done = timer('browser teardown');
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    done();
  }, { scope: 'worker' }],

  extensionId: [async ({ extContext }, use) => {
    const done = timer('find service worker');
    let [sw] = extContext.serviceWorkers();
    if (!sw) sw = await extContext.waitForEvent('serviceworker');
    const id = sw.url().split('/')[2];
    done();
    await use(id);
  }, { scope: 'worker' }],

  setupDir: [async ({ extContext, extensionId }, use) => {
    let done = timer('setupDir: open helper page');
    const page = await extContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
    await page.waitForFunction(() => typeof chrome !== 'undefined' && chrome.runtime);
    done();

    done = timer('setupDir: setTestDirectory');
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'setTestDirectory' })
    );
    if (!result?.success) {
      throw new Error(`setTestDirectory failed: ${JSON.stringify(result)}`);
    }
    done();

    done = timer('setupDir: close helper page');
    await page.close();
    done();

    await use('opfs://portal-test');
  }, { scope: 'worker' }],

  // Local HTTP server serving custom pages for navigation/referrer tests.
  // Pages are registered via localServer.addPage(path, { title, body }).
  localServer: [async ({}, use) => {
    const pages = new Map();
    const server = http.createServer((req, res) => {
      const page = pages.get(req.url);
      if (!page) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Not Found</title></head><body>404</body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>${page.title}</title></head><body>${page.body}</body></html>`);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    await use({
      baseUrl,
      port,
      addPage(urlPath, { title, body }) { pages.set(urlPath, { title, body }); },
      url(urlPath) { return baseUrl + urlPath; },
    });
    server.close();
  }, { scope: 'worker' }],
});

export const expect = test.expect;
