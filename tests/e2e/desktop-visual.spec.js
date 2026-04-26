import { expect, test } from '@playwright/test';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { stageDesktopUiAssets } from '../../scripts/stage-app-assets.mjs';
import { listKey, pageKey } from '../../packages/core/entity-types.js';
import { generateSlugFromUrl } from '../../packages/core/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '../..');
const desktopUiDir = path.join(repoRoot, 'dist/desktop-ui');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function desktopVisualSeed(colorScheme = 'amber', options = {}) {
  const now = Date.now();
  const productResearchUrl = 'https://example.com/product-research';
  const productResearchSlug = generateSlugFromUrl(productResearchUrl);
  const settings = {
    colorScheme,
    historyFileBatch: 10,
    captureSnapshotVideo: false,
    blacklistEnabled: true,
    titleCleanupEnabled: true,
    titleTrimRules: [],
    syncEnabled: false,
    syncRetentionDays: 7,
    syncRepoUrl: '',
  };
  const base = {
    session: {
      theme: 'light',
      colorScheme,
      'manifest:settings': settings,
      'manifest:list-order': {
        tree: [
          {
            id: 'list:research',
            children: [{ id: 'list:design', children: [] }],
          },
          { id: 'list:reading', children: [] },
        ],
      },
      'list:research': {
        slug: 'research',
        name: 'Research',
        pins: [],
      },
      'list:design': {
        slug: 'design',
        name: 'Design references',
        pins: [],
      },
      'list:reading': {
        slug: 'reading',
        name: 'Reading queue',
        pins: [],
      },
      [`log:${todayKey()}`]: [
        {
          url: 'https://example.com/product-research',
          title: 'Product research notes',
          timestamp: now - 60_000,
          duration: 180,
          likes: 1,
        },
        {
          url: 'https://example.com/design-system',
          title: 'Design system audit',
          timestamp: now - 120_000,
          duration: 95,
          likes: 0,
        },
        {
          url: 'https://example.com/release-checklist',
          title: 'Release checklist',
          timestamp: now - 180_000,
          duration: 45,
          likes: 0,
        },
      ],
      'searchQueries:explore': [],
    },
    local: {},
  };
  if (options.includeDetailListMembership) {
    const researchListKey = listKey('research');
    const productResearchPageKey = pageKey(productResearchSlug);
    return {
      ...base,
      session: {
        ...base.session,
        [productResearchPageKey]: {
          slug: productResearchSlug,
          url: productResearchUrl,
          title: 'Product research notes',
          parentIds: [researchListKey],
          childIds: [],
          visitDates: [],
        },
        [`detailNotes:${productResearchSlug}`]: [
          {
            slug: 'page-note-product-research',
            excerpt: null,
            note: 'Page note for product research',
          },
          {
            slug: 'highlight-product-research',
            excerpt: 'Important highlighted passage',
            note: 'Highlight note',
          },
        ],
        [`detailSnapshots:${productResearchSlug}`]: [
          {
            timestamp: now - 30_000,
            hasMd: true,
            hasHtml: true,
          },
        ],
      },
    };
  }
  return base;
}

async function serveDesktopUi(use) {
  stageDesktopUiAssets(desktopUiDir);
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(
      new URL(req.url, 'http://127.0.0.1').pathname,
    );
    const relativePath = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const resolved = path.resolve(desktopUiDir, relativePath);
    if (!resolved.startsWith(desktopUiDir + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type':
        MIME_TYPES[path.extname(resolved)] || 'application/octet-stream',
    });
    fs.createReadStream(resolved).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await use(`http://127.0.0.1:${server.address().port}/index.html`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function installDesktopBridgeMock(page, options = {}) {
  const seed = desktopVisualSeed(options.colorScheme || 'amber', options);
  await page.addInitScript(
    ({ seed, setupComplete, pairedBrowsers }) => {
      const listeners = new Map();
      const stores = {
        session: new Map(Object.entries(seed.session)),
        local: new Map(Object.entries(seed.local)),
      };

      function clone(value) {
        return value === undefined
          ? undefined
          : JSON.parse(JSON.stringify(value));
      }

      function storeFor(areaName) {
        return stores[areaName] || stores.session;
      }

      function storageGet(request = {}) {
        const store = storeFor(request.areaName);
        if (request.keys == null) {
          return Object.fromEntries(
            [...store.entries()].map(([key, value]) => [key, clone(value)]),
          );
        }
        return Object.fromEntries(
          request.keys
            .filter((key) => store.has(key))
            .map((key) => [key, clone(store.get(key))]),
        );
      }

      function storageSet(request = {}) {
        const store = storeFor(request.areaName);
        const changes = {};
        for (const [key, value] of Object.entries(request.items || {})) {
          changes[key] = {
            oldValue: clone(store.get(key)),
            newValue: clone(value),
          };
          store.set(key, clone(value));
        }
        return changes;
      }

      function storageRemove(request = {}) {
        const store = storeFor(request.areaName);
        const changes = {};
        for (const key of request.keys || []) {
          changes[key] = {
            oldValue: clone(store.get(key)),
            newValue: null,
          };
          store.delete(key);
        }
        return changes;
      }

      function storageClear(request = {}) {
        const store = storeFor(request.areaName);
        const changes = {};
        for (const [key, value] of store.entries()) {
          changes[key] = { oldValue: clone(value), newValue: null };
        }
        store.clear();
        return changes;
      }

      function readCacheable(key) {
        return clone(stores.session.get(key)) ?? null;
      }

      function historyFiles(includeSizes = false) {
        const files = [...stores.session.keys()]
          .filter((key) => key.startsWith('log:'))
          .map((key) => `${key.slice('log:'.length)}.jsonl`)
          .sort()
          .reverse();
        const sizes = {};
        if (includeSizes) {
          for (const file of files) {
            const date = file.replace(/\.jsonl$/, '');
            const entries = stores.session.get(`log:${date}`) || [];
            sizes[file] = JSON.stringify(entries).length;
          }
        }
        return { files, sizes };
      }

      function loadHistoryBatch(files = []) {
        const entries = [];
        for (const file of files) {
          const date = String(file).replace(/\.jsonl$/, '');
          const dayEntries = stores.session.get(`log:${date}`) || [];
          entries.push(...clone(dayEntries));
        }
        entries.sort((left, right) => {
          return (left.timestamp || 0) - (right.timestamp || 0);
        });
        return entries;
      }

      function emitRuntimeMessage(message) {
        for (const handler of listeners.get('bridge-runtime-message') || []) {
          handler({ payload: clone(message) });
        }
      }

      window.__desktopVisualHarness = {
        appendHistoryEntry(entry) {
          const date = new Date(entry.timestamp).toISOString().slice(0, 10);
          const key = `log:${date}`;
          const entries = stores.session.get(key) || [];
          entries.push(clone(entry));
          stores.session.set(key, entries);
        },
        emitRuntimeMessage,
      };

      async function bridgeAction(request = {}) {
        switch (request.action) {
          case 'getDeviceId':
            return {
              success: true,
              deviceId: setupComplete ? 'visual-device' : null,
              setupComplete,
            };
          case 'getDirectoryInfo':
            return {
              success: true,
              info: setupComplete
                ? { name: 'Visual Data', hasPermission: true }
                : null,
            };
          case 'getDesktopConnectorState':
            return {
              success: true,
              state: setupComplete ? 'connected' : 'setup_required',
              port: setupComplete ? 28471 : null,
              deviceId: setupComplete ? 'visual-device' : null,
              hasToken: setupComplete,
              pendingEvents: 0,
              pendingBytes: 0,
              refuseMode: false,
              lastError: null,
              lastErrorCode: null,
              lastDrainedAt: null,
              dataFolder: setupComplete ? '/tmp/browser-recall-visual' : null,
              daemonBufferDepth: 0,
            };
          case 'getDesktopShellState':
            return {
              success: true,
              loginItemSupported: true,
              launchAtLogin: true,
              debugLogging: false,
              setupComplete,
              dataDir: setupComplete ? '/tmp/browser-recall-visual' : '',
              pairedBrowsers,
            };
          case 'getSyncAuthState':
            return { success: true, hasToken: false, rememberToken: false };
          case 'listHistoryFiles':
            return {
              success: true,
              ...historyFiles(request.includeSizes),
            };
          case 'loadHistoryBatch':
            return {
              success: true,
              entries: loadHistoryBatch(request.files),
            };
          case 'loadPageNotes':
            return {
              success: true,
              notes:
                clone(stores.session.get(`detailNotes:${request.slug}`)) || [],
            };
          case 'listSnapshots':
            return {
              success: true,
              snapshots:
                clone(stores.session.get(`detailSnapshots:${request.slug}`)) ||
                [],
            };
          case 'getDirectorySize':
            return { success: true, size: 4096 };
          case 'readCacheable':
            return { success: true, value: readCacheable(request.key) };
          case 'saveSettingsKey': {
            const settings = readCacheable('manifest:settings') || {};
            settings[request.key] = request.value;
            stores.session.set('manifest:settings', settings);
            return { success: true };
          }
          case 'startWindowDrag':
          case 'openExternalUrl':
            return { success: true };
          default:
            return { success: true };
        }
      }

      window.__TAURI__ = {
        core: {
          async invoke(command, payload = {}) {
            if (command === 'bridge_action')
              return bridgeAction(payload.request);
            if (command === 'bridge_storage_get')
              return storageGet(payload.request);
            if (command === 'bridge_storage_set')
              return storageSet(payload.request);
            if (command === 'bridge_storage_remove')
              return storageRemove(payload.request);
            if (command === 'bridge_storage_clear')
              return storageClear(payload.request);
            if (command === 'bridge_storage_broadcast') return {};
            throw new Error(`Unhandled Tauri command: ${command}`);
          },
        },
        event: {
          async listen(eventName, handler) {
            const handlers = listeners.get(eventName) || [];
            handlers.push(handler);
            listeners.set(eventName, handlers);
            return () => {
              const next = (listeners.get(eventName) || []).filter(
                (candidate) => candidate !== handler,
              );
              listeners.set(eventName, next);
            };
          },
        },
      };
    },
    {
      seed,
      setupComplete: options.setupComplete ?? true,
      pairedBrowsers: options.pairedBrowsers || [],
    },
  );
}

async function openDesktopUi(page, desktopUrl, options = {}) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await installDesktopBridgeMock(page, options);
  await page.goto(desktopUrl);
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.evaluate(() => document.fonts?.ready);
}

test.describe('desktop visual regression', () => {
  test('first-run onboarding keeps the warm desktop visual language', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: false,
        colorScheme: 'amber',
      });
      await expect(page).toHaveScreenshot('desktop-onboarding-amber.png', {
        fullPage: true,
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      });
    });
  });

  test('main shell keeps rose styling and sidebar titlebar spacing', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'rose',
      });
      await expect(page).toHaveScreenshot('desktop-main-rose.png', {
        fullPage: true,
        animations: 'disabled',
        maxDiffPixelRatio: 0.01,
      });
    });
  });

  test('fullscreen shell keeps the same sidebar titlebar spacing', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
      });
      await expect(page.locator('.sidebar')).toHaveCSS('margin-top', '38px');
      await expect(page).toHaveScreenshot(
        'desktop-main-fullscreen-consistent-amber.png',
        {
          fullPage: true,
          animations: 'disabled',
          maxDiffPixelRatio: 0.01,
        },
      );
    });
  });

  test('explore updates when a history mutation appends to an existing day file', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
      });

      await expect(page.getByText('Product research notes')).toBeVisible();
      await expect(page.getByText('Live mutation visit')).toHaveCount(0);

      await page.evaluate(() => {
        window.__desktopVisualHarness.appendHistoryEntry({
          url: 'https://example.com/live-mutation-visit',
          title: 'Live mutation visit',
          timestamp: Date.now(),
          duration: 12,
          likes: 0,
        });
        window.__desktopVisualHarness.emitRuntimeMessage({
          action: 'mutation',
          type: 'history',
        });
      });

      await expect(page.getByText('Live mutation visit')).toBeVisible({
        timeout: 3000,
      });
    });
  });

  test('page detail shows list membership from page entity parents', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeDetailListMembership: true,
      });

      const row = page.locator(
        '.result-row[data-url="https://example.com/product-research"]',
      );
      await expect(row.getByText('Product research notes')).toBeVisible();
      await row.hover();
      await row.locator('.att-ctrl-btn').click({ force: true });

      await expect(page.locator('.page-detail-card')).toBeVisible();
      await expect(page.locator('.detail-list-tag')).toContainText('Research');
      await expect(page.locator('.detail-page-note-display')).toContainText(
        'Page note for product research',
      );
      await expect(page.locator('.detail-notes-section')).toContainText(
        'Important highlighted passage',
      );
      await expect(page.locator('.detail-snapshot-badge.html')).toHaveText(
        'HTML',
      );
      await expect(page.locator('.detail-snapshot-badge.html')).not.toHaveText(
        'Saved page',
      );

      const sectionOrder = await page.locator('.detail-extra').evaluate((el) =>
        [...el.querySelectorAll(':scope > .detail-section')]
          .map((section) => {
            if (section.querySelector('.detail-list-tag')) return 'lists';
            if (section.querySelector('.detail-page-note-wrap'))
              return 'page-note';
            if (section.classList.contains('detail-notes-section'))
              return 'highlights';
            if (section.querySelector('.detail-snapshots')) return 'snapshots';
            if (section.classList.contains('detail-visit-dates'))
              return 'visit-dates';
            return 'other';
          })
          .filter((name) =>
            ['lists', 'page-note', 'highlights', 'snapshots'].includes(name),
          ),
      );
      expect(sectionOrder).toEqual([
        'lists',
        'page-note',
        'highlights',
        'snapshots',
      ]);
    });
  });

  test('settings connection section shows only browsers active today', async ({
    page,
  }) => {
    const now = Date.now();
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        pairedBrowsers: [
          {
            browserId: 'active-brave',
            browserName: 'Brave',
            browserProfile: 'Default profile',
            extensionId: 'abcdefghijklmnop',
            approvedAt: now - 10 * 86400000,
            lastSeen: now - 60_000,
            connected: false,
          },
          {
            browserId: 'old-chrome',
            browserName: 'Chrome',
            browserProfile: 'Default profile',
            extensionId: 'abcdefghijklmnop',
            approvedAt: now - 10 * 86400000,
            lastSeen: now - 3 * 86400000,
            connected: false,
          },
        ],
      });

      await page.locator('#settingsBtn').click();
      await expect(page.getByText('Connection')).toBeVisible();
      await expect(page.getByText('Browsers active today')).toBeVisible();
      await expect(page.getByText('Brave', { exact: true })).toBeVisible();
      await expect(page.getByText('Google Chrome')).toHaveCount(0);
      await expect(page.getByText('Desktop Shell')).toHaveCount(0);
      await expect(page.locator('#storagePath')).toHaveText(
        '/tmp/browser-recall-visual',
      );
      await expect(page.locator('#storageDeviceName')).toHaveText(
        'Device visual-device',
      );
    });
  });
});
