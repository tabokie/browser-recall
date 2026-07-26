import { test as base, chromium } from '@playwright/test';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  cleanupTestExtensionDir,
  createTestExtensionDir,
} from '../fixtures/test-extension.mjs';
import {
  startDaemon,
  waitForDesktopConnector,
  waitForExtensionId,
} from '../../scripts/lib/desktop-test-runtime.mjs';

function timer(label) {
  const t0 = performance.now();
  return () =>
    console.log(`[timer] ${label}: ${(performance.now() - t0).toFixed(0)}ms`);
}

export const test = base.extend({
  daemon: [
    async ({}, use) => {
      const done = timer('daemon startup');
      const daemon = await startDaemon();
      done();
      try {
        await use(daemon);
      } finally {
        const stopDone = timer('daemon teardown');
        await daemon.stop();
        stopDone();
      }
    },
    { scope: 'worker' },
  ],

  extContext: [
    async ({ daemon }, use) => {
      void daemon;
      const extPath = createTestExtensionDir('browser-recall-test-extension-');
      const userDataDirs = [];

      async function launchAndVerify() {
        const done = timer('browser launch');
        const userDataDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'browser-recall-test-'),
        );
        userDataDirs.push(userDataDir);
        const ctx = await chromium.launchPersistentContext(userDataDir, {
          headless: false,
          args: [
            '--headless=new',
            `--disable-extensions-except=${extPath}`,
            `--load-extension=${extPath}`,
          ],
        });
        done();
        // Health check: load an extension page to verify browser + extension
        // are fully alive. A lightweight newPage() probe is insufficient —
        // Chrome can crash moments later when the extension service worker
        // and renderer interact.
        try {
          const extId = await waitForExtensionId(ctx);
          ctx._browserRecallExtensionId = extId;
          const probe = await ctx.newPage();
          await probe.goto(`chrome-extension://${extId}/test-helper.html`, {
            timeout: 5000,
          });
          await probe.waitForFunction(
            () => typeof chrome !== 'undefined' && chrome.runtime,
            { timeout: 5000 },
          );
          await probe.close();
        } catch (e) {
          await ctx.close().catch(() => {});
          throw e;
        }
        return ctx;
      }

      let context;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          context = await launchAndVerify();
          break;
        } catch (e) {
          console.warn(
            `[extContext] browser launch attempt ${attempt + 1} failed: ${e.message}`,
          );
          if (attempt >= 2) throw e;
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      await use(context);
      const done = timer('browser teardown');
      await context.close();
      cleanupTestExtensionDir(extPath);
      for (const dir of userDataDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      done();
    },
    { scope: 'worker' },
  ],

  extensionId: [
    async ({ extContext }, use) => {
      const done = timer('find service worker');
      const id =
        extContext._browserRecallExtensionId ||
        (await waitForExtensionId(extContext));
      done();
      await use(id);
    },
    { scope: 'worker' },
  ],

  setupDir: [
    async ({ daemon, extContext, extensionId }, use) => {
      const done = timer('setupDir: wait for desktop connector');
      await waitForDesktopConnector(extContext, extensionId, daemon.port);
      done();
      await use(daemon.dataDir);
    },
    { scope: 'worker' },
  ],

  // Local HTTP server serving custom pages for navigation/referrer tests.
  // Pages are registered via localServer.addPage(path, { title, body }).
  localServer: [
    async ({}, use) => {
      const pages = new Map();
      const server = http.createServer((req, res) => {
        const page = pages.get(req.url);
        if (!page) {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end(
            '<html><head><title>Not Found</title></head><body>404</body></html>',
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const titleTag =
          page.title != null ? `<title>${page.title}</title>` : '';
        const documentStart = `<!DOCTYPE html><html><head><meta charset="utf-8">${titleTag}</head><body>${page.body}`;
        if (page.endDelayMs) {
          res.write(documentStart);
          setTimeout(() => res.end('</body></html>'), page.endDelayMs);
        } else {
          res.end(`${documentStart}</body></html>`);
        }
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      await use({
        baseUrl,
        port,
        addPage(urlPath, { title, body, endDelayMs = 0 }) {
          pages.set(urlPath, { title, body, endDelayMs });
        },
        url(urlPath) {
          return baseUrl + urlPath;
        },
      });
      server.close();
    },
    { scope: 'worker' },
  ],
});

export const expect = test.expect;
