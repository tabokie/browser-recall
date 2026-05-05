import { expect, test } from '@playwright/test';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { stageDesktopUiAssets } from '../../scripts/stage-app-assets.mjs';
import { listKey, pageKey } from '../../packages/core/entity-types.js';
import { generateSlugFromUrl } from '../../packages/core/utils.js';
import { VIRTUAL_SCROLLER_BUFFER } from '../../packages/core/virtual-scroller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '../..');
const desktopUiDir = path.join(repoRoot, 'dist/desktop-ui');
const VIRTUALIZED_ENTRY_COUNT = VIRTUAL_SCROLLER_BUFFER * 3 + 150;

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
  const deletedSnapshotUrl = 'https://example.com/deleted-snapshot';
  const deletedSnapshotSlug = generateSlugFromUrl(deletedSnapshotUrl);
  const settings = {
    colorScheme,
    historyFileBatch: options.historyFileBatch || 10,
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
  if (options.historyEntries) {
    base.session[`log:${todayKey()}`] = options.historyEntries;
  }
  if (options.historyEntriesByDate) {
    for (const [date, entries] of Object.entries(
      options.historyEntriesByDate,
    )) {
      base.session[`log:${date}`] = entries;
    }
  }
  if (options.extraSession) {
    Object.assign(base.session, options.extraSession);
  }
  if (options.includeRecycleBin) {
    base.session['manifest:orphaned'] = {
      timestamp: now,
      entries: [
        {
          key: 'note:deleted-note',
          url: 'https://example.com/deleted-note',
          deletedAt: now - 4000,
        },
        {
          key: 'note:replaced-note',
          url: 'https://example.com/replaced-note',
          deletedAt: now - 3000,
        },
        {
          key: 'list:deleted-list',
          deletedAt: now - 2000,
        },
        {
          key: `snapshot:${deletedSnapshotSlug}-${now - 1000}`,
          url: deletedSnapshotUrl,
          deletedAt: now - 1000,
        },
      ],
    };
    base.session['note:deleted-note'] = {
      slug: 'deleted-note',
      url: 'https://example.com/deleted-note',
      excerpt: 'Deleted highlight',
      note: 'Deleted note body',
      deleted: true,
      deletedTs: now - 4000,
    };
    base.session['note:replaced-note'] = {
      slug: 'replaced-note',
      url: 'https://example.com/replaced-note',
      excerpt: 'Replaced highlight',
      note: 'Replaced note body',
      deleted: true,
      deletedTs: now - 3000,
      deletionReason: 'replaced',
      replacedBy: 'note:new-note',
    };
    base.session['list:deleted-list'] = {
      slug: 'deleted-list',
      name: 'Deleted list',
      pins: [],
      deleted: true,
      deletedTs: now - 2000,
    };
    base.session[`page:${deletedSnapshotSlug}`] = {
      slug: deletedSnapshotSlug,
      url: deletedSnapshotUrl,
      title: 'Deleted snapshot page',
      parentIds: [],
      childIds: [],
      visitDates: [],
    };
  }
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
    ({
      seed,
      setupComplete,
      pairedBrowsers,
      deleteSnapshotFails,
      searchHistoryResults,
    }) => {
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

      function readDesktopValue(key) {
        // Desktop entity reads do not expose JSONL history logs. History must
        // go through listHistoryFiles/loadHistoryBatch, matching Tauri/daemon.
        if (key.startsWith('log:')) {
          return null;
        }
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

      function removeListFromTree(nodes = [], listId) {
        const listEntityId = `list:${listId}`;
        const next = [];
        for (const node of nodes) {
          if (node.id === listEntityId) continue;
          next.push({
            ...node,
            children: removeListFromTree(node.children || [], listId),
          });
        }
        return next;
      }

      function pageKeyForUrl(url) {
        for (const [key, value] of stores.session.entries()) {
          if (key.startsWith('page:') && value?.url === url) return key;
        }
        return null;
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
        recycleBinKeys() {
          return clone(stores.session.get('manifest:orphaned'))?.entries || [];
        },
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
              pendingCommands: 0,
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
          case 'searchHistory':
            return {
              success: true,
              results: clone(searchHistoryResults || []),
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
          case 'deleteSnapshot':
            if (deleteSnapshotFails) {
              return {
                success: false,
                error: 'delete failed in visual harness',
              };
            }
            stores.session.set(
              `detailSnapshots:${request.slug}`,
              (stores.session.get(`detailSnapshots:${request.slug}`) || [])
                .filter((snapshot) => snapshot.timestamp !== request.timestamp)
                .map(clone),
            );
            return { success: true };
          case 'permanentDeleteAll': {
            const orphaned = stores.session.get('manifest:orphaned') || {
              entries: [],
            };
            const deletedKeys = (orphaned.entries || []).map(
              (entry) => entry.key,
            );
            for (const key of deletedKeys) stores.session.delete(key);
            stores.session.set('manifest:orphaned', {
              timestamp: Date.now(),
              entries: [],
            });
            return { success: true, deletedKeys };
          }
          case 'getDirectorySize':
            return { success: true, size: 4096 };
          case 'readDesktopValue':
            return { success: true, value: readDesktopValue(request.key) };
          case 'saveSettingsKey': {
            const settings = readDesktopValue('manifest:settings') || {};
            settings[request.key] = request.value;
            stores.session.set('manifest:settings', settings);
            return { success: true };
          }
          case 'saveListMeta': {
            const listId = request.listId || request.slug;
            if (listId) {
              const key = `list:${listId}`;
              const entity = stores.session.get(key) || {
                slug: listId,
                pins: [],
              };
              stores.session.set(key, {
                ...entity,
                name: request.name || entity.name || listId,
              });
            } else if (request.name) {
              const slug = String(request.name)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
              const key = `list:${slug}`;
              stores.session.set(key, {
                slug,
                name: request.name,
                pins: [],
              });
              const order = stores.session.get('manifest:list-order') || {
                tree: [],
              };
              stores.session.set('manifest:list-order', {
                ...order,
                tree: [{ id: key, children: [] }, ...(order.tree || [])],
              });
              return { success: true, listId: slug };
            }
            return { success: true };
          }
          case 'deleteList': {
            const listId = request.listId || request.slug;
            const key = `list:${listId}`;
            const existing = stores.session.get(key) || {
              slug: listId,
              pins: [],
            };
            stores.session.set(key, {
              ...existing,
              deleted: true,
              deletedTs: Date.now(),
            });
            const order = stores.session.get('manifest:list-order') || {
              tree: [],
            };
            stores.session.set('manifest:list-order', {
              ...order,
              tree: removeListFromTree(order.tree || [], listId),
            });
            const orphaned = stores.session.get('manifest:orphaned') || {
              timestamp: 0,
              entries: [],
            };
            stores.session.set('manifest:orphaned', {
              timestamp: Date.now(),
              entries: [
                ...(orphaned.entries || []).filter(
                  (entry) => entry.key !== key,
                ),
                { key, deletedAt: Date.now() },
              ],
            });
            return { success: true };
          }
          case 'toggleListPin': {
            const listId = request.listId;
            const url = request.url;
            const pinId = url ? pageKeyForUrl(url) : null;
            if (!listId || !pinId) return { success: true };
            const key = `list:${listId}`;
            const entity = stores.session.get(key) || {
              slug: listId,
              name: listId,
              pins: [],
            };
            const pins = entity.pins || [];
            stores.session.set(key, {
              ...entity,
              pins: pins.some((pin) => pin.id === pinId)
                ? pins.filter((pin) => pin.id !== pinId)
                : [...pins, { id: pinId, pinnedAt: Date.now() }],
            });
            return { success: true };
          }
          case 'addListPins': {
            const listId = request.listId;
            if (!listId) return { success: true };
            const key = `list:${listId}`;
            const entity = stores.session.get(key) || {
              slug: listId,
              name: listId,
              pins: [],
            };
            const pins = [...(entity.pins || [])];
            for (const url of request.urls || []) {
              const pinId = pageKeyForUrl(url);
              if (!pinId) continue;
              if (!pins.some((pin) => pin.id === pinId)) {
                pins.push({ id: pinId, pinnedAt: Date.now() });
              }
            }
            stores.session.set(key, { ...entity, pins });
            return { success: true };
          }
          case 'updateListTree':
            stores.session.set('manifest:list-order', {
              timestamp: Date.now(),
              tree: clone(request.tree || []),
            });
            return { success: true };
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
      deleteSnapshotFails: Boolean(options.deleteSnapshotFails),
      searchHistoryResults: options.searchHistoryResults || [],
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
      await row.locator('.att-ctrl').hover();
      const actionSpacing = await row.evaluate((rowEl) => {
        const button = rowEl.querySelector('.att-ctrl-btn');
        const icon = rowEl.querySelector('.att-ctrl-icon');
        const dot = rowEl.querySelector('.att-ctrl-dot');
        const time = rowEl.querySelector('.result-time');
        const item = rowEl.closest('.result-item');
        const title = rowEl.querySelector('.result-title');
        const itemRect = item.getBoundingClientRect();
        const titleRect = title.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        const dotRect = dot.getBoundingClientRect();
        const timeRect = time.getBoundingClientRect();
        const dotStyle = getComputedStyle(dot);
        const iconStyle = getComputedStyle(icon);
        const controlRect = button.parentElement.getBoundingClientRect();
        return {
          leftInset: titleRect.left - itemRect.left,
          rightInset: itemRect.right - buttonRect.right,
          timeGap: buttonRect.left - timeRect.right,
          centerOffset: Math.abs(
            buttonRect.left +
              buttonRect.width / 2 -
              (controlRect.left + controlRect.width / 2),
          ),
          iconDotCenterOffset: Math.hypot(
            iconRect.left +
              iconRect.width / 2 -
              (dotRect.left + dotRect.width / 2),
            iconRect.top +
              iconRect.height / 2 -
              (dotRect.top + dotRect.height / 2),
          ),
          buttonWidth: buttonRect.width,
          sameColor: iconStyle.color === dotStyle.backgroundColor,
          iconFontSize: parseFloat(iconStyle.fontSize),
          iconText: icon.textContent,
        };
      });
      expect(
        Math.abs(actionSpacing.rightInset - actionSpacing.leftInset),
      ).toBeLessThanOrEqual(2);
      expect(actionSpacing.timeGap).toBeGreaterThanOrEqual(4);
      expect(actionSpacing.centerOffset).toBeLessThanOrEqual(1);
      expect(actionSpacing.iconDotCenterOffset).toBeLessThanOrEqual(1);
      expect(actionSpacing.buttonWidth).toBeLessThanOrEqual(18);
      expect(actionSpacing.sameColor).toBe(true);
      expect(actionSpacing.iconFontSize).toBeGreaterThanOrEqual(19);
      expect(actionSpacing.iconText).toBe('⋯');
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

  test('page detail keeps snapshot visible when backend delete fails', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeDetailListMembership: true,
        deleteSnapshotFails: true,
      });

      const row = page.locator(
        '.result-row[data-url="https://example.com/product-research"]',
      );
      await row.hover();
      await row.locator('.att-ctrl-btn').click({ force: true });

      const snapshotRow = page.locator('.detail-snapshot-row');
      await expect(snapshotRow).toBeVisible();
      await page.locator('.detail-snapshot-delete').click();

      await expect(snapshotRow).toBeVisible();
    });
  });

  test('recycle bin count matches the restorable item list', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeRecycleBin: true,
      });

      await expect(page.locator('#recycleBinCount')).toHaveText('3');
      await page.locator('#recycleBinBtn').click();

      await expect(page.locator('.recycle-card')).toHaveCount(3);
      await expect(page.locator('.recycle-card-key')).toHaveText([
        'note:deleted-note',
        'list:deleted-list',
        /^snapshot:/,
      ]);
      await expect(page.getByText('note:replaced-note')).toHaveCount(0);
      await expect(page.locator('#recycleBinCount')).toHaveText('3');
    });
  });

  test('empty recycle bin immediately clears the count and rendered list', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeRecycleBin: true,
      });

      await page.locator('#recycleBinBtn').click();
      await expect(page.locator('.recycle-card')).toHaveCount(3);
      await expect(page.locator('#recycleBinCount')).toHaveText('3');

      await page.locator('.empty-bin-btn').click();

      await expect(page.locator('.recycle-card')).toHaveCount(0);
      await expect(page.locator('#recycleBinEmpty')).toBeVisible();
      await expect(page.locator('#recycleBinCount')).toHaveText('');
      await expect(page.locator('#recycleBinBtn')).toBeHidden();
      await expect
        .poll(() =>
          page.evaluate(() => window.__desktopVisualHarness.recycleBinKeys()),
        )
        .toEqual([]);
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

  test('default blacklist includes browser-internal URL schemes', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
      });

      await page.locator('#settingsBtn').click();
      await expect(page.locator('#blacklistEntries')).toContainText(
        'chrome://',
      );
      await expect(page.locator('#blacklistEntries')).toContainText('about:');
    });
  });

  test('single-clicking a list title enters rename mode', async ({ page }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
      });

      await page.locator('.sidebar-item[data-list-id="research"]').click();
      await expect(page.locator('#mainTitle')).toHaveText('Research');
      await page.locator('#mainTitle').click();

      await expect(page.locator('#mainTitleInput')).toBeVisible();
      await expect(page.locator('#mainTitleInput')).toBeFocused();
    });
  });

  test('device filter applies to daemon search results enriched from page entities', async ({
    page,
  }) => {
    const now = Date.now();
    const deviceAUrl = 'https://example.com/daemon-device-a';
    const deviceBUrl = 'https://example.com/daemon-device-b';
    const deviceASlug = generateSlugFromUrl(deviceAUrl);
    const deviceBSlug = generateSlugFromUrl(deviceBUrl);
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [
          {
            url: 'https://example.com/local-device-marker',
            title: 'Local marker',
            timestamp: now - 30_000,
            deviceId: 'device-a',
          },
          {
            url: 'https://example.com/remote-device-marker',
            title: 'Remote marker',
            timestamp: now - 20_000,
            deviceId: 'device-b',
          },
        ],
        extraSession: {
          [pageKey(deviceASlug)]: {
            slug: deviceASlug,
            url: deviceAUrl,
            title: 'Needle daemon A',
            timestamps: { 'device-a': now - 10_000 },
          },
          [pageKey(deviceBSlug)]: {
            slug: deviceBSlug,
            url: deviceBUrl,
            title: 'Needle daemon B',
            timestamps: { 'device-b': now - 5_000 },
          },
        },
        searchHistoryResults: [
          {
            url: deviceAUrl,
            title: 'Needle daemon A',
            timestamp: now - 10_000,
            score: 2,
          },
          {
            url: deviceBUrl,
            title: 'Needle daemon B',
            timestamp: now - 5_000,
            score: 2,
          },
        ],
      });

      await page.locator('#searchDraftInput').fill('needle');
      await expect(page.getByText('Needle daemon A')).toBeVisible();
      await expect(page.getByText('Needle daemon B')).toBeVisible();

      await page.locator('#filterToggleBtn').click();
      await page.locator('.filter-bubble[data-device-id="device-a"]').click();

      await expect(page.getByText('Needle daemon A')).toBeVisible();
      await expect(page.getByText('Needle daemon B')).toHaveCount(0);
    });
  });

  test('equal relevance search results sort by most recent visit first', async ({
    page,
  }) => {
    const now = Date.now();
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [
          {
            url: 'https://example.com/needle-older',
            title: 'needle older',
            timestamp: now - 60_000,
            deviceId: 'device-a',
          },
          {
            url: 'https://example.com/needle-newer',
            title: 'needle newer',
            timestamp: now - 5_000,
            deviceId: 'device-a',
          },
        ],
      });

      await page.locator('#searchDraftInput').fill('"needle"');
      await expect(page.locator('.result-row')).toHaveCount(2);
      const titles = await page
        .locator('.result-row .result-title')
        .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
      expect(titles).toEqual(['needle newer', 'needle older']);
    });
  });

  test('large virtualized list remains stable after scrolling to the end', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from(
      { length: VIRTUALIZED_ENTRY_COUNT },
      (_, i) => ({
        url: `https://example.com/scroll-stability-${i}`,
        title: `Scroll stability ${i}`,
        timestamp: now - i * 1000,
        deviceId: 'device-a',
      }),
    );
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyFileBatch: 1,
        historyEntries,
      });

      const samples = await page.evaluate(async () => {
        const scrollEl = document.querySelector('.main');
        const values = [];
        scrollEl.scrollTop = scrollEl.scrollHeight;
        const started = performance.now();
        while (performance.now() - started < 700) {
          values.push(scrollEl.scrollTop);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return values;
      });
      const tail = samples.slice(-12);
      const spread = Math.max(...tail) - Math.min(...tail);
      expect(spread).toBeLessThanOrEqual(1);
    });
  });

  test('fresh explore render starts at the top of a virtualized list', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from(
      { length: VIRTUALIZED_ENTRY_COUNT },
      (_, i) => ({
        url: `https://example.com/fresh-top-${i}`,
        title: `Fresh top ${i}`,
        timestamp: now - i * 1000,
        deviceId: 'device-a',
      }),
    );
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyFileBatch: 1,
        historyEntries,
      });

      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length > 0,
      );
      const state = await page.evaluate(() => {
        const main = document.querySelector('.main');
        const scroller =
          document.getElementById('relatedResults')._virtualScroller;
        return {
          scrollTop: main.scrollTop,
          paddingTop: getComputedStyle(
            document.getElementById('relatedResults'),
          ).paddingTop,
          range: scroller.renderedRange,
          firstTitle: document
            .querySelector('.result-row .result-title')
            ?.textContent?.trim(),
        };
      });
      expect(state).toMatchObject({
        scrollTop: 0,
        paddingTop: '0px',
        firstTitle: 'Fresh top 0',
      });
    });
  });

  test('initial virtualized explore batch does not demand-load until near bottom', async ({
    page,
  }) => {
    const now = Date.now();
    const dayMs = 86_400_000;
    const historyEntriesByDate = {};
    const totalDays = 3;
    const entriesPerDay = VIRTUAL_SCROLLER_BUFFER - 100;
    for (let day = 0; day < totalDays; day++) {
      const date = new Date(now - day * dayMs).toISOString().slice(0, 10);
      historyEntriesByDate[date] = Array.from(
        { length: entriesPerDay },
        (_, i) => ({
          url: `https://example.com/no-initial-drain-${day}-${i}`,
          title: `No initial drain ${day}-${i}`,
          timestamp: now - day * dayMs - i * 1000,
          deviceId: 'device-a',
        }),
      );
    }

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyFileBatch: 1,
        historyEntries: [],
        historyEntriesByDate,
      });

      await page.waitForFunction(
        ({ entriesPerDay }) =>
          document.getElementById('relatedResults')._virtualScroller?._fullData
            ?.length === entriesPerDay,
        { entriesPerDay },
      );
      await page.waitForTimeout(700);

      const loadedBeforeScroll = await page.evaluate(() => {
        return document.getElementById('relatedResults')._virtualScroller
          ._fullData.length;
      });
      expect(loadedBeforeScroll).toBe(entriesPerDay);

      await page.evaluate(async () => {
        const main = document.querySelector('.main');
        main.scrollTop = main.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      await page.waitForFunction(
        ({ entriesPerDay }) =>
          document.getElementById('relatedResults')._virtualScroller?._fullData
            ?.length > entriesPerDay,
        { entriesPerDay },
      );
    });
  });

  test('list view render starts at the top after previous scroll state', async ({
    page,
  }) => {
    const now = Date.now();
    const pins = [];
    const extraSession = {};
    for (let i = 0; i < VIRTUALIZED_ENTRY_COUNT; i++) {
      const url = `https://example.com/list-top-${i}`;
      const slug = generateSlugFromUrl(url);
      pins.push({ id: pageKey(slug), pinnedAt: now - i * 1000 });
      extraSession[pageKey(slug)] = {
        slug,
        url,
        title: `List top ${i}`,
        timestamps: { 'device-a': now - i * 1000 },
      };
    }
    extraSession[listKey('research')] = {
      slug: 'research',
      name: 'Research',
      pins,
    };

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        extraSession,
      });
      await page.evaluate(() => {
        const main = document.querySelector('.main');
        main.scrollTop = main.scrollHeight;
      });

      await page.locator('.sidebar-item[data-list-id="research"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length > 0,
      );
      const state = await page.evaluate(() => {
        const main = document.querySelector('.main');
        const scroller =
          document.getElementById('relatedResults')._virtualScroller;
        return {
          scrollTop: main.scrollTop,
          paddingTop: getComputedStyle(
            document.getElementById('relatedResults'),
          ).paddingTop,
          range: scroller.renderedRange,
          firstTitle: document
            .querySelector('.result-row .result-title')
            ?.textContent?.trim(),
        };
      });

      expect(state).toMatchObject({
        scrollTop: 0,
        paddingTop: '0px',
        firstTitle: 'List top 0',
      });
    });
  });

  test('diagonal wheel noise does not cancel native vertical scrolling', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 120 }, (_, i) => ({
      url: `https://example.com/wheel-noise-${i}`,
      title: `Wheel noise ${i}`,
      timestamp: now - i * 1000,
      deviceId: 'device-a',
    }));
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyFileBatch: 1,
        historyEntries,
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length > 0,
      );

      const defaultPrevented = await page.evaluate(() => {
        const target = document.querySelector('.result-row');
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaX: 0.8,
          deltaY: 24,
        });
        return !target.dispatchEvent(event);
      });

      expect(defaultPrevented).toBe(false);
    });
  });

  test('slow virtualized scrolling does not snap while measuring variable-height rows', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from(
      { length: VIRTUALIZED_ENTRY_COUNT },
      (_, i) => ({
        url: `https://example.com/slow-scroll-${i}`,
        title: `Slow scroll ${i}`,
        timestamp: now - i * 1000,
        deviceId: 'device-a',
        likes: i % 5 === 0 ? 1 : 0,
      }),
    );
    const extraSession = {};
    for (let i = 0; i < historyEntries.length; i++) {
      const entry = historyEntries[i];
      const slug = generateSlugFromUrl(entry.url);
      const childIds = [];
      if (i % 4 === 0) {
        const noteId = `note:slow-scroll-${i}`;
        childIds.push(noteId);
        extraSession[noteId] = {
          slug: `slow-scroll-${i}`,
          excerpt: 'highlighted text',
          text: 'highlighted text',
        };
      }
      if (i % 7 === 0) childIds.push(`snapshot:slow-scroll-${i}`);
      extraSession[pageKey(slug)] = {
        slug,
        url: entry.url,
        title: entry.title,
        childIds,
        parentIds: i % 3 === 0 ? [listKey('research')] : [],
        likes: i % 5 === 0 ? 1 : 0,
      };
    }

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyFileBatch: 1,
        historyEntries,
        extraSession,
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length > 0,
      );

      const metrics = await page.evaluate(
        async ({ buffer }) => {
          const scrollEl = document.querySelector('.main');
          const scroller =
            document.getElementById('relatedResults')._virtualScroller;
          const samples = [];
          let previousRows = null;
          let previousScrollTop = scrollEl.scrollTop;
          let maxCorrection = 0;
          let maxVisualShift = 0;
          let backwardCorrections = 0;
          scrollEl.scrollTop = 0;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const measuredItemHeight =
            document.querySelector('.result-item')?.getBoundingClientRect?.()
              .height || 0;
          const stepPx = Math.max(scroller.rowHeight || 0, measuredItemHeight);
          const scrollSteps = buffer + 80;
          for (let i = 0; i < scrollSteps; i++) {
            const target = scrollEl.scrollTop + stepPx;
            scrollEl.scrollTop = target;
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const actual = scrollEl.scrollTop;
            const correction = actual - target;
            samples.push(actual);
            maxCorrection = Math.max(maxCorrection, Math.abs(correction));
            if (correction < -1) backwardCorrections++;
            if (samples.length > 1) {
              const prev = samples[samples.length - 2];
              if (actual < prev - 1) backwardCorrections++;
            }
            const rows = new Map(
              [...document.querySelectorAll('.result-row[data-url]')].map(
                (row) => [
                  row.dataset.url,
                  row.closest('.result-item').getBoundingClientRect().top,
                ],
              ),
            );
            if (previousRows) {
              const scrollDelta = actual - previousScrollTop;
              for (const [url, previousTop] of previousRows) {
                if (!rows.has(url)) continue;
                const expectedTop = previousTop - scrollDelta;
                maxVisualShift = Math.max(
                  maxVisualShift,
                  Math.abs(rows.get(url) - expectedTop),
                );
              }
            }
            previousRows = rows;
            previousScrollTop = actual;
          }
          return {
            maxCorrection,
            maxVisualShift,
            backwardCorrections,
            rangeStart: scroller.renderedRange.start,
            samples,
          };
        },
        { buffer: VIRTUAL_SCROLLER_BUFFER },
      );

      expect(metrics.rangeStart).toBeGreaterThan(0);
      expect(metrics.backwardCorrections).toBe(0);
      expect(metrics.maxCorrection).toBeLessThanOrEqual(1);
      expect(metrics.maxVisualShift).toBeLessThanOrEqual(1);
    });
  });

  test('multi-batch virtualized explore can fully reveal the final row', async ({
    page,
  }) => {
    const now = Date.now();
    const dayMs = 86_400_000;
    const historyEntriesByDate = {};
    const totalDays = 8;
    const entriesPerDay = Math.ceil(VIRTUALIZED_ENTRY_COUNT / totalDays);
    for (let day = 0; day < totalDays; day++) {
      const date = new Date(now - day * dayMs).toISOString().slice(0, 10);
      historyEntriesByDate[date] = Array.from(
        { length: entriesPerDay },
        (_, i) => ({
          url: `https://example.com/end-reveal-${day}-${i}`,
          title: `End reveal ${day}-${i}`,
          timestamp: now - day * dayMs - i * 1000,
          deviceId: 'device-a',
        }),
      );
    }
    const lastDay = totalDays - 1;
    const lastEntry = entriesPerDay - 1;
    const lastTitle = `End reveal ${lastDay}-${lastEntry}`;
    const lastUrl = `https://example.com/end-reveal-${lastDay}-${lastEntry}`;
    const totalEntries = totalDays * entriesPerDay;

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyFileBatch: 1,
        historyEntries: [],
        historyEntriesByDate,
      });

      await page.waitForFunction(
        ({ totalEntries }) =>
          document.getElementById('relatedResults')._virtualScroller?._fullData
            ?.length > 0 &&
          document.getElementById('relatedResults')._virtualScroller?._fullData
            ?.length <= totalEntries,
        { totalEntries },
      );

      await page.evaluate(
        async ({ totalEntries }) => {
          const scrollEl = document.querySelector('.main');
          const scroller =
            document.getElementById('relatedResults')._virtualScroller;
          const deadline = performance.now() + 6000;
          while (
            performance.now() < deadline &&
            scroller._fullData.length < totalEntries
          ) {
            scrollEl.scrollTop = scrollEl.scrollHeight;
            await new Promise((resolve) => setTimeout(resolve, 80));
          }
          scrollEl.scrollTop = scrollEl.scrollHeight;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          scrollEl.scrollTop = scrollEl.scrollHeight;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        },
        { totalEntries },
      );

      await expect(page.getByText(lastTitle)).toBeVisible();
      const visibility = await page.evaluate(
        ({ lastUrl }) => {
          const row = [
            ...document.querySelectorAll('.result-row[data-url]'),
          ].find((row) => row.dataset.url === lastUrl);
          if (!row) return { found: false };
          const main = document.querySelector('.main');
          const rowRect = row.getBoundingClientRect();
          const mainRect = main.getBoundingClientRect();
          return {
            found: true,
            rowBottom: rowRect.bottom,
            mainBottom: mainRect.bottom,
          };
        },
        { lastUrl },
      );
      expect(visibility.found).toBe(true);
      expect(visibility.rowBottom).toBeLessThanOrEqual(
        visibility.mainBottom + 1,
      );
    });
  });

  test('command-click selection does not select text and selected pages drag together', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 8 }, (_, i) => ({
      url: `https://example.com/drag-selected-${i}`,
      title: `Drag selected ${i}`,
      timestamp: now - i * 1000,
      deviceId: 'device-a',
    }));

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries,
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length >= 2,
      );

      const rows = page.locator('.result-row');
      await rows.nth(0).click();

      const secondTitleBox = await rows
        .nth(1)
        .locator('.result-title')
        .boundingBox();
      expect(secondTitleBox).not.toBeNull();
      await page.keyboard.down('Meta');
      await page.mouse.move(
        secondTitleBox.x + 12,
        secondTitleBox.y + secondTitleBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.up('Meta');

      await expect(page.locator('.result-row.selected')).toHaveCount(2);
      await expect
        .poll(() => page.evaluate(() => getSelection()?.toString() || ''))
        .toBe('');

      const firstTitleBox = await rows
        .nth(0)
        .locator('.result-title')
        .boundingBox();
      expect(firstTitleBox).not.toBeNull();
      await page.mouse.move(
        firstTitleBox.x + 12,
        firstTitleBox.y + firstTitleBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        firstTitleBox.x + 120,
        firstTitleBox.y + firstTitleBox.height / 2 + 16,
        { steps: 8 },
      );
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => getSelection()?.toString() || ''))
        .toBe('');

      const dragPayload = await page.evaluate(() => {
        const row = document.querySelector('.result-row.selected');
        const data = new Map();
        const event = new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, 'dataTransfer', {
          value: {
            types: [],
            effectAllowed: '',
            setData(type, value) {
              data.set(type, value);
              if (!this.types.includes(type)) this.types.push(type);
            },
            getData(type) {
              return data.get(type) || '';
            },
          },
        });
        row.dispatchEvent(event);
        return JSON.parse(data.get('text/plain') || '{}');
      });

      expect(dragPayload.items.map((item) => item.url)).toEqual([
        'https://example.com/drag-selected-0',
        'https://example.com/drag-selected-1',
      ]);
    });
  });

  test('dragging a page from second-line badges does not select text', async ({
    page,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/drag-from-badge';
    const slug = generateSlugFromUrl(url);
    const historyEntries = [
      {
        url,
        title: 'Drag from badge',
        timestamp: now,
        deviceId: 'device-a',
      },
    ];
    const extraSession = {
      [pageKey(slug)]: {
        slug,
        url,
        title: 'Drag from badge',
        likes: 1,
        parentIds: [],
        childIds: [],
        visitDates: [],
      },
    };

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries,
        extraSession,
      });
      await expect(page.locator('.card-tag-liked')).toBeVisible();

      const badgeBox = await page.locator('.card-tag-liked').boundingBox();
      expect(badgeBox).not.toBeNull();
      await page.mouse.move(
        badgeBox.x + 4,
        badgeBox.y + badgeBox.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        badgeBox.x + 90,
        badgeBox.y + badgeBox.height / 2 + 10,
        { steps: 8 },
      );
      await page.mouse.up();
      await expect
        .poll(() => page.evaluate(() => getSelection()?.toString() || ''))
        .toBe('');

      const dragPayload = await page.evaluate(() => {
        const badge = document.querySelector('.card-tag-liked');
        const data = new Map();
        const event = new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, 'dataTransfer', {
          value: {
            types: [],
            effectAllowed: '',
            setData(type, value) {
              data.set(type, value);
              if (!this.types.includes(type)) this.types.push(type);
            },
            getData(type) {
              return data.get(type) || '';
            },
          },
        });
        badge.dispatchEvent(event);
        return JSON.parse(data.get('text/plain') || '{}');
      });

      expect(dragPayload.items).toEqual([
        {
          url: 'https://example.com/drag-from-badge',
          title: 'Drag from badge',
        },
      ]);
    });
  });

  test('highest time chart bar has vertical breathing room', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 12 }, (_, i) => ({
      url: `https://example.com/chart-peak-${i}`,
      title: `Chart peak ${i}`,
      timestamp: now - i * 1000,
      deviceId: 'device-a',
    }));

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries,
      });
      await expect(page.locator('#relatedChart.visible')).toBeVisible();

      const chartMetrics = await page.evaluate(() => {
        const bars = document.getElementById('relatedChartBars');
        const row = bars.querySelector('.chart-bars-row');
        const tallest = [...bars.querySelectorAll('.chart-bar')].reduce(
          (max, bar) => {
            return !max ||
              bar.getBoundingClientRect().height >
                max.getBoundingClientRect().height
              ? bar
              : max;
          },
          null,
        );
        const rowRect = row.getBoundingClientRect();
        const barRect = tallest.getBoundingClientRect();
        return {
          rowTop: rowRect.top,
          barTop: barRect.top,
        };
      });

      expect(chartMetrics.barTop).toBeGreaterThan(chartMetrics.rowTop);
    });
  });

  test('recycle bin updates immediately after deleting a list', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
      });

      await expect(page.locator('#recycleBinBtn')).toBeHidden();
      await page.locator('.sidebar-item[data-list-id="research"]').hover();
      await page
        .locator('.sidebar-item[data-list-id="research"] .remove-list')
        .click({ force: true });

      await expect(page.locator('#recycleBinBtn')).toBeVisible();
      await expect(page.locator('#recycleBinCount')).toHaveText('1');
      await page.locator('#recycleBinBtn').click();
      await expect(page.locator('.recycle-card-key')).toContainText(
        'list:research',
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness
              .recycleBinKeys()
              .map((entry) => entry.key),
          ),
        )
        .toEqual(['list:research']);
    });
  });

  test('sidebar auto-scrolls while dragging lists or pages near its edges', async ({
    page,
  }) => {
    const extraSession = {
      'manifest:list-order': { tree: [] },
    };
    for (let i = 0; i < 48; i++) {
      const slug = `overflow-${i}`;
      extraSession['manifest:list-order'].tree.push({
        id: listKey(slug),
        children: [],
      });
      extraSession[listKey(slug)] = {
        slug,
        name: `Overflow ${i}`,
        pins: [],
      };
    }

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        extraSession,
      });

      await page.waitForFunction(
        () => document.querySelectorAll('.sidebar-item').length >= 40,
      );

      const scrollDelta = await page.evaluate(async () => {
        const sidebar = document.querySelector('.sidebar-content');
        const target = document.querySelector(
          '.sidebar-item[data-list-id="overflow-1"]',
        );
        const rect = sidebar.getBoundingClientRect();
        const dispatchDragover = async ({ clientY, dataTransfer }) => {
          const event = new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 20,
            clientY,
          });
          Object.defineProperty(event, 'dataTransfer', {
            value: dataTransfer,
          });
          target.dispatchEvent(event);
          await new Promise((resolve) => setTimeout(resolve, 250));
        };
        const listTransfer = {
          types: ['application/x-list-reorder'],
          dropEffect: '',
          getData() {
            return 'overflow-0';
          },
          setData() {},
        };
        const pageTransfer = {
          types: ['text/plain'],
          dropEffect: '',
          getData(type) {
            if (type === 'text/plain') {
              return JSON.stringify({
                items: [
                  {
                    url: 'https://example.com/sidebar-page-drag',
                    title: 'Sidebar page drag',
                  },
                ],
              });
            }
            return '';
          },
          setData() {},
        };

        sidebar.scrollTop = 0;
        await dispatchDragover({
          clientY: rect.bottom - 2,
          dataTransfer: listTransfer,
        });
        const afterDown = sidebar.scrollTop;

        sidebar.scrollTop = sidebar.scrollHeight;
        await dispatchDragover({
          clientY: rect.top + 2,
          dataTransfer: listTransfer,
        });
        const afterUp =
          sidebar.scrollHeight - sidebar.clientHeight - sidebar.scrollTop;

        sidebar.scrollTop = 0;
        await dispatchDragover({
          clientY: rect.bottom - 2,
          dataTransfer: pageTransfer,
        });
        const pageDown = sidebar.scrollTop;

        sidebar.scrollTop = 0;
        target.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 20,
            clientY: rect.bottom - 2,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        const beforeDragEnd = sidebar.scrollTop;
        target.dispatchEvent(
          new DragEvent('dragend', {
            bubbles: false,
            cancelable: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 120));
        const afterDragEnd = sidebar.scrollTop;

        return {
          down: afterDown,
          up: afterUp,
          pageDown,
          dragEndDelta: afterDragEnd - beforeDragEnd,
        };
      });

      expect(scrollDelta.down).toBeGreaterThan(0);
      expect(scrollDelta.up).toBeGreaterThan(0);
      expect(scrollDelta.pageDown).toBeGreaterThan(0);
      expect(scrollDelta.dragEndDelta).toBeLessThanOrEqual(1);
    });
  });

  test('keyword rule preview checks recent visits from desktop history', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = [
      {
        url: 'https://example.com/rule-preview-match',
        title: 'Rule preview needle',
        timestamp: now,
        deviceId: 'device-a',
      },
    ];

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries,
      });

      await page.locator('.sidebar-item[data-list-id="research"]').click();
      await page.locator('#inboxToggleBtn').click();
      await page.locator('#rulesAddBtn').click();
      await page.locator('.rule-edit-input').fill('needle');
      await page.locator('.rule-preview-btn').click();

      await expect(page.locator('#rulesPreviewList')).toContainText(
        'Rule preview needle',
      );
      await expect(
        page.getByText('No visits found to match against'),
      ).toHaveCount(0);
    });
  });

  test('deleting a pinned page preserves the list scroll position', async ({
    page,
  }) => {
    const now = Date.now();
    const pins = [];
    const extraSession = {};
    for (let i = 0; i < VIRTUALIZED_ENTRY_COUNT; i++) {
      const url = `https://example.com/delete-scroll-${i}`;
      const slug = generateSlugFromUrl(url);
      pins.push({ id: pageKey(slug), pinnedAt: now - i * 1000 });
      extraSession[pageKey(slug)] = {
        slug,
        url,
        title: `Delete scroll ${i}`,
        watermark: now - i * 1000,
      };
    }
    extraSession[listKey('research')] = {
      slug: 'research',
      name: 'Research',
      pins,
    };

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        extraSession,
      });

      await page.locator('.sidebar-item[data-list-id="research"]').click();
      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length > 0,
      );

      const before = await page.evaluate(async () => {
        const main = document.querySelector('.main');
        main.scrollTop = 1800;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return main.scrollTop;
      });
      await page.evaluate(async () => {
        const rows = [...document.querySelectorAll('.result-row')];
        rows[6].classList.add('selected');
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Delete',
          }),
        );
      });
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('.result-title')].some(
            (node) => node.textContent.trim() === 'Delete scroll 6',
          ),
      );

      const after = await page.evaluate(() => {
        const main = document.querySelector('.main');
        return {
          scrollTop: main.scrollTop,
          maxScroll: main.scrollHeight - main.clientHeight,
        };
      });
      expect(Math.abs(after.scrollTop - before)).toBeLessThanOrEqual(80);
      expect(after.scrollTop).toBeLessThan(after.maxScroll - 200);
    });
  });

  test('clearing a search query does not jump the results scroll to the end', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from(
      { length: VIRTUALIZED_ENTRY_COUNT },
      (_, i) => ({
        url: `https://example.com/search-clear-${i}`,
        title: `Search clear ${i}`,
        timestamp: now - i * 1000,
        deviceId: 'device-a',
      }),
    );

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries,
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length > 0,
      );

      await page.locator('#searchDraftInput').fill('Search clear');
      await page.waitForFunction(
        () =>
          Number(
            document.getElementById('relatedResults').dataset.searchCount || 0,
          ) > 0,
      );
      const before = await page.evaluate(async () => {
        const main = document.querySelector('.main');
        main.scrollTop = 1600;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return main.scrollTop;
      });
      await page.evaluate(() => {
        const input = document.getElementById('searchDraftInput');
        input.value = '';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
      await page.waitForFunction(
        () =>
          document.getElementById('relatedResults')._virtualScroller?._fullData
            ?.length > 0,
      );

      const after = await page.evaluate(() => {
        const main = document.querySelector('.main');
        return {
          scrollTop: main.scrollTop,
          maxScroll: main.scrollHeight - main.clientHeight,
        };
      });
      expect(Math.abs(after.scrollTop - before)).toBeLessThanOrEqual(120);
      expect(after.scrollTop).toBeLessThan(after.maxScroll - 200);
    });
  });
});
