import { expect, test } from '@playwright/test';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { stageDesktopUiAssets } from '../../scripts/stage-app-assets.mjs';
import { listKey, pageKey } from '../../packages/core/entity-types.js';
import { generateSlugFromUrl } from '../../packages/core/utils.js';
import { VIRTUAL_SCROLLER_BUFFER } from '../../packages/core/virtual-scroller.js';
import { pickSeeded, seededRandom } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '../..');
const desktopUiDir = path.join(repoRoot, 'dist/desktop/ui');
const VIRTUALIZED_ENTRY_COUNT = VIRTUAL_SCROLLER_BUFFER * 3 + 150;
const DESKTOP_COMBO_SEED = 'desktop-combo-20260505-a';
const DESKTOP_RULE_PREVIEW_SEED = 'desktop-rule-preview-20260505-a';

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

function visitDateInt(dateKey) {
  return Number(dateKey.replaceAll('-', ''));
}

function desktopVisualSeed(colorScheme = 'amber', options = {}) {
  const now = Date.now();
  const productResearchUrl = 'https://example.com/product-research';
  const productResearchSlug = generateSlugFromUrl(productResearchUrl);
  const deletedSnapshotUrl = 'https://example.com/deleted-snapshot';
  const deletedSnapshotSlug = generateSlugFromUrl(deletedSnapshotUrl);
  const settings = {
    theme: 'light',
    colorScheme,
    localeOverride: options.localeOverride || 'system',
    historyFileBatch: options.historyFileBatch || 10,
    captureSnapshotVideo: false,
    blacklistEnabled: true,
    urlBlacklist: ['chrome://', 'edge://', 'about:'],
    titleCleanupEnabled: true,
    titleTrimRules: [],
    syncEnabled: false,
    syncMethod: 'github',
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
      'searchQueries:explore': '',
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
  if (options.logDevices) {
    base.session['manifest:log-devices'] = options.logDevices;
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
      excerpt: ['Deleted highlight'],
      note: 'Deleted note body',
      deleted: true,
      deletedTs: now - 4000,
    };
    base.session['note:replaced-note'] = {
      slug: 'replaced-note',
      url: 'https://example.com/replaced-note',
      excerpt: ['Replaced highlight'],
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
    return completeDesktopVisualPageFixtures(
      {
        ...base,
        session: {
          ...base.session,
          [productResearchPageKey]: {
            slug: productResearchSlug,
            url: productResearchUrl,
            title: 'Product research notes',
            parentIds: [researchListKey],
            childIds: [
              'note:page-note-product-research',
              'note:highlight-product-research',
              'note:highlight-product-research-array',
              `snapshot:${productResearchSlug}-${now - 30_000}`,
            ],
            timestamps: { 'test-device': now },
            createdAt: now,
            visitDates: [],
            scrollDepth: null,
            timeOnPage: null,
            user_title: null,
            likes: null,
          },
          [`detailNotes:${productResearchSlug}`]: [
            {
              slug: 'page-note-product-research',
              excerpt: null,
              note: 'Page note for product research',
              url: productResearchUrl,
            },
            {
              slug: 'highlight-product-research',
              excerpt: [
                'Important highlighted passage\nwith original line break',
              ],
              note: 'Highlight note',
              url: productResearchUrl,
            },
            {
              slug: 'highlight-product-research-array',
              excerpt: ['Array highlighted passage', 'with grouped line break'],
              note: 'Grouped highlight note',
              url: productResearchUrl,
            },
          ],
          'note:page-note-product-research': {
            slug: 'page-note-product-research',
            excerpt: null,
            cssPath: null,
            note: 'Page note for product research',
            url: productResearchUrl,
            deleted: false,
          },
          'note:highlight-product-research': {
            slug: 'highlight-product-research',
            excerpt: [
              'Important highlighted passage\nwith original line break',
            ],
            cssPath: [''],
            note: 'Highlight note',
            url: productResearchUrl,
            deleted: false,
          },
          'note:highlight-product-research-array': {
            slug: 'highlight-product-research-array',
            excerpt: ['Array highlighted passage', 'with grouped line break'],
            cssPath: ['', ''],
            note: 'Grouped highlight note',
            url: productResearchUrl,
            deleted: false,
          },
          [`detailSnapshots:${productResearchSlug}`]: [
            {
              timestamp: now - 30_000,
              hasMd: true,
              hasHtml: true,
            },
          ],
        },
      },
      now,
    );
  }
  return completeDesktopVisualPageFixtures(base, now);
}

function completeDesktopVisualPageFixtures(seed, now) {
  for (const [key, value] of Object.entries(seed.session)) {
    if (!key.startsWith('page:')) continue;
    const timestamps = value.timestamps || { 'test-device': now };
    seed.session[key] = {
      parentIds: [],
      childIds: [],
      timestamps,
      createdAt: Math.max(now, ...Object.values(timestamps)),
      visitDates: [],
      scrollDepth: null,
      timeOnPage: null,
      user_title: null,
      likes: null,
      ...value,
    };
  }
  return seed;
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
    const closed = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
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
      saveSettingsKeyFailureKey,
      searchHistoryResults,
      searchHistoryChunks,
      searchHistoryResultsByQuery,
      searchNotesResultsByQuery,
      searchSnapshotsResultsByQuery,
      listHistoryFilesDelayMs,
      loadHistoryBatchDelayMs,
      readDesktopValueDelayMs,
      initialRoute,
      systemLocale,
      previewRuleMatchesByPattern,
    }) => {
      if (initialRoute) window.__BR_STATE__ = { route: initialRoute };
      const listeners = new Map();
      const stores = {
        session: new Map(Object.entries(seed.session)),
        local: new Map(Object.entries(seed.local)),
      };
      const openedExternalUrls = [];
      const openedSnapshots = [];
      const cancelledHistorySearchIds = [];
      const searchHistoryInvocations = [];
      const loadHistoryBatchInvocations = [];
      const previewRuleInvocations = [];

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

      function getListDisplay(listId) {
        const list = readDesktopValue(`list:${listId}`);
        if (!list || list.deleted) return null;
        const pins = (list.pins || []).map((pin) => {
          const [prefix, ...slugParts] = String(pin.id || '').split(':');
          const slug = slugParts.join(':');
          const entity = readDesktopValue(pin.id);
          if (prefix === 'page' && entity) {
            return {
              kind: 'page',
              slug,
              pinnedAt: pin.pinnedAt,
              source: pin.source,
              url: entity.url || null,
              title: entity.title || null,
              userTitle: entity.user_title || null,
              isNote: false,
              hasSnapshots: (entity.childIds || []).some((id) =>
                id.startsWith('snapshot:'),
              ),
              hasHighlightNotes: (entity.childIds || [])
                .filter((id) => id.startsWith('note:'))
                .map(readDesktopValue)
                .some((note) => note && !note.deleted && note.excerpt != null),
              listSlugs: (entity.parentIds || [])
                .filter((id) => id.startsWith('list:'))
                .map((id) => id.slice('list:'.length)),
              scrollDepth: entity.scrollDepth,
              timeOnPage: entity.timeOnPage,
              likes: entity.likes,
              createdAt: entity.createdAt,
              visitDates: entity.visitDates || [],
              timestamps: entity.timestamps || {},
            };
          }
          if (prefix === 'note' && entity && !entity.deleted) {
            const title = Array.isArray(entity.excerpt)
              ? entity.excerpt
                  .map((part) => String(part || ''))
                  .filter(Boolean)
                  .join('\n')
              : '';
            return {
              kind: 'note',
              slug,
              pinnedAt: pin.pinnedAt,
              source: pin.source,
              url: entity.url || null,
              title: title || null,
              userTitle: null,
              isNote: true,
              hasSnapshots: false,
              hasHighlightNotes: true,
              listSlugs: [],
              excerpt: entity.excerpt,
              note: entity.note,
              visitDates: [],
              timestamps: {},
            };
          }
          return {
            kind: 'missing',
            slug,
            pinnedAt: pin.pinnedAt,
            source: pin.source,
            url: null,
            title: null,
            userTitle: null,
            isNote: false,
            hasSnapshots: false,
            hasHighlightNotes: false,
            listSlugs: [],
            visitDates: [],
            timestamps: {},
          };
        });
        return {
          slug: list.slug || listId,
          name: list.name || '',
          rules: list.rules || [],
          pins,
        };
      }

      function getPageContext(slugs) {
        return Object.fromEntries(
          (slugs || []).flatMap((slug) => {
            const page = readDesktopValue(`page:${slug}`);
            if (!page) return [];
            const notes = (page.childIds || [])
              .filter((id) => id.startsWith('note:'))
              .map(readDesktopValue)
              .filter((note) => note && !note.deleted);
            const lists = (page.parentIds || [])
              .filter((id) => id.startsWith('list:'))
              .map(readDesktopValue)
              .filter((list) => list && !list.deleted)
              .map((list) => ({ slug: list.slug, name: list.name || '' }));
            const {
              childIds: _children,
              parentIds: _parents,
              ...pageFields
            } = page;
            return [
              [
                slug,
                {
                  page: {
                    ...pageFields,
                    hasSnapshots: (page.childIds || []).some((id) =>
                      id.startsWith('snapshot:'),
                    ),
                  },
                  notes,
                  lists,
                },
              ],
            ];
          }),
        );
      }

      function getListTreeProjection() {
        const order = readDesktopValue('manifest:list-order')?.tree || [];
        function project(nodes) {
          return (nodes || []).flatMap((node) => {
            const list = readDesktopValue(node.id);
            if (!list || list.deleted) return [];
            return [
              {
                slug: list.slug,
                name: list.name || list.slug,
                children: project(node.children),
              },
            ];
          });
        }
        function projectOrder(nodes) {
          return (nodes || []).flatMap((node) => {
            const list = readDesktopValue(node.id);
            if (!list || list.deleted) return [];
            return [
              {
                slug: list.slug,
                children: projectOrder(node.children),
              },
            ];
          });
        }
        return { tree: project(order), order: projectOrder(order) };
      }

      function getRecycleBin() {
        const orphaned = readDesktopValue('manifest:orphaned');
        return (orphaned?.entries || []).flatMap((entry) => {
          const key = entry.key || '';
          if (key.startsWith('note:')) {
            const note = readDesktopValue(key);
            if (
              !note?.deleted ||
              note.deletionReason === 'replaced' ||
              note.replacedBy
            )
              return [];
            const excerpt = Array.isArray(note.excerpt)
              ? note.excerpt
                  .map((part) => String(part || ''))
                  .filter(Boolean)
                  .join('\n')
              : '';
            return [
              {
                key,
                kind: 'note',
                slug: key.slice(5),
                timestamp: note.deletedTs,
                url: note.url,
                title: excerpt || note.note || null,
              },
            ];
          }
          if (key.startsWith('list:')) {
            const list = readDesktopValue(key);
            if (!list?.deleted) return [];
            return [
              {
                key,
                kind: 'list',
                slug: key.slice(5),
                timestamp: list.deletedTs,
                url: entry.url,
                title: list.name || null,
              },
            ];
          }
          if (key.startsWith('snapshot:')) {
            const stem = key.slice(9);
            const dash = stem.lastIndexOf('-');
            const slug = dash >= 0 ? stem.slice(0, dash) : stem;
            const timestamp = dash >= 0 ? Number(stem.slice(dash + 1)) : null;
            const page = readDesktopValue(`page:${slug}`);
            return [
              {
                key,
                kind: 'snapshot',
                slug,
                timestamp,
                url: entry.url,
                title: page?.user_title || page?.title || null,
              },
            ];
          }
          return [
            { key, kind: 'unknown', slug: key, url: entry.url, title: null },
          ];
        });
      }

      function historyFiles(includeSizes = false) {
        const files = [...stores.session.keys()]
          .filter((key) => key.startsWith('log:'))
          .map((key) => `${key.slice('log:'.length)}.jsonl`)
          .sort()
          .reverse();
        const devices = new Set(
          stores.session.get('manifest:log-devices') || [],
        );
        const sizes = includeSizes ? {} : null;
        if (includeSizes) {
          for (const file of files) {
            const date = file.replace(/\.jsonl$/, '');
            const entries = stores.session.get(`log:${date}`) || [];
            sizes[file] = JSON.stringify(entries).length;
          }
        }
        for (const key of stores.session.keys()) {
          if (!key.startsWith('log:')) continue;
          const entries = stores.session.get(key) || [];
          for (const entry of entries) {
            if (entry.deviceId) devices.add(entry.deviceId);
          }
        }
        return { files, sizes, devices: [...devices].sort() };
      }

      function loadHistoryBatch(files = []) {
        const entries = [];
        for (const file of files) {
          const date = String(file).replace(/\.jsonl$/, '');
          const dayEntries = stores.session.get(`log:${date}`) || [];
          entries.push(
            ...clone(dayEntries).map((entry) => ({
              action: 'visit_page',
              deviceId: 'test-device',
              title: null,
              referrerUrl: null,
              ...entry,
            })),
          );
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

      function emitTauriEvent(eventName, payload) {
        for (const handler of listeners.get(eventName) || []) {
          handler({ payload: clone(payload) });
        }
      }

      const cancelledHistorySearches = new Set();

      function chunksForHistorySearch(query) {
        const keyed = searchHistoryResultsByQuery?.[query];
        const configured = keyed || searchHistoryChunks;
        if (configured) {
          return configured.map((chunk) =>
            Array.isArray(chunk) ? { delay: 0, results: chunk } : chunk,
          );
        }
        return [{ delay: 0, results: searchHistoryResults || [] }];
      }

      async function configuredSearchResults(resultsByQuery, query) {
        const configured = resultsByQuery?.[query] || [];
        if (Array.isArray(configured)) return clone(configured);
        if (configured.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, configured.delay));
        }
        return clone(configured.results || []);
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

      function putOrphanedEntry(key) {
        const orphaned = stores.session.get('manifest:orphaned') || {
          timestamp: 0,
          entries: [],
        };
        stores.session.set('manifest:orphaned', {
          timestamp: Date.now(),
          entries: [
            ...(orphaned.entries || []).filter((entry) => entry.key !== key),
            { key, deletedAt: Date.now() },
          ],
        });
      }

      function deleteNoteRecord(noteSlug) {
        const noteKey = `note:${noteSlug}`;
        const note = stores.session.get(noteKey);
        if (note) {
          stores.session.set(noteKey, {
            ...note,
            deleted: true,
            deletedTs: Date.now(),
          });
        }
        for (const [key, notes] of stores.session.entries()) {
          if (!key.startsWith('detailNotes:') || !Array.isArray(notes)) {
            continue;
          }
          stores.session.set(
            key,
            notes.filter((note) => note.slug !== noteSlug).map(clone),
          );
        }
        putOrphanedEntry(noteKey);
      }

      function emitMutation(type, detail = {}) {
        emitRuntimeMessage({ action: 'mutation', type, ...detail });
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
        openedExternalUrls() {
          return clone(openedExternalUrls);
        },
        openedSnapshots() {
          return clone(openedSnapshots);
        },
        cancelledHistorySearchIds() {
          return clone(cancelledHistorySearchIds);
        },
        searchHistoryInvocationCount() {
          return searchHistoryInvocations.length;
        },
        searchHistoryInvocations() {
          return clone(searchHistoryInvocations);
        },
        loadHistoryBatchInvocationCount() {
          return loadHistoryBatchInvocations.length;
        },
        previewRuleInvocations() {
          return clone(previewRuleInvocations);
        },
        sessionValue(key) {
          return clone(stores.session.get(key));
        },
        listenerCount(eventName) {
          return (listeners.get(eventName) || []).length;
        },
        updateSettingsExternally(items) {
          stores.session.set('manifest:settings', {
            ...(stores.session.get('manifest:settings') || {}),
            ...clone(items),
          });
          emitMutation('settings');
        },
        deleteNoteExternally(noteSlug) {
          deleteNoteRecord(noteSlug);
          emitMutation('note', { noteSlug });
          emitMutation('orphaned');
        },
      };

      async function bridgeAction(request = {}) {
        switch (request.action) {
          case 'getDesktopSystemLocale':
            return { success: true, locale: systemLocale };
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
              dataDir: setupComplete ? '/tmp/browser-recall-visual' : null,
              systemLocale,
              pairedBrowsers,
            };
          case 'getSyncAuthState':
            return { success: true, hasToken: false, rememberToken: false };
          case 'listHistoryFiles':
            if (listHistoryFilesDelayMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, listHistoryFilesDelayMs),
              );
            }
            return {
              success: true,
              ...historyFiles(request.includeSizes),
            };
          case 'loadHistoryBatch':
            loadHistoryBatchInvocations.push(clone(request.files || []));
            if (loadHistoryBatchDelayMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, loadHistoryBatchDelayMs),
              );
            }
            return {
              success: true,
              entries: loadHistoryBatch(request.files),
            };
          case 'searchNotes':
            return {
              success: true,
              results: await configuredSearchResults(
                searchNotesResultsByQuery,
                request.query,
              ),
            };
          case 'searchSnapshots':
            return {
              success: true,
              results: await configuredSearchResults(
                searchSnapshotsResultsByQuery,
                request.query,
              ),
            };
          case 'previewRule': {
            previewRuleInvocations.push(clone(request));
            const pattern = String(request.rule?.config?.pattern || '');
            const matchingUrls = new Set(
              previewRuleMatchesByPattern[pattern] || [],
            );
            return {
              success: true,
              results: (request.entries || []).map((entry) => ({
                url: entry.url,
                title: entry.title || '',
                match: matchingUrls.has(entry.url),
              })),
            };
          }
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
            putOrphanedEntry(`snapshot:${request.slug}-${request.timestamp}`);
            return { success: true };
          case 'deleteNote': {
            const noteSlug = request.noteSlug;
            deleteNoteRecord(noteSlug);
            return { success: true, noteSlug };
          }
          case 'openSnapshot':
            openedSnapshots.push({
              slug: request.slug,
              timestamp: request.timestamp,
            });
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
          case 'getListDisplay':
            if (readDesktopValueDelayMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, readDesktopValueDelayMs),
              );
            }
            return { success: true, list: getListDisplay(request.listId) };
          case 'getPageContext':
            return { success: true, pages: getPageContext(request.slugs) };
          case 'getAllPageContext': {
            const slugs = [...stores.session.keys()]
              .filter((key) => key.startsWith('page:'))
              .map((key) => key.slice('page:'.length));
            return { success: true, pages: getPageContext(slugs) };
          }
          case 'getListTree': {
            const projection = getListTreeProjection();
            return { success: true, ...projection };
          }
          case 'getRecycleBin':
            return { success: true, entries: getRecycleBin() };
          case 'getSettings':
            return {
              success: true,
              settings: readDesktopValue('manifest:settings'),
            };
          case 'saveSettingsKey': {
            if (request.key === saveSettingsKeyFailureKey) {
              return {
                success: false,
                error: `Could not persist ${request.key}`,
              };
            }
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
            putOrphanedEntry(key);
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
            function toEntityTree(nodes) {
              return (nodes || []).map((node) => ({
                id: `list:${node.slug}`,
                children: toEntityTree(node.children),
              }));
            }
            stores.session.set('manifest:list-order', {
              timestamp: Date.now(),
              tree: toEntityTree(request.tree),
            });
            return { success: true };
          case 'startWindowDrag':
          case 'openExternalUrl':
            if (request.action === 'openExternalUrl') {
              openedExternalUrls.push(request.url);
            }
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
            if (command === 'search_history_stream') {
              const request = payload.request || {};
              searchHistoryInvocations.push(clone(request));
              cancelledHistorySearches.delete(request.searchId);
              const chunks = chunksForHistorySearch(request.query);
              for (const [index, chunk] of chunks.entries()) {
                setTimeout(() => {
                  if (cancelledHistorySearches.has(request.searchId)) return;
                  emitTauriEvent('bridge-search-history', {
                    type: 'historySearchChunk',
                    searchId: request.searchId,
                    workerId: index,
                    results: chunk.results || [],
                  });
                  if (index === chunks.length - 1) {
                    emitTauriEvent('bridge-search-history', {
                      type: 'historySearchDone',
                      searchId: request.searchId,
                      success: true,
                      cancelled: false,
                      error: null,
                    });
                  }
                }, chunk.delay || 0);
              }
              if (chunks.length === 0) {
                setTimeout(() => {
                  emitTauriEvent('bridge-search-history', {
                    type: 'historySearchDone',
                    searchId: request.searchId,
                    success: true,
                    cancelled: false,
                    error: null,
                  });
                }, 0);
              }
              return { success: true, searchId: request.searchId };
            }
            if (command === 'cancel_history_search') {
              const request = payload.request || {};
              cancelledHistorySearchIds.push(request.searchId);
              cancelledHistorySearches.add(request.searchId);
              setTimeout(() => {
                emitTauriEvent('bridge-search-history', {
                  type: 'historySearchDone',
                  searchId: request.searchId,
                  success: false,
                  cancelled: true,
                  error: null,
                });
              }, 0);
              return { success: true, cancelled: true };
            }
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
      saveSettingsKeyFailureKey: options.saveSettingsKeyFailureKey || null,
      searchHistoryResults: options.searchHistoryResults || [],
      searchHistoryChunks: options.searchHistoryChunks || null,
      searchHistoryResultsByQuery: options.searchHistoryResultsByQuery || null,
      searchNotesResultsByQuery: options.searchNotesResultsByQuery || null,
      searchSnapshotsResultsByQuery:
        options.searchSnapshotsResultsByQuery || null,
      listHistoryFilesDelayMs: options.listHistoryFilesDelayMs || 0,
      loadHistoryBatchDelayMs: options.loadHistoryBatchDelayMs || 0,
      readDesktopValueDelayMs: options.readDesktopValueDelayMs || 0,
      initialRoute: options.initialRoute || '',
      systemLocale: options.systemLocale || 'en',
      previewRuleMatchesByPattern: options.previewRuleMatchesByPattern || {},
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

async function commitDesktopSearch(page, query) {
  const input = page.locator('#searchDraftInput');
  await input.fill(query);
  await input.press('Enter');
}

async function expectNoHistorySearchDuringVisibilityRefresh(
  page,
  expectedSearchCount,
  action,
) {
  const loadBatchCountBefore = await page.evaluate(() =>
    window.__desktopVisualHarness.loadHistoryBatchInvocationCount(),
  );
  await action();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__desktopVisualHarness.loadHistoryBatchInvocationCount(),
      ),
    )
    .toBeGreaterThan(loadBatchCountBefore);
  expect(
    await page.evaluate(() =>
      window.__desktopVisualHarness.searchHistoryInvocationCount(),
    ),
  ).toBe(expectedSearchCount);
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

  test('service error message can be selected and copied', async ({
    context,
    page,
  }) => {
    const errorMessage =
      '/Users/xyt/browser-data/logs/device/2026-02-10.jsonl: missing field `referrerUrl`';

    await serveDesktopUi(async (desktopUrl) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: new URL(desktopUrl).origin,
      });
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        extraSession: {
          serviceError: {
            code: 'daemon_start_failed',
            message: errorMessage,
          },
        },
      });

      const message = page.locator('#serviceErrorMessage');
      await expect(message).toHaveText(errorMessage);
      await message.click({ clickCount: 3 });
      await expect
        .poll(() =>
          page.evaluate(() => (getSelection()?.toString() || '').trim()),
        )
        .toBe(errorMessage);

      await page.keyboard.press('Meta+C');
      await expect
        .poll(() =>
          page.evaluate(async () =>
            (await navigator.clipboard.readText()).trim(),
          ),
        )
        .toBe(errorMessage);
    });
  });

  test('main shell and search panel render before initial history data finishes loading', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await page.setViewportSize({ width: 1280, height: 820 });
      await installDesktopBridgeMock(page, {
        setupComplete: true,
        colorScheme: 'amber',
        loadHistoryBatchDelayMs: 3000,
      });
      await page.goto(desktopUrl);

      await expect
        .poll(
          () =>
            page.evaluate(
              () => getComputedStyle(document.documentElement).opacity,
            ),
          { timeout: 1000 },
        )
        .toBe('1');
      await expect(page.locator('#searchDraftInput')).toBeVisible({
        timeout: 1000,
      });
      expect(
        await page.evaluate(() =>
          window.__desktopVisualHarness.loadHistoryBatchInvocationCount(),
        ),
      ).toBeGreaterThan(0);
    });
  });

  test('main shell and search panel render before daemon settings finish loading', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await page.setViewportSize({ width: 1280, height: 820 });
      await installDesktopBridgeMock(page, {
        setupComplete: true,
        colorScheme: 'amber',
        readDesktopValueDelayMs: 3000,
      });
      await page.goto(desktopUrl);

      await expect
        .poll(
          () =>
            page.evaluate(
              () => getComputedStyle(document.documentElement).opacity,
            ),
          { timeout: 1000 },
        )
        .toBe('1');
      await expect(page.locator('#searchDraftInput')).toBeVisible({
        timeout: 1000,
      });
    });
  });

  test('startup shell routes apply before initial history data finishes loading', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await page.setViewportSize({ width: 1280, height: 820 });
      await installDesktopBridgeMock(page, {
        setupComplete: true,
        colorScheme: 'amber',
        initialRoute: 'settings',
        loadHistoryBatchDelayMs: 3000,
      });
      await page.goto(desktopUrl);

      await expect(page.locator('#settingsModal.open')).toBeVisible({
        timeout: 1000,
      });
      expect(
        await page.evaluate(() =>
          window.__desktopVisualHarness.loadHistoryBatchInvocationCount(),
        ),
      ).toBeGreaterThan(0);
    });
  });

  test('failed settings writes surface the platform error and restore daemon state', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        initialRoute: 'settings',
        saveSettingsKeyFailureKey: 'captureSnapshotVideo',
      });

      const toggle = page.locator('#captureSnapshotVideo');
      await expect(toggle).not.toBeChecked();
      await toggle.locator('..').click();

      await expect(page.locator('#errorBubble')).toContainText(
        'Could not persist captureSnapshotVideo',
      );
      await expect(toggle).not.toBeChecked();
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness.sessionValue('manifest:settings'),
          ),
        )
        .toMatchObject({ captureSnapshotVideo: false });
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

  test(`seeded desktop workflow combines search, list filtering, and live mutation seed=${DESKTOP_COMBO_SEED}`, async ({
    page,
  }) => {
    const random = seededRandom(DESKTOP_COMBO_SEED);
    const now = Date.now();
    const nouns = ['Atlas', 'Beacon', 'Cinder', 'Drift', 'Ember', 'Fjord'];
    const verbs = ['audit', 'brief', 'index', 'map', 'review', 'trace'];
    const listName = `Research ${pickSeeded(random, nouns)}`;
    const historyEntries = Array.from({ length: 9 }, (_, index) => {
      const noun = pickSeeded(random, nouns);
      const verb = pickSeeded(random, verbs);
      return {
        url: `https://example.com/desktop-combo/${index}-${noun.toLowerCase()}-${verb}`,
        title: `${noun} combo ${verb} ${index}`,
        timestamp: now - index * 1000,
        duration: 20 + index,
        deviceId: index % 2 === 0 ? 'device-a' : 'device-b',
      };
    });
    const pinnedIndexes = new Set([1, 4, 7]);
    const pins = [];
    const extraSession = {};
    for (const [index, entry] of historyEntries.entries()) {
      const slug = generateSlugFromUrl(entry.url);
      const key = pageKey(slug);
      const pinned = pinnedIndexes.has(index);
      if (pinned) pins.push({ id: key, pinnedAt: now - index * 1000 });
      extraSession[key] = {
        slug,
        url: entry.url,
        title: entry.title,
        parentIds: pinned ? [listKey('research')] : [],
        childIds: [],
        visitDates: [visitDateInt(todayKey())],
        timestamps: { [entry.deviceId]: entry.timestamp },
      };
    }
    extraSession[listKey('research')] = {
      slug: 'research',
      name: listName,
      pins,
    };

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries,
        searchHistoryResults: historyEntries.map((entry) => ({
          url: entry.url,
          title: entry.title,
          timestamp: entry.timestamp,
          score: 1,
        })),
        extraSession,
      });

      await expect(page.locator('#mainTitle')).toHaveText('Explore');
      await commitDesktopSearch(page, 'combo');
      await expect
        .poll(() =>
          page.locator('#relatedResults').getAttribute('data-search-count'),
        )
        .toBe(String(historyEntries.length));
      await expect(
        page.locator(`.result-row[data-url="${historyEntries[0].url}"]`),
      ).toBeVisible();

      await page.locator('.sidebar-item[data-list-id="research"]').click();
      await expect(page.locator('#mainTitle')).toHaveText(listName);
      await expect(page.locator('#searchDraftInput')).toHaveAttribute(
        'placeholder',
        'Search...',
      );
      await page.locator('#searchDraftInput').fill(historyEntries[1].title);
      await expect(page.locator('#searchDraftClearBtn')).toBeVisible();
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);
      await page.locator('#searchDraftClearBtn').click();
      await expect(page.locator('#searchDraftInput')).toHaveValue('');
      for (const index of pinnedIndexes) {
        await expect(
          page.locator(`.result-row[data-url="${historyEntries[index].url}"]`),
        ).toBeVisible();
      }

      await page.locator('#searchDraftInput').fill(historyEntries[1].title);
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);
      await page.locator('#searchDraftInput').press('Escape');
      await expect(page.locator('#searchDraftInput')).toHaveValue('');
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.id === 'searchDraftInput',
          ),
        )
        .toBe(false);
      for (const index of pinnedIndexes) {
        await expect(
          page.locator(`.result-row[data-url="${historyEntries[index].url}"]`),
        ).toBeVisible();
      }

      await page.locator('#searchDraftInput').click();
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);
      await page
        .locator('#relatedResultsWrapper')
        .click({ position: { x: 20, y: 20 } });
      await expect(page.locator('#searchDraftInput')).toHaveValue('');
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.id === 'searchDraftInput',
          ),
        )
        .toBe(false);
      for (const index of pinnedIndexes) {
        await expect(
          page.locator(`.result-row[data-url="${historyEntries[index].url}"]`),
        ).toBeVisible();
      }

      await page.locator('#searchDraftInput').fill(historyEntries[1].title);
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);
      await page
        .locator('#relatedResultsWrapper')
        .click({ position: { x: 20, y: 20 } });
      await expect(page.locator('#searchDraftInput')).toHaveValue(
        historyEntries[1].title,
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.id === 'searchDraftInput',
          ),
        )
        .toBe(true);
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);
      await page.locator('#settingsBtn').click();
      await expect(page.locator('#searchDraftInput')).toHaveValue(
        historyEntries[1].title,
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.id === 'searchDraftInput',
          ),
        )
        .toBe(true);
      await expect(page.locator('#settingsModal.open')).toHaveCount(0);
      await expect(page.locator('#settingsModal')).toBeHidden();
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);

      await commitDesktopSearch(page, 'combo');
      for (const index of pinnedIndexes) {
        await expect(
          page.locator(`.result-row[data-url="${historyEntries[index].url}"]`),
        ).toBeVisible();
      }
      await expect(
        page.locator(`.result-row[data-url="${historyEntries[0].url}"]`),
      ).toHaveCount(0);

      const liveEntry = {
        url: 'https://example.com/desktop-combo/live-mutation',
        title: `${pickSeeded(random, nouns)} live-combo mutation`,
        timestamp: now + 1000,
        duration: 41,
        deviceId: 'device-a',
      };
      await page.locator('#exploreBtn').click();
      await expect(page.locator('#mainTitle')).toHaveText('Explore');
      await commitDesktopSearch(page, 'live-combo');
      await expect(
        page.locator(`.result-row[data-url="${liveEntry.url}"]`),
      ).toHaveCount(0);
      await page.evaluate((entry) => {
        window.__desktopVisualHarness.appendHistoryEntry(entry);
        window.__desktopVisualHarness.emitRuntimeMessage({
          action: 'mutation',
          type: 'history',
        });
      }, liveEntry);
      await expect(
        page.locator(`.result-row[data-url="${liveEntry.url}"]`),
      ).toBeVisible();
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
      const excerptStyles = await page
        .locator('.detail-note-excerpt')
        .evaluateAll((nodes) =>
          nodes.map((el) => ({
            text: el.textContent,
            whiteSpace: getComputedStyle(el).whiteSpace,
          })),
        );
      expect(excerptStyles).toEqual([
        {
          text: 'Important highlighted passage\nwith original line break',
          whiteSpace: 'pre-wrap',
        },
        {
          text: 'Array highlighted passage\nwith grouped line break',
          whiteSpace: 'pre-wrap',
        },
      ]);
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

  test('page detail URL opens through the desktop bridge', async ({ page }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeDetailListMembership: true,
      });

      const url = 'https://example.com/product-research';
      const row = page.locator(`.result-row[data-url="${url}"]`);
      await row.locator('.att-ctrl-btn').click({ force: true });

      const detailUrl = page.locator('.detail-url a');
      await expect(detailUrl).toHaveText(url);
      await expect(detailUrl).toHaveCSS('cursor', 'pointer');
      await detailUrl.click();

      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness.openedExternalUrls(),
          ),
        )
        .toEqual([url]);
    });
  });

  test('page detail snapshot opens on single click', async ({ page }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeDetailListMembership: true,
      });

      const row = page.locator(
        '.result-row[data-url="https://example.com/product-research"]',
      );
      await row.locator('.att-ctrl-btn').click({ force: true });

      const snapshotRow = page.locator('.detail-snapshot-row');
      await expect(snapshotRow).toBeVisible();
      await expect(snapshotRow).toHaveCSS('cursor', 'pointer');
      const snapshotRequest = await snapshotRow.evaluate((el) => {
        const section = el.closest('.detail-snapshots');
        return {
          slug: section.dataset.slug,
          timestamp: Number(el.dataset.ts),
        };
      });

      await snapshotRow.click();

      await expect
        .poll(() =>
          page.evaluate(() => window.__desktopVisualHarness.openedSnapshots()),
        )
        .toEqual([snapshotRequest]);
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

  test('recycle bin updates immediately after deleting a snapshot', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeDetailListMembership: true,
      });

      await expect(page.locator('#recycleBinBtn')).toBeHidden();
      const row = page.locator(
        '.result-row[data-url="https://example.com/product-research"]',
      );
      await row.locator('.att-ctrl-btn').click({ force: true });
      const snapshotRow = page.locator('.detail-snapshot-row');
      await expect(snapshotRow).toBeVisible();
      const snapshotKey = await snapshotRow.evaluate((el) => {
        const section = el.closest('.detail-snapshots');
        return `snapshot:${section.dataset.slug}-${el.dataset.ts}`;
      });

      await page.locator('.detail-snapshot-delete').click();

      await expect(page.locator('#recycleBinBtn')).toBeVisible();
      await expect(page.locator('#recycleBinCount')).toHaveText('1');
      await page.keyboard.press('Escape');
      await page.locator('#recycleBinBtn').click();
      await expect(page.locator('.recycle-card-key')).toHaveText(snapshotKey);
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness
              .recycleBinKeys()
              .map((entry) => entry.key),
          ),
        )
        .toEqual([snapshotKey]);
    });
  });

  test('recycle bin updates immediately after deleting a note', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeDetailListMembership: true,
      });

      await expect(page.locator('#recycleBinBtn')).toBeHidden();
      const row = page.locator(
        '.result-row[data-url="https://example.com/product-research"]',
      );
      await row.locator('.att-ctrl-btn').click({ force: true });

      const noteEntry = page
        .locator('.detail-note-entry')
        .filter({ hasText: 'Important highlighted passage' });
      await expect(noteEntry).toBeVisible();
      const noteKey = await noteEntry.evaluate(
        (el) => `note:${el.dataset.noteSlug}`,
      );

      await noteEntry.locator('.detail-note-action-btn.delete').click();

      await expect(page.locator('#recycleBinBtn')).toBeVisible();
      await expect(page.locator('#recycleBinCount')).toHaveText('1');
      await page.keyboard.press('Escape');
      await page.locator('#recycleBinBtn').click();
      await expect(page.locator('.recycle-card-key')).toHaveText(noteKey);
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness
              .recycleBinKeys()
              .map((entry) => entry.key),
          ),
        )
        .toEqual([noteKey]);
    });
  });

  test('recycle bin refreshes from daemon orphaned mutations', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeDetailListMembership: true,
      });

      await expect(page.locator('#recycleBinBtn')).toBeHidden();
      await page.evaluate(() =>
        window.__desktopVisualHarness.deleteNoteExternally(
          'highlight-product-research',
        ),
      );

      await expect(page.locator('#recycleBinBtn')).toBeVisible();
      await expect(page.locator('#recycleBinCount')).toHaveText('1');
      await page.locator('#recycleBinBtn').click();
      await expect(page.locator('.recycle-card-key')).toHaveText(
        'note:highlight-product-research',
      );

      await page.evaluate(() =>
        window.__desktopVisualHarness.deleteNoteExternally(
          'highlight-product-research-array',
        ),
      );

      await expect(page.locator('#recycleBinCount')).toHaveText('2');
      await expect(page.locator('.recycle-card-key')).toHaveText([
        'note:highlight-product-research',
        'note:highlight-product-research-array',
      ]);
    });
  });

  test('delayed recycle refresh does not reopen recycle bin after navigating away', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        includeRecycleBin: true,
        readDesktopValueDelayMs: 80,
      });

      await expect(page.locator('#recycleBinBtn')).toBeVisible();
      await page.locator('#recycleBinBtn').click();
      await expect(page.locator('#recycleBinLayout.visible')).toBeVisible();

      await page.evaluate(() =>
        window.__desktopVisualHarness.deleteNoteExternally('deleted-note'),
      );
      await page.locator('#exploreBtn').click();

      await expect(page.locator('#exploreBtn')).toHaveClass(/active/);
      await expect(page.locator('#recycleBinLayout.visible')).toHaveCount(0);
      await expect(page.locator('#relatedChart.visible')).toBeVisible();

      await page.waitForTimeout(160);
      await expect(page.locator('#exploreBtn')).toHaveClass(/active/);
      await expect(page.locator('#recycleBinLayout.visible')).toHaveCount(0);
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

  test('settings localizes help text, destructive action, and browser statuses', async ({
    page,
  }) => {
    const now = Date.now();
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        localeOverride: 'zh-CN',
        pairedBrowsers: [
          {
            browserId: 'connected-chrome',
            browserName: 'Chrome',
            browserProfile: '默认配置文件',
            extensionId: 'abcdefghijklmnop',
            approvedAt: now - 10 * 86400000,
            lastSeen: now - 60_000,
            connected: true,
          },
          {
            browserId: 'disconnected-brave',
            browserName: 'Brave',
            browserProfile: '默认配置文件',
            extensionId: 'abcdefghijklmnop',
            approvedAt: now - 10 * 86400000,
            lastSeen: now - 120_000,
            connected: false,
          },
        ],
      });

      await page.locator('#settingsBtn').click();

      await expect(
        page.locator('[data-i18n="desktopDataStorageHint"]'),
      ).toHaveText(
        '数据以按日期组织的人类可读 JSONL 文件形式存储在本地。可使用任何文本编辑器打开，或使用 jq 处理。',
      );
      await expect(
        page.locator('[data-i18n="desktopDeleteAllDataHint"]'),
      ).toHaveText(
        '删除 Browser Recall Desktop 数据文件夹中的所有文件。此操作无法撤销。',
      );
      await expect(
        page.locator('[data-i18n="desktopHistoryBatchSizeHint"]'),
      ).toHaveText(
        '滚动时一次加载的每日历史文件数量。较大的值会预先加载更多历史记录，但在大型数据集上可能感觉较慢。',
      );
      await expect(page.locator('#clearBtn')).toContainText('删除');
      await expect(page.locator('#launchAtLoginUnsupported')).toHaveText(
        '登录时启动仅适用于 macOS 13 或更高版本。',
      );
      await expect(page.locator('#syncAuthConnected')).toContainText('已连接');
      await expect(page.locator('#syncDisconnectBtn')).toHaveText('清除');
      await expect(page.locator('#syncPatSaveBtn')).toHaveText('连接');
      await expect(page.locator('#syncCheckDevicesBtn')).toHaveText('检查设备');
      await expect(page.locator('#syncNowBtn')).toHaveText('立即同步');
      await expect(page.locator('#syncCancelBtn')).toHaveText('取消');
      await expect(page.locator('#serviceErrorReloadBtn')).toHaveText(
        '重新加载',
      );
      await expect(page.locator('#serviceErrorResumeBtn')).toHaveText(
        '恢复服务',
      );
      await expect(
        page.locator('#onboardingLaunchAtLoginUnsupported'),
      ).toHaveText('登录时启动仅适用于 macOS 13 或更高版本。');
      await expect(page.locator('.paired-browser-status')).toHaveText([
        '· 已连接',
        '· 已断开',
      ]);
      await expect(
        page.locator('.paired-browser-profile').first(),
      ).toContainText('默认配置文件');
      await expect(page.locator('.paired-browser-revoke')).toHaveText([
        '撤销',
        '撤销',
      ]);
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

  test('settings mutation invalidates cached desktop settings', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
      });

      await page.evaluate(() => {
        window.__desktopVisualHarness.updateSettingsExternally({
          urlBlacklist: ['https://fresh-settings.example/'],
        });
      });
      await page.locator('#settingsBtn').click();

      await expect(page.locator('#blacklistEntries')).toContainText(
        'https://fresh-settings.example/',
      );
      await expect(page.locator('#blacklistEntries')).not.toContainText(
        'chrome://',
      );
    });
  });

  test('settings marks the Sync addon experimental', async ({ page }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
      });

      await page.locator('#settingsBtn').click();
      const syncHeader = page.locator('.addon-header', { hasText: 'Sync' });
      await expect(syncHeader.locator('.addon-experimental-badge')).toHaveText(
        'Experimental',
      );
      const syncDescriptionSize = await syncHeader
        .locator('.addon-header-desc')
        .evaluate((el) => ({
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
        }));
      expect(syncDescriptionSize.scrollWidth).toBeLessThanOrEqual(
        syncDescriptionSize.clientWidth,
      );
    });
  });

  test('desktop scroll panes stop at their boundaries', async ({ page }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
      });

      await page.locator('#settingsBtn').click();

      const containedScrollPanes = [
        '.main.scroll-boundary-contained',
        '.sidebar-content.scroll-boundary-contained',
        '#settingsModal .modal-body.scroll-boundary-contained',
        '#blacklistEntries.scroll-boundary-contained',
        '#trimEntries.scroll-boundary-contained',
        '#bookmarkTreeContainer.scroll-boundary-contained',
        '#importFailures.scroll-boundary-contained',
        '#historyImportFailures.scroll-boundary-contained',
        '#rulesPreviewList.scroll-boundary-contained',
        '#rulesPinsPreviewList.scroll-boundary-contained',
      ];
      for (const selector of containedScrollPanes) {
        const pane = page.locator(selector);
        await expect(pane, selector).toHaveCount(1);
        await expect
          .poll(() =>
            pane.evaluate((el) => {
              const style = getComputedStyle(el);
              return {
                x: style.overscrollBehaviorX,
                y: style.overscrollBehaviorY,
              };
            }),
          )
          .toEqual({ x: 'none', y: 'none' });
      }

      const containedHorizontalScrollPanes = [
        '#chartBars.scroll-boundary-contained-x',
        '#relatedChartBars.scroll-boundary-contained-x',
        '#qbBody.scroll-boundary-contained-x',
      ];
      for (const selector of containedHorizontalScrollPanes) {
        const pane = page.locator(selector);
        await expect(pane, selector).toHaveCount(1);
        await expect
          .poll(() =>
            pane.evaluate((el) => {
              const style = getComputedStyle(el);
              return {
                x: style.overscrollBehaviorX,
                y: style.overscrollBehaviorY,
              };
            }),
          )
          .toEqual({ x: 'none', y: 'auto' });
      }
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

      await commitDesktopSearch(page, 'needle');
      await expect(page.getByText('Needle daemon A')).toBeVisible();
      await expect(page.getByText('Needle daemon B')).toBeVisible();

      await page.locator('#filterToggleBtn').click();
      await page.locator('.filter-bubble[data-device-id="device-a"]').click();

      await expect(page.getByText('Needle daemon A')).toBeVisible();
      await expect(page.getByText('Needle daemon B')).toHaveCount(0);
    });
  });

  test('clear button resets active search filters', async ({ page }) => {
    const now = Date.now();
    const deviceAUrl = 'https://example.com/clear-filter-device-a';
    const deviceBUrl = 'https://example.com/clear-filter-device-b';
    const deviceASlug = generateSlugFromUrl(deviceAUrl);
    const deviceBSlug = generateSlugFromUrl(deviceBUrl);
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [
          {
            url: 'https://example.com/clear-filter-local-marker',
            title: 'Clear filter local marker',
            timestamp: now - 30_000,
            deviceId: 'device-a',
          },
          {
            url: 'https://example.com/clear-filter-remote-marker',
            title: 'Clear filter remote marker',
            timestamp: now - 20_000,
            deviceId: 'device-b',
          },
        ],
        extraSession: {
          [pageKey(deviceASlug)]: {
            slug: deviceASlug,
            url: deviceAUrl,
            title: 'Clear filter daemon A',
            timestamps: { 'device-a': now - 10_000 },
          },
          [pageKey(deviceBSlug)]: {
            slug: deviceBSlug,
            url: deviceBUrl,
            title: 'Clear filter daemon B',
            timestamps: { 'device-b': now - 5_000 },
          },
        },
        searchHistoryResults: [
          {
            url: deviceAUrl,
            title: 'Clear filter daemon A',
            timestamp: now - 10_000,
            score: 2,
          },
          {
            url: deviceBUrl,
            title: 'Clear filter daemon B',
            timestamp: now - 5_000,
            score: 2,
          },
        ],
      });

      await commitDesktopSearch(page, 'clear filter');
      await expect(page.getByText('Clear filter daemon A')).toBeVisible();
      await expect(page.getByText('Clear filter daemon B')).toBeVisible();

      await page.locator('#filterToggleBtn').click();
      await expect(page.locator('#filterClearBtn')).toBeDisabled();

      await page.locator('.filter-bubble[data-device-id="device-a"]').click();
      await expect(page.locator('#filterToggleBtn')).toHaveClass(/has-filters/);
      await expect(page.locator('#filterClearBtn')).toBeEnabled();
      await expect(page.getByText('Clear filter daemon A')).toBeVisible();
      await expect(page.getByText('Clear filter daemon B')).toHaveCount(0);

      await page.locator('#filterClearBtn').click();
      await expect(page.locator('#filterToggleBtn')).not.toHaveClass(
        /has-filters/,
      );
      await expect(
        page.locator('.filter-bubble[data-device-id="device-a"]'),
      ).not.toHaveClass(/active/);
      await expect(page.locator('#filterClearBtn')).toBeDisabled();
      await expect(page.getByText('Clear filter daemon A')).toBeVisible();
      await expect(page.getByText('Clear filter daemon B')).toBeVisible();
    });
  });

  test('explore device filters render from log device directories', async ({
    page,
  }) => {
    const now = Date.now();
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        logDevices: ['device-a', 'device-b'],
        historyEntries: [
          {
            url: 'https://example.com/local-device-marker',
            title: 'Only loaded device marker',
            timestamp: now - 30_000,
            deviceId: 'device-a',
          },
        ],
      });

      await page.locator('#filterToggleBtn').click();
      await expect(
        page
          .locator('#filterPanel .filter-section-label')
          .filter({ hasText: /^Devices$/ }),
      ).toBeVisible();
      await expect(
        page.locator('.filter-bubble[data-device-id="device-a"]'),
      ).toBeVisible();
      await expect(
        page.locator('.filter-bubble[data-device-id="device-b"]'),
      ).toBeVisible();
      await page.locator('.filter-bubble[data-device-id="device-b"]').click();
      await expect(
        page.locator(
          '.result-row[data-url="https://example.com/local-device-marker"]',
        ),
      ).toHaveCount(0);
      await expect(page.locator('#relatedResults')).toContainText('No results');
    });
  });

  test('device filter does not duplicate a multi-device site by other-device visits', async ({
    page,
  }) => {
    const now = Date.now();
    const sharedUrl = 'https://example.com/shared-device-site';
    const sharedSlug = generateSlugFromUrl(sharedUrl);
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [],
        historyEntriesByDate: {
          '2026-05-27': [
            {
              url: sharedUrl,
              title: 'Shared device site',
              timestamp: now - 2 * 86400000,
              deviceId: 'device-b',
            },
          ],
          '2026-05-28': [
            {
              url: sharedUrl,
              title: 'Shared device site',
              timestamp: now - 86400000,
              deviceId: 'device-b',
            },
          ],
          '2026-05-29': [
            {
              url: sharedUrl,
              title: 'Shared device site',
              timestamp: now - 10_000,
              deviceId: 'device-a',
            },
            {
              url: 'https://example.com/device-b-marker',
              title: 'Device B marker',
              timestamp: now - 5_000,
              deviceId: 'device-b',
            },
          ],
        },
        extraSession: {
          [pageKey(sharedSlug)]: {
            slug: sharedSlug,
            url: sharedUrl,
            title: 'Shared device site',
            timestamps: {
              'device-a': now - 10_000,
              'device-b': now - 86400000,
            },
          },
        },
      });

      await page.locator('#filterToggleBtn').click();
      await page.locator('.filter-bubble[data-device-id="device-a"]').click();

      await expect(
        page.locator(`.result-row[data-url="${sharedUrl}"]`),
      ).toHaveCount(1);
    });
  });

  test('desktop history search streams chunks and cancels stale searches', async ({
    page,
  }) => {
    const now = Date.now();
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        searchHistoryResultsByQuery: {
          'stream first': [
            {
              delay: 0,
              results: [
                {
                  url: 'https://example.com/stream-first',
                  title: 'Stream first chunk',
                  timestamp: now - 2000,
                  score: 3,
                },
              ],
            },
            {
              delay: 10_000,
              results: [
                {
                  url: 'https://example.com/stream-stale',
                  title: 'Stream stale late chunk',
                  timestamp: now - 1000,
                  score: 4,
                },
              ],
            },
          ],
          'stream second': [
            {
              delay: 0,
              results: [
                {
                  url: 'https://example.com/stream-second',
                  title: 'Stream second fresh',
                  timestamp: now,
                  score: 5,
                },
              ],
            },
          ],
          'stream duplicate': [
            {
              delay: 0,
              results: [
                {
                  url: 'https://example.com/stream-duplicate',
                  title: 'Stream duplicate older',
                  timestamp: now - 4000,
                  score: 3,
                },
              ],
            },
            {
              delay: 20,
              results: [
                {
                  url: 'https://example.com/stream-duplicate',
                  title: 'Stream duplicate newer',
                  timestamp: now,
                  score: 3,
                },
              ],
            },
          ],
        },
      });

      await commitDesktopSearch(page, 'stream first');
      await expect(page.getByText('Stream first chunk')).toBeVisible();
      await expect(page.getByText('Stream stale late chunk')).toHaveCount(0, {
        timeout: 100,
      });

      await commitDesktopSearch(page, 'stream second');
      await expect(page.getByText('Stream second fresh')).toBeVisible();
      await expect(page.getByText('Stream stale late chunk')).toHaveCount(0, {
        timeout: 250,
      });
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness.cancelledHistorySearchIds(),
          ),
        )
        .toHaveLength(1);
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness.listenerCount(
              'bridge-search-history',
            ),
          ),
        )
        .toBe(0);

      await commitDesktopSearch(page, 'stream duplicate');
      await expect(page.getByText('Stream duplicate newer')).toBeVisible();
      await expect(page.getByText('Stream duplicate older')).toHaveCount(0);
    });
  });

  test('desktop search starts only when Enter commits the draft query', async ({
    page,
  }) => {
    const staleUrl = 'https://example.com/stale-cleared-note';
    const staleSlug = generateSlugFromUrl(staleUrl);
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        extraSession: {
          [pageKey(staleSlug)]: {
            slug: staleSlug,
            url: staleUrl,
            title: 'Stale cleared note result',
            childIds: ['note:stale-cleared-note'],
            parentIds: [],
            visitDates: [],
            timestamps: { 'device-a': Date.now() },
          },
        },
        searchHistoryResultsByQuery: {
          deliberate: [
            {
              delay: 0,
              results: [
                {
                  url: 'https://example.com/deliberate-search',
                  title: 'Deliberate search result',
                  timestamp: Date.now(),
                  score: 4,
                },
              ],
            },
          ],
        },
        searchNotesResultsByQuery: {
          'stale note': {
            delay: 250,
            results: [
              {
                url: staleUrl,
                noteSlug: 'stale-cleared-note',
                score: 5,
              },
            ],
          },
        },
      });

      const draft = page.locator('#searchDraftInput');
      const clearDraft = page.locator('#searchDraftClearBtn');
      await expect(draft).toHaveAttribute('placeholder', 'Search...');
      await expect(page.getByText('Product research notes')).toBeVisible();
      await expect(clearDraft).toBeHidden();
      await draft.click();
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);

      await draft.fill('deliberate');
      await expect(clearDraft).toBeVisible();
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);
      await page.waitForTimeout(500);

      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness.searchHistoryInvocations(),
          ),
        )
        .toEqual([]);
      await expect(page.getByText('Deliberate search result')).toHaveCount(0);

      await draft.press('Enter');

      const searchInvocationsAfterEnter = await page.evaluate(
        () => window.__desktopVisualHarness.searchHistoryInvocations().length,
      );
      expect(searchInvocationsAfterEnter).toBe(1);
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness
              .searchHistoryInvocations()
              .map((request) => request.query),
          ),
        )
        .toEqual(['deliberate']);
      await expect(page.getByText('Deliberate search result')).toBeVisible();
      await expect(page.locator('.search-row-input')).toHaveCount(0);
      await expect(page.locator('#searchDraftInput')).toHaveValue('deliberate');
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness.sessionValue('searchQueries:explore'),
          ),
        )
        .toBe('deliberate');

      await clearDraft.click();
      await expect(draft).toHaveValue('');
      await expect(clearDraft).toBeHidden();
      await expect(page.getByText('Deliberate search result')).toHaveCount(0);
      await expect(page.getByText('Product research notes')).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness.sessionValue('searchQueries:explore'),
          ),
        )
        .toBe('');

      await draft.fill('draft escape');
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);
      await draft.press('Escape');
      await expect(draft).toHaveValue('');
      await expect(page.getByText('Product research notes')).toBeVisible();

      await draft.fill('draft blur');
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);
      await page.locator('#mainTitle').click();
      await expect(draft).toHaveValue('draft blur');
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.id === 'searchDraftInput',
          ),
        )
        .toBe(true);
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(0);

      await draft.fill('stale note');
      await draft.press('Enter');
      await clearDraft.click();
      await expect(draft).toHaveValue('');
      await expect(page.getByText('Product research notes')).toBeVisible();
      await page.waitForTimeout(400);
      await expect(page.getByText('Stale cleared note result')).toHaveCount(0);
      await expect(page.getByText('Product research notes')).toBeVisible();
    });
  });

  test('note search merge preserves history visit recency', async ({
    page,
  }) => {
    const now = Date.now();
    const oldUrl = 'https://example.com/note-recency-old';
    const recentUrl = 'https://example.com/note-recency-recent';
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        searchHistoryResultsByQuery: {
          'recency note': [
            {
              delay: 0,
              results: [
                {
                  url: oldUrl,
                  title: 'Recency note old',
                  timestamp: now - 10 * 86_400_000,
                  score: 1,
                },
                {
                  url: recentUrl,
                  title: 'Recency note recent',
                  timestamp: now - 86_400_000,
                  score: 1,
                },
              ],
            },
          ],
        },
        searchNotesResultsByQuery: {
          'recency note': [{ url: oldUrl, noteSlug: 'note-recency-old' }],
        },
      });

      await commitDesktopSearch(page, 'recency note');
      await expect(page.getByText('Recency note recent')).toBeVisible();
      await expect(page.getByText('Recency note old')).toBeVisible();

      const titles = await page
        .locator('.result-row .result-title')
        .evaluateAll((nodes) =>
          nodes.slice(0, 2).map((node) => node.textContent.trim()),
        );
      expect(titles).toEqual(['Recency note recent', 'Recency note old']);
    });
  });

  test('note-only search result uses the page timestamp', async ({ page }) => {
    const noteTime = Date.now() - 4 * 86_400_000;
    const url = 'https://example.com/note-result-timestamp';
    const slug = generateSlugFromUrl(url);
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [],
        extraSession: {
          [pageKey(slug)]: {
            slug,
            url,
            title: 'Note result timestamp',
            childIds: ['note:note-result-timestamp'],
            parentIds: [],
            visitDates: [],
            timestamps: { 'device-a': noteTime },
          },
        },
        searchNotesResultsByQuery: {
          'note timestamp': [
            {
              url,
              noteSlug: 'note-result-timestamp',
              score: 1,
            },
          ],
        },
      });

      await commitDesktopSearch(page, 'note timestamp');

      const row = page.locator(`.result-row[data-url="${url}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator('.result-title')).toHaveText(
        'Note result timestamp',
      );
      await expect(row.locator('.result-time')).toHaveText('4d ago');
      await expect(page.locator('.card-tag-match-note')).toBeVisible();
    });
  });

  test('snapshot search result uses the matched snapshot timestamp', async ({
    page,
  }) => {
    const snapshotTime = Date.now() - 3 * 86_400_000;
    const url = 'https://example.com/snapshot-result-timestamp';
    const slug = generateSlugFromUrl(url);
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [],
        extraSession: {
          [pageKey(slug)]: {
            slug,
            url,
            title: 'Snapshot result timestamp',
            childIds: [`snapshot:${slug}-${snapshotTime}`],
            parentIds: [],
            visitDates: [],
          },
        },
        searchSnapshotsResultsByQuery: {
          'snapshot timestamp': [{ slug, timestamp: snapshotTime, score: 1 }],
        },
      });

      await commitDesktopSearch(page, 'snapshot timestamp');

      const row = page.locator(`.result-row[data-url="${url}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator('.result-title')).toHaveText(
        'Snapshot result timestamp',
      );
      await expect(row.locator('.result-time')).toHaveText('3d ago');
      await expect(page.locator('.card-tag-match-snap')).toBeVisible();
    });
  });

  test('snapshot matches do not boost pages that already match by url', async ({
    page,
  }) => {
    const now = Date.now();
    const query = 'orderingtoken';
    const newerUrl = `https://example.com/url-order-newer/${query}`;
    const olderUrl = `https://example.com/url-order-older/${query}`;
    const noteOnlyUrl = 'https://example.com/note-only-ordering';
    const snapshotOnlyUrl = 'https://example.com/snapshot-only-ordering';
    const olderSlug = generateSlugFromUrl(olderUrl);
    const noteOnlySlug = generateSlugFromUrl(noteOnlyUrl);
    const snapshotOnlySlug = generateSlugFromUrl(snapshotOnlyUrl);
    const snapshotTime = now - 5 * 86_400_000;
    const snapshotOnlyTime = now - 30_000;

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [
          {
            url: newerUrl,
            title: 'Newer URL match',
            timestamp: now - 60_000,
            deviceId: 'device-a',
          },
          {
            url: olderUrl,
            title: 'Older URL and snapshot match',
            timestamp: now - 3_600_000,
            deviceId: 'device-a',
          },
        ],
        extraSession: {
          [pageKey(olderSlug)]: {
            slug: olderSlug,
            url: olderUrl,
            title: 'Older URL and snapshot match',
            childIds: [`snapshot:${olderSlug}-${snapshotTime}`],
            parentIds: [],
            visitDates: [],
          },
          [pageKey(noteOnlySlug)]: {
            slug: noteOnlySlug,
            url: noteOnlyUrl,
            title: 'Note only match',
            childIds: ['note:note-only-ordering'],
            parentIds: [],
            visitDates: [],
            timestamps: { 'device-a': now - 2 * 86_400_000 },
          },
          [pageKey(snapshotOnlySlug)]: {
            slug: snapshotOnlySlug,
            url: snapshotOnlyUrl,
            title: 'Snapshot only match',
            childIds: [`snapshot:${snapshotOnlySlug}-${snapshotOnlyTime}`],
            parentIds: [],
            visitDates: [],
          },
        },
        searchNotesResultsByQuery: {
          [query]: [
            { url: noteOnlyUrl, noteSlug: 'note-only-ordering', score: 1 },
          ],
        },
        searchSnapshotsResultsByQuery: {
          [query]: [
            { slug: olderSlug, timestamp: snapshotTime, score: 1 },
            { slug: snapshotOnlySlug, timestamp: snapshotOnlyTime, score: 1 },
          ],
        },
      });

      await commitDesktopSearch(page, query);
      await expect(page.locator('.card-tag-match-snap')).toHaveCount(2);

      const titles = await page
        .locator('.result-row .result-title')
        .evaluateAll((nodes) =>
          nodes.slice(0, 4).map((node) => node.textContent.trim()),
        );
      expect(titles).toEqual([
        'Newer URL match',
        'Older URL and snapshot match',
        'Note only match',
        'Snapshot only match',
      ]);
    });
  });

  test('phase 0 search preserves shared relevance scores', async ({ page }) => {
    const now = Date.now();
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [
          {
            url: 'https://example.com/phase-zero/relevance',
            title: 'Recent URL-only hit',
            timestamp: now - 5_000,
            deviceId: 'device-a',
          },
          {
            url: 'https://example.com/phase-zero/older',
            title: 'Older relevance title hit',
            timestamp: now - 10 * 86_400_000,
            deviceId: 'device-a',
          },
        ],
      });

      await commitDesktopSearch(page, 'relevance');
      await expect(page.locator('.result-row')).toHaveCount(2);
      const titles = await page
        .locator('.result-row .result-title')
        .evaluateAll((nodes) =>
          nodes.slice(0, 2).map((node) => node.textContent.trim()),
        );
      expect(titles).toEqual([
        'Older relevance title hit',
        'Recent URL-only hit',
      ]);
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

      await commitDesktopSearch(page, '"needle"');
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

  test('history metadata refresh preserves demand-load cursor for new front files', async ({
    page,
  }) => {
    const dayMs = 86_400_000;
    const base = Date.now();
    const nextDay = base + dayMs;
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyFileBatch: 1,
        historyEntries: [
          {
            url: 'https://example.com/already-loaded-day',
            title: 'Already loaded day',
            timestamp: base,
            deviceId: 'device-a',
          },
        ],
      });

      await expect(page.getByText('Already loaded day')).toBeVisible();
      await page.evaluate(
        ({ nextDay }) => {
          window.__desktopVisualHarness.appendHistoryEntry({
            url: 'https://example.com/new-front-day',
            title: 'New front day',
            timestamp: nextDay,
            deviceId: 'device-a',
          });
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
          });
          document.dispatchEvent(new Event('visibilitychange'));
        },
        { nextDay },
      );

      await expect(page.getByText('New front day')).toBeVisible({
        timeout: 3000,
      });
      await page.evaluate(async () => {
        const main = document.querySelector('.main');
        main.scrollTop = main.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      await expect(page.getByText('Already loaded day')).toHaveCount(1);
      await expect(page.getByText('New front day')).toHaveCount(1);
    });
  });

  test('list view renders all pins directly and starts at the top after previous scroll state', async ({
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
        return {
          scrollTop: main.scrollTop,
          paddingTop: getComputedStyle(
            document.getElementById('relatedResults'),
          ).paddingTop,
          hasVirtualScroller: Boolean(
            document.getElementById('relatedResults')._virtualScroller,
          ),
          renderedRows: document.querySelectorAll('.result-row').length,
          firstTitle: document
            .querySelector('.result-row .result-title')
            ?.textContent?.trim(),
        };
      });

      expect(state).toMatchObject({
        scrollTop: 0,
        paddingTop: '0px',
        hasVirtualScroller: false,
        renderedRows: VIRTUALIZED_ENTRY_COUNT,
        firstTitle: 'List top 0',
      });

      const bottomVisibility = await page.evaluate(async () => {
        const main = document.querySelector('.main');
        main.scrollTop = main.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        main.scrollTop = main.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const item = document.querySelector('.result-item:last-child');
        const sidebar = document.querySelector('.sidebar');
        const itemRect = item.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        return {
          itemBottom: itemRect.bottom,
          sidebarBottom: sidebarRect.bottom,
          bottomGutter: mainRect.bottom - itemRect.bottom,
        };
      });
      expect(
        Math.abs(bottomVisibility.itemBottom - bottomVisibility.sidebarBottom),
      ).toBeLessThanOrEqual(1);
      expect(bottomVisibility.bottomGutter).toBeGreaterThanOrEqual(11);
      expect(bottomVisibility.bottomGutter).toBeLessThanOrEqual(13);

      await page.keyboard.press(
        process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
      );
      await expect(page.locator('.result-row.selected')).toHaveCount(
        VIRTUALIZED_ENTRY_COUNT,
      );
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

  test('wheel at a nested scroller edge does not bubble into the main pane', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 120 }, (_, i) => ({
      url: `https://example.com/nested-edge-${i}`,
      title: `Nested edge ${i}`,
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
        const main = document.querySelector('.main');
        const nested = document.createElement('div');
        nested.style.cssText =
          'height:40px; overflow-y:auto; overscroll-behavior:auto;';
        nested.innerHTML = '<div style="height:160px"></div>';
        document.querySelector('.result-item').appendChild(nested);
        nested.scrollTop = nested.scrollHeight;
        const beforeMainScrollTop = main.scrollTop;
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: 48,
        });
        const dispatched = nested.dispatchEvent(event);
        return {
          prevented: !dispatched,
          mainScrollTop: main.scrollTop,
          beforeMainScrollTop,
        };
      });

      expect(defaultPrevented.prevented).toBe(true);
      expect(defaultPrevented.mainScrollTop).toBe(
        defaultPrevented.beforeMainScrollTop,
      );
    });
  });

  test('mouse wheel scrolls the main results pane', async ({ page }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 120 }, (_, i) => ({
      url: `https://example.com/mouse-wheel-${i}`,
      title: `Mouse wheel ${i}`,
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

      const main = page.locator('.main');
      const firstRow = page.locator('.result-row').first();
      const rowBox = await firstRow.boundingBox();
      expect(rowBox).not.toBeNull();
      await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + 8);
      await page.mouse.wheel(0, 480);
      await expect
        .poll(async () => main.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
    });
  });

  test('main scrollbar hides after idle and reveals only over scrollbar area', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 120 }, (_, i) => ({
      url: `https://example.com/scrollbar-hide-${i}`,
      title: `Scrollbar hide ${i}`,
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

      const main = page.locator('.main');
      const mainBox = await main.boundingBox();
      expect(mainBox).not.toBeNull();
      const thumbColor = () =>
        main.evaluate(
          (el) =>
            getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
        );

      await page.mouse.move(mainBox.x + mainBox.width / 2, mainBox.y + 160);
      await page.mouse.wheel(0, 480);
      await expect
        .poll(async () =>
          main.evaluate((el) => el.classList.contains('is-scrolling')),
        )
        .toBe(true);
      await expect
        .poll(async () =>
          main.evaluate((el) => el.classList.contains('is-scrolling')),
        )
        .toBe(false);

      await expect.poll(thumbColor).toBe('rgba(0, 0, 0, 0)');

      await page.mouse.move(mainBox.x + mainBox.width / 2, mainBox.y + 220);
      await expect.poll(thumbColor).toBe('rgba(0, 0, 0, 0)');

      await page.mouse.move(mainBox.x + mainBox.width - 2, mainBox.y + 220);
      await expect.poll(thumbColor).not.toBe('rgba(0, 0, 0, 0)');

      await page.mouse.move(mainBox.x + mainBox.width / 2, mainBox.y + 220);
      await expect.poll(thumbColor).toBe('rgba(0, 0, 0, 0)');
    });
  });

  test('slow virtualized scrolling does not snap while measuring variable-height rows', async ({
    page,
  }) => {
    test.slow();
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
          excerpt: ['highlighted text'],
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
          const item = row.closest('.result-item');
          const main = document.querySelector('.main');
          const sidebar = document.querySelector('.sidebar');
          const rowRect = row.getBoundingClientRect();
          const itemRect = item.getBoundingClientRect();
          const mainRect = main.getBoundingClientRect();
          const sidebarRect = sidebar.getBoundingClientRect();
          return {
            found: true,
            rowBottom: rowRect.bottom,
            itemBottom: itemRect.bottom,
            mainBottom: mainRect.bottom,
            sidebarBottom: sidebarRect.bottom,
            bottomGutter: mainRect.bottom - itemRect.bottom,
          };
        },
        { lastUrl },
      );
      expect(visibility.found).toBe(true);
      expect(visibility.rowBottom).toBeLessThanOrEqual(
        visibility.mainBottom + 1,
      );
      expect(
        Math.abs(visibility.itemBottom - visibility.sidebarBottom),
      ).toBeLessThanOrEqual(1);
      expect(visibility.bottomGutter).toBeGreaterThanOrEqual(11);
      expect(visibility.bottomGutter).toBeLessThanOrEqual(13);
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

      const dragResult = await page.evaluate(() => {
        const row = document.querySelector('.result-row.selected');
        const data = new Map();
        let dragImage = null;
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
            setDragImage(element, x, y) {
              dragImage = { text: element.textContent, x, y };
            },
          },
        });
        row.dispatchEvent(event);
        return {
          payload: JSON.parse(data.get('text/plain') || '{}'),
          dragImage,
        };
      });

      expect(dragResult.payload.items.map((item) => item.url)).toEqual([
        'https://example.com/drag-selected-0',
        'https://example.com/drag-selected-1',
      ]);
      expect(dragResult.dragImage.text).toContain('Drag selected 0');
      expect(dragResult.dragImage.text).toContain('Drag selected 1');
    });
  });

  test('marquee selection intersects the full page card bounds', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 4 }, (_, i) => {
      const url = `https://example.com/marquee-card-bounds-${i}`;
      return {
        url,
        title: `Marquee card bounds ${i}`,
        timestamp: now - i * 1000,
        deviceId: 'device-a',
      };
    });
    const extraSession = {};
    for (const entry of historyEntries) {
      const slug = generateSlugFromUrl(entry.url);
      extraSession[pageKey(slug)] = {
        slug,
        url: entry.url,
        title: entry.title,
        likes: 1,
        parentIds: [],
        childIds: [],
        visitDates: [],
      };
    }

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries,
        extraSession,
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.result-item').length >= 4,
      );
      await expect(page.locator('.card-tag-liked')).toHaveCount(4);

      const drag = await page.evaluate(() => {
        const wrapper = document.querySelector('#relatedResultsWrapper');
        const items = [...document.querySelectorAll('.result-item')];
        const firstItemRect = items[0].getBoundingClientRect();
        const thirdItemRect = items[2].getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        return {
          startX:
            firstItemRect.left -
            Math.min(8, firstItemRect.left - wrapperRect.left - 2),
          endX: firstItemRect.left + firstItemRect.width / 2,
          startY: firstItemRect.bottom - 4,
          endY: thirdItemRect.top + 4,
        };
      });

      await page.mouse.move(drag.startX, drag.startY);
      await page.mouse.down();
      await page.mouse.move(drag.endX, drag.endY, { steps: 8 });
      await page.mouse.up();

      await expect(page.locator('.result-row.selected')).toHaveCount(3);
      await expect(
        page.locator('.result-row.selected .result-title'),
      ).toHaveText([
        'Marquee card bounds 0',
        'Marquee card bounds 1',
        'Marquee card bounds 2',
      ]);
    });
  });

  test('pressing enter opens selected pages in the browser', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 4 }, (_, i) => ({
      url: `https://example.com/open-selected-${i}`,
      title: `Open selected ${i}`,
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
      await page.keyboard.down('Meta');
      await rows.nth(1).click();
      await page.keyboard.up('Meta');

      await expect(page.locator('.result-row.selected')).toHaveCount(2);
      await page.keyboard.press('Enter');

      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness.openedExternalUrls(),
          ),
        )
        .toEqual([
          'https://example.com/open-selected-0',
          'https://example.com/open-selected-1',
        ]);
    });
  });

  test('pressing enter on a focused control does not open selected pages', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 3 }, (_, i) => ({
      url: `https://example.com/focused-control-${i}`,
      title: `Focused control ${i}`,
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
      await page.keyboard.down('Meta');
      await rows.nth(1).click();
      await page.keyboard.up('Meta');
      await expect(page.locator('.result-row.selected')).toHaveCount(2);

      await page.locator('#settingsBtn').focus();
      await page.keyboard.press('Enter');

      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness.openedExternalUrls(),
          ),
        )
        .toEqual([]);
      await expect(page.locator('#settingsModal')).toBeVisible();
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
      await page.mouse.move(badgeBox.x + 4, badgeBox.y + badgeBox.height / 2);
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

  test('chart to result gap remains stable after selecting rows and resizing', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = Array.from({ length: 80 }, (_, i) => ({
      url: `https://example.com/stable-layout-${i}`,
      title: `Stable layout ${i}`,
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
      await page.waitForFunction(
        () => document.querySelectorAll('#relatedResults .result-row').length,
      );

      const measureGap = async () =>
        page.evaluate(() => {
          const chart = document.getElementById('relatedChart');
          const firstItem = document.querySelector(
            '#relatedResults .result-item',
          );
          const chartRect = chart.getBoundingClientRect();
          const itemRect = firstItem.getBoundingClientRect();
          return Math.round(itemRect.top - chartRect.bottom);
        });

      const initialGap = await measureGap();
      expect(initialGap).toBeGreaterThanOrEqual(0);
      expect(initialGap).toBeLessThanOrEqual(12);

      await page.locator('#relatedResults .result-row').first().click();
      await expect(
        page.locator('#relatedResults .result-row.selected'),
      ).toHaveCount(1);
      await expect.poll(measureGap).toBe(initialGap);

      await page.setViewportSize({ width: 900, height: 560 });
      await expect.poll(measureGap).toBe(initialGap);

      await page.setViewportSize({ width: 1280, height: 820 });
      await expect.poll(measureGap).toBe(initialGap);
    });
  });

  test('explore page list fills the remaining main pane height', async ({
    page,
  }) => {
    const now = Date.now();
    const historyEntries = [
      {
        url: 'https://example.com/sparse-layout',
        title: 'Sparse layout',
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
      await expect(page.locator('#relatedChart.visible')).toBeVisible();
      await expect(page.locator('#relatedResults .result-row')).toHaveCount(1);

      const metrics = await page.evaluate(() => {
        const main = document.querySelector('.main').getBoundingClientRect();
        const list = document
          .getElementById('listLayout')
          .getBoundingClientRect();
        const wrapper = document
          .getElementById('relatedResultsWrapper')
          .getBoundingClientRect();
        return {
          mainBottom: Math.round(main.bottom),
          listBottom: Math.round(list.bottom),
          wrapperBottom: Math.round(wrapper.bottom),
        };
      });

      expect(
        Math.abs(metrics.listBottom - metrics.mainBottom),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(metrics.wrapperBottom - metrics.mainBottom),
      ).toBeLessThanOrEqual(1);
    });
  });

  test('explore chart date click keeps per-day duplicate rows scoped to their row date', async ({
    page,
  }) => {
    const selectedDate = new Date(Date.now() - 4 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const otherDate = new Date(Date.now() - 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const selectedTimestamp = new Date(`${selectedDate}T12:00:00Z`).getTime();
    const otherTimestamp = new Date(`${otherDate}T12:00:00Z`).getTime();
    const url = 'https://example.com/history-chart-per-day-duplicate';
    const slug = generateSlugFromUrl(url);
    const extraSession = {
      [pageKey(slug)]: {
        slug,
        url,
        title: 'History chart per-day duplicate',
        parentIds: [],
        childIds: [],
        visitDates: [visitDateInt(selectedDate), visitDateInt(otherDate)],
        timestamps: {
          'device-a': otherTimestamp,
        },
      },
    };

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntriesByDate: {
          [selectedDate]: [
            {
              url,
              title: 'History chart per-day duplicate',
              timestamp: selectedTimestamp,
              deviceId: 'device-a',
            },
          ],
          [otherDate]: [
            {
              url,
              title: 'History chart per-day duplicate',
              timestamp: otherTimestamp,
              deviceId: 'device-a',
            },
          ],
        },
        extraSession,
      });

      await page.waitForFunction(() =>
        document
          .getElementById('relatedResults')
          ?._virtualScroller?._fullData?.some(
            (item) =>
              item.url ===
                'https://example.com/history-chart-per-day-duplicate' &&
              Array.isArray(item.listSlugs),
          ),
      );

      const selectedBar = page.locator(
        `#relatedChartBars .chart-bar-group[data-date="${selectedDate}"] .chart-bar`,
      );
      await expect(selectedBar).toBeVisible();
      await selectedBar.click();

      const visibleDuplicateTimestamps = await page.evaluate((rowUrl) => {
        const scroller =
          document.getElementById('relatedResults')._virtualScroller;
        return scroller.data
          .filter((item) => item.url === rowUrl)
          .map((item) => item.timestamps[0])
          .sort((left, right) => left - right);
      }, url);
      expect(visibleDuplicateTimestamps).toEqual([selectedTimestamp]);
    });
  });

  test('explore chart date click filters rows by durable visit dates', async ({
    page,
  }) => {
    const now = Date.now();
    const selectedDate = new Date(now - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const otherDate = new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);
    const todayVisitDate = visitDateInt(todayKey());
    const revisitedUrl = 'https://example.com/chart-filter-revisited';
    const otherRevisitedUrl =
      'https://example.com/chart-filter-other-revisited';
    const revisitedSlug = generateSlugFromUrl(revisitedUrl);
    const otherRevisitedSlug = generateSlugFromUrl(otherRevisitedUrl);
    const extraSession = {
      [pageKey(revisitedSlug)]: {
        slug: revisitedSlug,
        url: revisitedUrl,
        title: 'Chart filter revisited',
        parentIds: [],
        childIds: [],
        visitDates: [visitDateInt(selectedDate), todayVisitDate],
        timestamps: {
          'device-a': now,
        },
      },
      [pageKey(otherRevisitedSlug)]: {
        slug: otherRevisitedSlug,
        url: otherRevisitedUrl,
        title: 'Chart filter other revisited',
        parentIds: [],
        childIds: [],
        visitDates: [visitDateInt(otherDate), todayVisitDate],
        timestamps: {
          'device-a': now - 1000,
        },
      },
    };

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [],
        extraSession,
      });

      await page.locator('#filterToggleBtn').click();
      await page
        .locator('.filter-checkbox input[data-key="visitedMultipleTimes"]')
        .click();
      await expect(
        page.locator(`.result-row[data-url="${revisitedUrl}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`.result-row[data-url="${otherRevisitedUrl}"]`),
      ).toBeVisible();

      const selectedBar = page.locator(
        `#relatedChartBars .chart-bar-group[data-date="${selectedDate}"] .chart-bar`,
      );
      await expect(selectedBar).toBeVisible();
      await selectedBar.click();

      await expect(
        page.locator(`.result-row[data-url="${revisitedUrl}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`.result-row[data-url="${otherRevisitedUrl}"]`),
      ).toHaveCount(0);

      const visibleUrls = await page.evaluate(() => {
        const scroller =
          document.getElementById('relatedResults')._virtualScroller;
        return scroller.data.map((item) => item.url);
      });
      expect(visibleUrls).toEqual([revisitedUrl]);
    });
  });

  test('committed search renders directly and date filters visible rows', async ({
    page,
  }) => {
    const selectedDate = new Date(Date.now() - 8 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const otherDate = new Date(Date.now() - 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const selectedTimestamp = new Date(`${selectedDate}T12:00:00Z`).getTime();
    const otherTimestamp = new Date(`${otherDate}T12:00:00Z`).getTime();
    const searchResults = Array.from({ length: 40 }, (_, i) => ({
      url: `https://example.com/search-date-filter-${i}`,
      title: `Search date filter ${i}`,
      timestamp: i === 0 ? selectedTimestamp : otherTimestamp - i * 1000,
      score: 4,
    }));

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [],
        searchHistoryResults: searchResults,
      });

      await commitDesktopSearch(page, 'date filter');
      await page.waitForFunction(
        ({ expected }) =>
          Number(
            document.getElementById('relatedResults').dataset.searchCount || 0,
          ) >= expected,
        { expected: searchResults.length },
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => document.getElementById('relatedResults')._virtualScroller,
          ),
        )
        .toBe(null);

      await page.evaluate(async () => {
        const main = document.querySelector('.main');
        main.scrollTop = main.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      const selectedBar = page.locator(
        `#relatedChartBars .chart-bar-group[data-date="${selectedDate}"] .chart-bar`,
      );
      await expect(selectedBar).toBeVisible();
      await selectedBar.click();

      const metrics = await page.evaluate(() => {
        const main = document.querySelector('.main');
        const rows = [
          ...document.querySelectorAll('#relatedResults .result-row'),
        ];
        const visibleRows = rows.filter((row) => row.offsetParent !== null);
        return {
          scroller: document.getElementById('relatedResults')._virtualScroller,
          renderedCount: rows.length,
          visibleUrls: visibleRows.map((row) => row.dataset.url),
          scrollTop: main.scrollTop,
          maxScroll: main.scrollHeight - main.clientHeight,
          bottomPadding:
            parseFloat(
              getComputedStyle(document.getElementById('relatedResults'))
                .paddingBottom,
            ) || 0,
        };
      });
      expect(metrics.scroller).toBe(null);
      expect(metrics.renderedCount).toBeGreaterThanOrEqual(
        searchResults.length,
      );
      expect(metrics.visibleUrls).toEqual([
        'https://example.com/search-date-filter-0',
      ]);
      expect(metrics.scrollTop).toBeLessThanOrEqual(metrics.maxScroll + 1);
      expect(metrics.bottomPadding).toBeLessThan(200);
    });
  });

  test('select-all keyboard shortcut selects direct committed search rows', async ({
    page,
  }) => {
    const now = Date.now();
    const searchHistoryResults = [
      {
        url: 'https://example.com/search-select-all-one',
        title: 'Search select all one',
        timestamp: now - 1000,
        score: 4,
      },
      {
        url: 'https://example.com/search-select-all-two',
        title: 'Search select all two',
        timestamp: now - 2000,
        score: 4,
      },
    ];

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [],
        searchHistoryResults,
      });

      await commitDesktopSearch(page, 'select all');
      await page.waitForFunction(
        ({ expected }) =>
          Number(
            document.getElementById('relatedResults').dataset.searchCount || 0,
          ) === expected,
        { expected: searchHistoryResults.length },
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => document.getElementById('relatedResults')._virtualScroller,
          ),
        )
        .toBe(null);

      await page.locator('#relatedResults .result-row').first().click();
      await expect(
        page.locator('#relatedResults .result-row.selected'),
      ).toHaveCount(1);
      await page.evaluate(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'a',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      await expect(
        page.locator('#relatedResults .result-row.selected'),
      ).toHaveCount(searchHistoryResults.length);
      await expect(
        page.locator('#relatedResults .result-row.selected .result-title'),
      ).toHaveText(['Search select all one', 'Search select all two']);
    });
  });

  test('list chart date click filters pinned rows by page visit dates', async ({
    page,
  }) => {
    const selectedDate = new Date(Date.now() - 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const now = Date.now();
    const pinnedUrl = 'https://example.com/list-chart-visit-date';
    const pinnedSlug = generateSlugFromUrl(pinnedUrl);
    const otherUrl = 'https://example.com/list-chart-other-date';
    const otherSlug = generateSlugFromUrl(otherUrl);
    const extraSession = {
      [pageKey(pinnedSlug)]: {
        slug: pinnedSlug,
        url: pinnedUrl,
        title: 'List chart visit date',
        parentIds: [listKey('research')],
        childIds: [],
        visitDates: [visitDateInt(selectedDate)],
        timestamps: {
          'device-a': now,
        },
      },
      [pageKey(otherSlug)]: {
        slug: otherSlug,
        url: otherUrl,
        title: 'List chart other date',
        parentIds: [listKey('research')],
        childIds: [],
        visitDates: [visitDateInt(todayKey())],
        timestamps: {
          'device-a': now - 1000,
        },
      },
      [listKey('research')]: {
        slug: 'research',
        name: 'Research',
        pins: [
          { id: pageKey(pinnedSlug), pinnedAt: now },
          { id: pageKey(otherSlug), pinnedAt: now - 1000 },
        ],
      },
    };

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        extraSession,
      });

      await page.locator('.sidebar-item[data-list-id="research"]').click();
      await expect(
        page.locator(`.result-row[data-url="${pinnedUrl}"]`),
      ).toBeVisible();

      const selectedBar = page.locator(
        `#relatedChartBars .chart-bar-group[data-date="${selectedDate}"] .chart-bar`,
      );
      await expect(selectedBar).toBeVisible();
      await selectedBar.click();

      await expect(
        page.locator(`.result-row[data-url="${pinnedUrl}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`.result-row[data-url="${otherUrl}"]`),
      ).toBeHidden();
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

  test('empty recycle bin works immediately after deleting a list', async ({
    page,
  }) => {
    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
      });

      await page.locator('.sidebar-item[data-list-id="research"]').hover();
      await page
        .locator('.sidebar-item[data-list-id="research"] .remove-list')
        .click({ force: true });
      await page.locator('#recycleBinBtn').click();
      await expect(page.locator('.recycle-card-key')).toHaveText(
        'list:research',
      );

      await page.locator('.empty-bin-btn').click();

      await expect(page.locator('.recycle-card')).toHaveCount(0);
      await expect(page.locator('#recycleBinEmpty')).toBeVisible();
      await expect(page.locator('#recycleBinBtn')).toBeHidden();
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__desktopVisualHarness
              .recycleBinKeys()
              .map((entry) => entry.key),
          ),
        )
        .toEqual([]);
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
        previewRuleMatchesByPattern: {
          needle: ['https://example.com/rule-preview-match'],
        },
      });

      await page.locator('.sidebar-item[data-list-id="research"]').click();
      await page.locator('#inboxToggleBtn').click();
      await page.locator('#rulesAddBtn').click();
      await page.locator('.rule-edit-input').fill('needle');
      await page.locator('.rule-preview-btn').click();

      await expect(page.locator('#rulesPreviewList')).toContainText(
        'Rule preview needle',
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => window.__desktopVisualHarness.previewRuleInvocations().length,
          ),
        )
        .toBeGreaterThan(0);
      await expect(
        page.getByText('No visits found to match against'),
      ).toHaveCount(0);
    });
  });

  test('keyword rule preview replaces stale results on repeated previews', async ({
    page,
  }) => {
    const now = Date.now();
    const firstTitle = 'Rule preview first needle';
    const secondTitle = 'Rule preview second marker';
    const historyEntries = [
      {
        url: 'https://example.com/rule-preview/first',
        title: firstTitle,
        timestamp: now,
        deviceId: 'device-a',
      },
      {
        url: 'https://example.com/rule-preview/second',
        title: secondTitle,
        timestamp: now - 1000,
        deviceId: 'device-a',
      },
    ];

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries,
        previewRuleMatchesByPattern: {
          needle: ['https://example.com/rule-preview/first'],
          marker: ['https://example.com/rule-preview/second'],
        },
      });

      await page.locator('.sidebar-item[data-list-id="research"]').click();
      await page.locator('#inboxToggleBtn').click();
      await page.locator('#rulesAddBtn').click();
      await page.locator('.rule-edit-input').fill('needle');
      await page.locator('.rule-preview-btn').click();
      await expect(page.locator('#rulesPreviewList')).toContainText(firstTitle);

      await page.locator('.rule-edit-input').fill('marker');
      await page.locator('.rule-preview-btn').click();

      await expect(page.locator('#rulesPreviewList')).toContainText(
        secondTitle,
      );
      await expect(page.locator('#rulesPreviewList')).not.toContainText(
        firstTitle,
      );
    });
  });

  test(`keyword rule preview combines recent visits and active list pins seed=${DESKTOP_RULE_PREVIEW_SEED}`, async ({
    page,
  }) => {
    const random = seededRandom(DESKTOP_RULE_PREVIEW_SEED);
    const now = Date.now();
    const nouns = ['Atlas', 'Beacon', 'Cinder', 'Drift', 'Ember', 'Fjord'];
    const verbs = ['audit', 'brief', 'index', 'map', 'review', 'trace'];
    const titleMatch = `${pickSeeded(random, nouns)} Mixed NEEDLE ${pickSeeded(random, verbs)}`;
    const urlOnlyMiss = `${pickSeeded(random, nouns)} plain ${pickSeeded(random, verbs)}`;
    const pinnedTitle = `${pickSeeded(random, nouns)} pinned NeEdLe ${pickSeeded(random, verbs)}`;
    const pinnedUrl = 'https://example.com/rule-preview/pinned-active-list';
    const pinnedSlug = generateSlugFromUrl(pinnedUrl);
    const historyEntries = [
      {
        url: 'https://example.com/rule-preview/title-match',
        title: titleMatch,
        timestamp: now,
        deviceId: 'device-a',
      },
      {
        url: 'https://example.com/rule-preview/needle-url-only',
        title: urlOnlyMiss,
        timestamp: now - 1000,
        deviceId: 'device-a',
      },
    ];
    const extraSession = {
      [pageKey(pinnedSlug)]: {
        slug: pinnedSlug,
        url: pinnedUrl,
        title: pinnedTitle,
        parentIds: [listKey('research')],
        childIds: [],
        visitDates: [visitDateInt(todayKey())],
        timestamps: { 'device-a': now - 2000 },
      },
      [listKey('research')]: {
        slug: 'research',
        name: 'Research',
        pins: [{ id: pageKey(pinnedSlug), pinnedAt: now - 2000 }],
      },
    };

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries,
        extraSession,
        previewRuleMatchesByPattern: {
          needle: ['https://example.com/rule-preview/title-match', pinnedUrl],
        },
      });

      await page.locator('.sidebar-item[data-list-id="research"]').click();
      await expect(
        page.locator(`.result-row[data-url="${pinnedUrl}"]`),
      ).toBeVisible();
      await page.locator('#inboxToggleBtn').click();
      await page.locator('#rulesAddBtn').click();
      await page.locator('.rule-edit-input').fill('needle');
      await page.locator('.rule-preview-btn').click();

      await expect(page.locator('#rulesPreviewList')).toContainText(titleMatch);
      await expect(page.locator('#rulesPreviewList')).not.toContainText(
        urlOnlyMiss,
      );
      await expect(page.locator('#rulesPinsPreviewList')).toContainText(
        pinnedTitle,
      );
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

      await commitDesktopSearch(page, 'Search clear');
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
        const mainTop = main.getBoundingClientRect().top;
        const firstVisible = [...document.querySelectorAll('.result-row')].find(
          (row) => row.getBoundingClientRect().bottom > mainTop + 1,
        );
        return {
          scrollTop: main.scrollTop,
          firstUrl: firstVisible?.dataset.url || '',
        };
      });
      await page.evaluate(() => {
        const input = document.getElementById('searchDraftInput');
        input.value = '';
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
          }),
        );
      });
      await page.waitForFunction(
        () =>
          document.getElementById('relatedResults')._virtualScroller?._fullData
            ?.length > 0,
      );

      const after = await page.evaluate(() => {
        const main = document.querySelector('.main');
        const mainTop = main.getBoundingClientRect().top;
        const firstVisible = [...document.querySelectorAll('.result-row')].find(
          (row) => row.getBoundingClientRect().bottom > mainTop + 1,
        );
        return {
          scrollTop: main.scrollTop,
          maxScroll: main.scrollHeight - main.clientHeight,
          firstUrl: firstVisible?.dataset.url || '',
        };
      });
      expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(
        120,
      );
      expect(after.scrollTop).toBeLessThan(after.maxScroll - 200);
    });
  });

  test('reopening a hidden searched desktop window preserves current results without re-searching', async ({
    page,
  }) => {
    const now = Date.now();
    const searchHistoryResults = Array.from(
      { length: VIRTUALIZED_ENTRY_COUNT },
      (_, i) => ({
        url: `https://example.com/search-reopen-${i}`,
        title: `Search reopen ${i}`,
        timestamp: now - i * 1000,
        score: 1,
      }),
    );

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [
          {
            url: 'https://example.com/search-reopen-loaded-decoy',
            title: 'Loaded decoy',
            timestamp: now,
            deviceId: 'device-a',
          },
        ],
        searchHistoryResults,
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length > 0,
      );

      await commitDesktopSearch(page, 'Search reopen');
      await page.waitForFunction(
        ({ expected }) =>
          Number(
            document.getElementById('relatedResults').dataset.searchCount || 0,
          ) >= expected,
        { expected: searchHistoryResults.length },
      );

      const before = await page.evaluate(async () => {
        const main = document.querySelector('.main');
        main.scrollTop = 1600;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const mainTop = main.getBoundingClientRect().top;
        const firstVisible = [...document.querySelectorAll('.result-row')].find(
          (row) => row.getBoundingClientRect().bottom > mainTop + 1,
        );
        return {
          scrollTop: main.scrollTop,
          firstUrl: firstVisible?.dataset.url || '',
        };
      });
      const searchInvocationsBeforeReopen = await page.evaluate(() =>
        window.__desktopVisualHarness.searchHistoryInvocationCount(),
      );

      await expectNoHistorySearchDuringVisibilityRefresh(
        page,
        searchInvocationsBeforeReopen,
        () =>
          page.evaluate(() => {
            const input = document.getElementById('searchDraftInput');
            input.blur();
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              value: 'hidden',
            });
            document.dispatchEvent(new Event('visibilitychange'));
            Object.defineProperty(document, 'visibilityState', {
              configurable: true,
              value: 'visible',
            });
            document.dispatchEvent(new Event('visibilitychange'));
            input.focus({ preventScroll: true });
          }),
      );
      await expect(
        page.locator(`.result-row[data-url="${before.firstUrl}"]`),
      ).toBeVisible();
      await page.evaluate((scrollTop) => {
        document.querySelector('.main').scrollTop = scrollTop;
      }, before.scrollTop);

      await expectNoHistorySearchDuringVisibilityRefresh(
        page,
        searchInvocationsBeforeReopen,
        () =>
          page.evaluate(
            ({ now }) => {
              const main = document.querySelector('.main');
              Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                value: 'hidden',
              });
              document.dispatchEvent(new Event('visibilitychange'));
              main.dataset.previousDisplay = main.style.display;
              main.style.display = 'none';
              window.__desktopVisualHarness.appendHistoryEntry({
                url: 'https://example.com/search-reopen-new',
                title: 'Search reopen new',
                timestamp: now + 10_000,
                deviceId: 'device-a',
              });
              Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                value: 'visible',
              });
              document.dispatchEvent(new Event('visibilitychange'));
              setTimeout(() => {
                main.style.display = main.dataset.previousDisplay || '';
              }, 50);
            },
            { now },
          ),
      );
      await page.waitForFunction(() => {
        const related = document.getElementById('relatedResults');
        return (
          Number(related?.dataset.searchCount || 0) > 0 &&
          document.querySelectorAll('#relatedResults .result-row').length > 0
        );
      });
      await page.waitForFunction(
        () => document.querySelector('.main')?.clientHeight > 0,
      );

      const after = await page.evaluate(() => {
        const main = document.querySelector('.main');
        const mainTop = main.getBoundingClientRect().top;
        const firstVisible = [...document.querySelectorAll('.result-row')].find(
          (row) => row.getBoundingClientRect().bottom > mainTop + 1,
        );
        return {
          scrollTop: main.scrollTop,
          maxScroll: main.scrollHeight - main.clientHeight,
          firstUrl: firstVisible?.dataset.url || '',
        };
      });
      expect(after.firstUrl).toBe(before.firstUrl);
      expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(
        120,
      );
      expect(after.scrollTop).toBeLessThan(after.maxScroll - 200);
    });
  });

  test('entering a search query from a short top view keeps results at the top', async ({
    page,
  }) => {
    const now = Date.now();
    const searchHistoryResults = Array.from(
      { length: VIRTUALIZED_ENTRY_COUNT },
      (_, i) => ({
        url: `https://example.com/search-enter-${i}`,
        title: `Search enter ${i}`,
        timestamp: now - i * 1000,
        score: 1,
      }),
    );

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [
          {
            url: 'https://example.com/short-before-search',
            title: 'Short before search',
            timestamp: now,
            deviceId: 'device-a',
          },
        ],
        searchHistoryResults,
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length > 0,
      );

      const before = await page.evaluate(() => {
        const main = document.querySelector('.main');
        return {
          scrollTop: main.scrollTop,
          maxScroll: main.scrollHeight - main.clientHeight,
        };
      });
      expect(before.scrollTop).toBe(0);
      expect(before.maxScroll).toBe(0);

      await commitDesktopSearch(page, 'Search enter');
      await expect(
        page.locator('.result-row .result-title').first(),
      ).toHaveText('Search enter 0');
      await page.waitForFunction(
        () => {
          const main = document.querySelector('.main');
          return main && main.scrollHeight - main.clientHeight > 1000;
        },
        null,
        { timeout: 5000 },
      );

      const after = await page.evaluate(() => {
        const main = document.querySelector('.main');
        return {
          scrollTop: main.scrollTop,
          maxScroll: main.scrollHeight - main.clientHeight,
          firstTitle: document
            .querySelector('.result-row .result-title')
            ?.textContent?.trim(),
        };
      });
      expect(after.maxScroll).toBeGreaterThan(1000);
      expect(after.scrollTop).toBe(0);
      expect(after.firstTitle).toBe('Search enter 0');
    });
  });

  test('search does not append unrelated history after matching results', async ({
    page,
  }) => {
    const now = Date.now();
    const searchHistoryResults = [
      {
        url: 'https://example.com/canon-result-one',
        title: 'Canon result one',
        timestamp: now - 1000,
        score: 2,
      },
      {
        url: 'https://example.com/canon-result-two',
        title: 'Canon result two',
        timestamp: now - 2000,
        score: 2,
      },
    ];

    await serveDesktopUi(async (desktopUrl) => {
      await openDesktopUi(page, desktopUrl, {
        setupComplete: true,
        colorScheme: 'amber',
        historyEntries: [
          {
            url: 'https://example.com/irrelevant-before-search',
            title: 'Irrelevant before search',
            timestamp: now,
            deviceId: 'device-a',
          },
        ],
        searchHistoryResults,
      });
      await page.waitForFunction(
        () => document.querySelectorAll('.result-row').length > 0,
      );

      await commitDesktopSearch(page, 'Canon');
      await page.waitForFunction(
        ({ expected }) =>
          Number(
            document.getElementById('relatedResults').dataset.searchCount || 0,
          ) === expected,
        { expected: searchHistoryResults.length },
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => document.getElementById('relatedResults')._virtualScroller,
          ),
        )
        .toBe(null);

      const resultTitles = await page.evaluate(() => {
        return [
          ...document.querySelectorAll('#relatedResults .result-title'),
        ].map((item) => item.textContent.trim());
      });
      expect(resultTitles).toEqual(['Canon result one', 'Canon result two']);
    });
  });
});
