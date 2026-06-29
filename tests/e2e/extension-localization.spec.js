import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect, test } from './fixtures.js';

import {
  cleanupTestExtensionDir,
  createTestExtensionDir,
} from '../fixtures/test-extension.mjs';
import {
  waitForDesktopConnector,
  waitForExtensionId,
} from '../../scripts/lib/desktop-test-runtime.mjs';
import { openHelperPage, resetAndSeed } from './helpers.js';

const TARGET_LOCALE = 'ja';

async function stopBrowserProcess(browserProcess) {
  if (
    !browserProcess ||
    browserProcess.exitCode !== null ||
    browserProcess.signalCode !== null
  ) {
    return;
  }
  await new Promise((resolve) => {
    let forceTimer;
    let completionTimer;
    const done = () => {
      clearTimeout(forceTimer);
      clearTimeout(completionTimer);
      browserProcess.off('exit', done);
      resolve();
    };
    browserProcess.on('exit', done);
    forceTimer = setTimeout(() => {
      if (
        browserProcess.exitCode === null &&
        browserProcess.signalCode === null
      ) {
        browserProcess.kill('SIGKILL');
      }
    }, 1000);
    completionTimer = setTimeout(done, 2000);
    browserProcess.kill();
  });
}

async function launchLocalizedExtension(
  extensionDir,
  userDataDir,
  {
    connectOverCDP = (...args) => chromium.connectOverCDP(...args),
    onProcess = () => {},
  } = {},
) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    `--lang=${TARGET_LOCALE}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
  ];
  if (process.platform === 'darwin') {
    // Chromium on macOS needs both switches for extension catalog selection;
    // --lang alone can report Japanese while still loading the system catalog.
    args.push('-AppleLanguages', `(${TARGET_LOCALE})`);
  }
  const browserProcess = spawn(chromium.executablePath(), args, {
    env: {
      ...process.env,
      LANG: 'ja_JP.UTF-8',
      LANGUAGE: TARGET_LOCALE,
      LC_ALL: 'ja_JP.UTF-8',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  onProcess(browserProcess);
  let stderr = '';
  browserProcess.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(portFile)) {
      if (browserProcess.exitCode !== null) {
        throw new Error(`Localized Chromium exited early: ${stderr}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out starting localized Chromium: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [port, websocketPath] = fs
      .readFileSync(portFile, 'utf8')
      .trim()
      .split('\n');
    const browser = await connectOverCDP(
      `ws://127.0.0.1:${port}${websocketPath}`,
    );
    return {
      browser,
      browserProcess,
      context: browser.contexts()[0],
    };
  } catch (error) {
    await stopBrowserProcess(browserProcess);
    throw error;
  }
}

test('localized extension startup stops Chromium when CDP attachment fails', async () => {
  const extensionDir = createTestExtensionDir(
    'browser-recall-localized-startup-failure-',
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-ja-failed-profile-'),
  );
  let launched;
  let browserProcess;

  try {
    await expect(async () => {
      launched = await launchLocalizedExtension(extensionDir, userDataDir, {
        connectOverCDP: async () => {
          throw new Error('forced CDP attachment failure');
        },
        onProcess: (process) => {
          browserProcess = process;
        },
      });
    }).rejects.toThrow('forced CDP attachment failure');
    expect(browserProcess).toBeDefined();
    await expect
      .poll(
        () =>
          browserProcess.exitCode !== null ||
          browserProcess.signalCode !== null,
      )
      .toBe(true);
  } finally {
    await launched?.browser.close().catch(() => {});
    await stopBrowserProcess(browserProcess);
    cleanupTestExtensionDir(extensionDir);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

// Keep this on the packaged extension and assert @@ui_locale plus rendered UI.
// Stubbing chrome.i18n does not cover the browser's catalog selection.
test('packaged extension renders a real Japanese popup workflow', async ({
  daemon,
  localServer,
}) => {
  const extensionDir = createTestExtensionDir(
    'browser-recall-localized-extension-',
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-ja-profile-'),
  );
  let browser;
  let browserProcess;

  try {
    const launched = await launchLocalizedExtension(extensionDir, userDataDir);
    ({ browser, browserProcess } = launched);
    const { context } = launched;
    const extensionId = await waitForExtensionId(context);
    await waitForDesktopConnector(context, extensionId, daemon.port);
    await resetAndSeed(context, extensionId, []);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-helper.html`);

    const localized = await page.evaluate(() => ({
      locale: chrome.i18n.getMessage('@@ui_locale'),
      addPageNote: chrome.i18n.getMessage('extensionAddPageNote'),
    }));
    const catalog = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'packages/core/locales',
          TARGET_LOCALE,
          'messages.json',
        ),
        'utf8',
      ),
    );

    expect(localized.locale.replaceAll('_', '-')).toBe(TARGET_LOCALE);
    expect(localized.addPageNote).toBe(catalog.extensionAddPageNote.message);

    localServer.addPage('/localized-extension', {
      title: 'Localized Extension',
      body: '<main>Localized extension workflow</main>',
    });
    const pageUrl = localServer.url('/localized-extension');
    const contentPage = await context.newPage();
    await contentPage.goto(pageUrl);
    await contentPage.bringToFront();
    const helper = await openHelperPage(context, extensionId);
    const prepared = await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.runtime.sendMessage({
        action: 'preparePopupBootstrapForTest',
        tabId: tab.id,
      });
    }, pageUrl);
    expect(prepared.success).toBe(true);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/${prepared.popupPath}`);
    await expect(popup.locator('#dashboard')).toBeVisible();
    await expect(popup.locator('#pageNoteAddBtn')).toHaveText(
      catalog.extensionAddPageNote.message,
    );
  } finally {
    await browser?.close().catch(() => {});
    await stopBrowserProcess(browserProcess);
    cleanupTestExtensionDir(extensionDir);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
