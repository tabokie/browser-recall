import { test, expect } from './fixtures.js';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { stageDesktopUiAssets } from '../../scripts/stage-app-assets.mjs';
import { SUPPORTED_LOCALES } from '../../packages/core/i18n.js';
import { openHelperPage, resetAndSeed } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '../..');
const desktopUiDir = path.join(repoRoot, 'dist/desktop/ui');

function localeMessage(locale, key) {
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(
        repoRoot,
        'packages',
        'core',
        'locales',
        locale,
        'messages.json',
      ),
      'utf8',
    ),
  );
  return catalog[key].message;
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function serveDesktopUi(use) {
  stageDesktopUiAssets(desktopUiDir);
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent(
      new URL(request.url, 'http://127.0.0.1').pathname,
    );
    const relativePath = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const resolved = path.resolve(desktopUiDir, relativePath);
    if (!resolved.startsWith(desktopUiDir + path.sep)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type':
        MIME_TYPES[path.extname(resolved)] || 'application/octet-stream',
    });
    fs.createReadStream(resolved).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await use(`http://127.0.0.1:${server.address().port}/index.html`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function installDesktopShellBridge(page, helper, setupDir) {
  await page.exposeFunction(
    '__invokeDesktopShell',
    async (command, payload = {}) => {
      if (command !== 'bridge_action') {
        if (command === 'search_history_stream') return { success: true };
        if (command === 'cancel_history_search') return { success: true };
        throw new Error(`Unhandled desktop shell command: ${command}`);
      }

      const request = payload.request || {};
      if (
        request.action === 'getDeviceId' ||
        request.action === 'readDesktopValue' ||
        request.action === 'saveSettingsKey'
      ) {
        return helper.evaluate(
          (message) => chrome.runtime.sendMessage(message),
          request,
        );
      }

      switch (request.action) {
        case 'getDesktopSystemLocale':
          return { success: true, locale: 'zh-CN' };
        case 'getDirectoryInfo':
          return {
            success: true,
            info: { name: setupDir, hasPermission: true },
          };
        case 'getDesktopConnectorState':
          return {
            success: true,
            state: 'connected',
            dataFolder: setupDir,
            pendingCommands: 0,
            pendingBytes: 0,
          };
        case 'getDesktopShellState':
          return {
            success: true,
            setupComplete: true,
            dataDir: setupDir,
            pairedBrowsers: [],
            debugLogging: false,
            launchAtLogin: false,
            loginItemSupported: false,
          };
        case 'getSyncAuthState':
          return { success: true, hasToken: false, rememberToken: false };
        case 'listHistoryFiles':
          return { success: true, files: [], sizes: {}, devices: [] };
        case 'loadHistoryBatch':
          return { success: true, entries: [] };
        case 'loadAllPages':
          return { success: true, pages: {} };
        case 'searchNotes':
        case 'searchSnapshots':
          return { success: true, results: [] };
        default:
          return { success: true };
      }
    },
  );

  await page.addInitScript(() => {
    const stores = {
      session: new Map(),
      local: new Map(),
    };
    const listeners = new Map();
    const clone = (value) =>
      value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const storeFor = (areaName) => stores[areaName] || stores.session;

    function storageGet(request = {}) {
      const store = storeFor(request.areaName);
      const keys = request.keys ?? [...store.keys()];
      return Object.fromEntries(
        keys
          .filter((key) => store.has(key))
          .map((key) => [key, clone(store.get(key))]),
      );
    }

    function storageSet(request = {}) {
      const store = storeFor(request.areaName);
      return Object.fromEntries(
        Object.entries(request.items || {}).map(([key, value]) => {
          const change = {
            oldValue: clone(store.get(key)),
            newValue: clone(value),
          };
          store.set(key, clone(value));
          return [key, change];
        }),
      );
    }

    function storageRemove(request = {}) {
      const store = storeFor(request.areaName);
      return Object.fromEntries(
        (request.keys || []).map((key) => {
          const change = {
            oldValue: clone(store.get(key)),
            newValue: null,
          };
          store.delete(key);
          return [key, change];
        }),
      );
    }

    window.__TAURI__ = {
      core: {
        invoke(command, payload = {}) {
          if (command === 'bridge_storage_get')
            return storageGet(payload.request);
          if (command === 'bridge_storage_set')
            return storageSet(payload.request);
          if (command === 'bridge_storage_remove')
            return storageRemove(payload.request);
          if (command === 'bridge_storage_clear') {
            const store = storeFor(payload.request?.areaName);
            const changes = storageRemove({
              areaName: payload.request?.areaName,
              keys: [...store.keys()],
            });
            return changes;
          }
          if (command === 'bridge_storage_broadcast') return {};
          return window.__invokeDesktopShell(command, payload);
        },
      },
      event: {
        async listen(eventName, handler) {
          const handlers = listeners.get(eventName) || [];
          handlers.push(handler);
          listeners.set(eventName, handlers);
          return () => {
            listeners.set(
              eventName,
              (listeners.get(eventName) || []).filter(
                (candidate) => candidate !== handler,
              ),
            );
          };
        },
      },
    };
  });
}

test('desktop locale choices persist across real daemon checkpoints and reloads', async ({
  extContext,
  extensionId,
  setupDir,
}) => {
  await resetAndSeed(extContext, extensionId, []);
  const helper = await openHelperPage(extContext, extensionId);
  const page = await extContext.newPage();

  try {
    await installDesktopShellBridge(page, helper, setupDir);
    await serveDesktopUi(async (desktopUrl) => {
      await page.goto(desktopUrl);
      await page.waitForFunction(() => document.body.dataset.ready === 'true');

      await page.locator('#settingsBtn').click();
      await expect(page.locator('#settingsTitle')).toHaveText('设置');
      await expect(page.locator('#localeSelect')).toHaveValue('system');
      expect(
        await page.locator('#localeSelect option').evaluateAll((options) =>
          options.map((option) => ({
            value: option.value,
            label: option.textContent.trim(),
          })),
        ),
      ).toEqual([
        { value: 'system', label: '系统' },
        ...SUPPORTED_LOCALES.map(({ code, nativeName }) => ({
          value: code,
          label: nativeName,
        })),
      ]);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.locator('#localeSelect').selectOption('en'),
      ]);
      await page.waitForFunction(() => document.body.dataset.ready === 'true');

      const settingsPath = path.join(
        setupDir,
        'views',
        'manifest',
        'settings.json',
      );
      await expect
        .poll(() => {
          if (!fs.existsSync(settingsPath)) return null;
          return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
            .localeOverride;
        })
        .toBe('en');

      await page.locator('#settingsBtn').click();
      await expect(page.locator('#settingsTitle')).toHaveText('Settings');
      await expect(page.locator('#localeSelect')).toHaveValue('en');

      for (const { code } of SUPPORTED_LOCALES.filter(
        (locale) => locale.code !== 'en',
      )) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          page.locator('#localeSelect').selectOption(code),
        ]);
        await page.waitForFunction(
          () => document.body.dataset.ready === 'true',
        );
        await expect
          .poll(
            () =>
              JSON.parse(fs.readFileSync(settingsPath, 'utf8')).localeOverride,
          )
          .toBe(code);
        await page.locator('#settingsBtn').click();
        await expect(page.locator('#settingsTitle')).toHaveText(
          localeMessage(code, 'commonSettings'),
        );
        await expect(page.locator('#localeSelect')).toHaveValue(code);
        await expect(page.locator('html')).toHaveAttribute('lang', code);
        await expect(page.locator('html')).toHaveAttribute(
          'dir',
          code === 'ar' ? 'rtl' : 'ltr',
        );
      }
    });
  } finally {
    await page.close();
    await helper.close();
  }
});

test('desktop reports an invalid persisted locale instead of masking it', async ({
  extContext,
  extensionId,
  setupDir,
}) => {
  await resetAndSeed(extContext, extensionId, [
    {
      path: 'views/manifest/settings.json',
      data: { localeOverride: 'xx-invalid' },
    },
  ]);
  const helper = await openHelperPage(extContext, extensionId);
  const page = await extContext.newPage();

  try {
    await installDesktopShellBridge(page, helper, setupDir);
    await serveDesktopUi(async (desktopUrl) => {
      await page.goto(desktopUrl);
      await expect(
        page.getByText('Unsupported locale override: xx-invalid'),
      ).toBeVisible();
    });
  } finally {
    await page.close();
    await helper.close();
  }
});
