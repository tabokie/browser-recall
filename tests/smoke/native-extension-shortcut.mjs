import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium, expect } from '@playwright/test';

import {
  cleanupTestExtensionDir,
  createTestExtensionDir,
} from '../fixtures/test-extension.mjs';
import {
  startDaemon,
  waitForDesktopConnector,
  waitForExtensionId,
} from '../../scripts/lib/desktop-test-runtime.mjs';

// Dispatching commands.onCommand directly covers only our handler. A headed
// browser plus native input is required to cover Chromium's shortcut boundary.
if (process.platform !== 'darwin') {
  throw new Error('Native extension shortcut smoke currently requires macOS');
}

function browserProcessId(userDataDir) {
  const candidates = execFileSync('/usr/bin/pgrep', ['-f', userDataDir], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(Number.isSafeInteger);
  for (const pid of candidates) {
    const command = execFileSync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'command='],
      {
        encoding: 'utf8',
      },
    );
    if (!command.includes('--type=')) return pid;
  }
  throw new Error('Could not identify the Playwright browser process');
}

function installedChromiumBinary() {
  const configured = chromium.executablePath();
  if (fs.existsSync(configured)) return configured;
  const cacheRoot = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const candidates = fs
    .readdirSync(cacheRoot)
    .filter((entry) => entry.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const entry of candidates) {
    const executable = path.join(
      cacheRoot,
      entry,
      process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
    if (fs.existsSync(executable)) return executable;
  }
  throw new Error('No installed Playwright Chromium binary is available');
}

function pressNativeAltR(pid) {
  execFileSync('/usr/bin/osascript', [
    '-e',
    `tell application "System Events"
      set frontmost of first process whose unix id is ${pid} to true
      delay 0.3
      key code 15 using option down
    end tell`,
  ]);
}

function pressNativeKey(pid, code) {
  execFileSync('/usr/bin/osascript', [
    '-e',
    `tell application "System Events"
      set frontmost of first process whose unix id is ${pid} to true
      key code ${code}
    end tell`,
  ]);
}

function stageFirstRevealProbe(extensionDir) {
  const popupPath = path.join(extensionDir, 'popup.html');
  const markup = fs.readFileSync(popupPath, 'utf8');
  const marker = '<meta charset="UTF-8" />';
  if (!markup.includes(marker)) {
    throw new Error('Could not install popup first-reveal probe');
  }
  fs.writeFileSync(
    popupPath,
    markup.replace(
      marker,
      `${marker}\n    <script src="first-reveal-probe.js"></script>`,
    ),
  );
  fs.writeFileSync(
    path.join(extensionDir, 'first-reveal-probe.js'),
    `globalThis.__browserRecallFirstReveal = null;
new MutationObserver(() => {
  const root = document.documentElement;
  if (!root || root.hasAttribute('data-popup-hidden')) return;
  if (globalThis.__browserRecallFirstReveal) return;
  globalThis.__browserRecallFirstReveal = {
    title: document.getElementById('pageTitle')?.textContent,
    width: document.body.getBoundingClientRect().width,
    height: document.body.getBoundingClientRect().height,
    opacity: getComputedStyle(root).opacity,
  };
}).observe(document, { subtree: true, childList: true, attributes: true });\n`,
  );
}

async function waitForPopup(helper) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await helper.evaluate(() => {
      const popup = chrome.extension.getViews({ type: 'popup' })[0];
      return popup
        ? {
            href: popup.location.href,
            ready:
              popup.document.documentElement.dataset.popupHidden === undefined,
            title:
              popup.document.getElementById('pageTitle')?.textContent || '',
            firstReveal: popup.__browserRecallFirstReveal || null,
            height: popup.document.body.getBoundingClientRect().height,
          }
        : null;
    });
    if (result?.ready) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Alt+R did not open an extension action popup');
}

const extensionDir = createTestExtensionDir(
  'browser-recall-native-shortcut-extension-',
);
const userDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'browser-recall-native-shortcut-profile-'),
);
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><title>Native Alt R</title><main>Native shortcut target</main>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

let context;
let daemon;
try {
  stageFirstRevealProbe(extensionDir);
  daemon = await startDaemon();
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: installedChromiumBinary(),
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  const extensionId = await waitForExtensionId(context);
  await waitForDesktopConnector(context, extensionId);
  const target = await context.newPage();
  const address = server.address();
  await target.goto(`http://127.0.0.1:${address.port}/native-alt-r`);
  await target.bringToFront();
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/test-helper.html`);
  const commands = await helper.evaluate(() => chrome.commands.getAll());
  const openPopupCommand = commands.find(
    (command) => command.name === 'open-popup',
  );
  if (!['Alt+R', '⌥R'].includes(openPopupCommand?.shortcut)) {
    throw new Error(
      `Chromium did not assign Alt+R: ${JSON.stringify(openPopupCommand)}`,
    );
  }
  await target.bringToFront();

  const browserPid = browserProcessId(userDataDir);
  pressNativeAltR(browserPid);
  const popup = await waitForPopup(helper);
  if (!popup.href.includes('popup.html?bootstrap=')) {
    throw new Error(`Alt+R opened the wrong extension surface: ${popup.href}`);
  }
  if (popup.title !== 'Native Alt R') {
    throw new Error(`Alt+R popup targeted the wrong page: ${popup.title}`);
  }
  if (
    popup.firstReveal?.title !== 'Native Alt R' ||
    popup.firstReveal.width !== 296 ||
    !(popup.firstReveal.height > 0) ||
    popup.firstReveal.height !== popup.height ||
    popup.firstReveal.opacity !== '1'
  ) {
    throw new Error(
      `Alt+R first popup reveal was incomplete or resized: ${JSON.stringify(popup)}`,
    );
  }
  console.log(`Native Alt+R opened ${popup.href}`);
  const popupState = () =>
    helper.evaluate(() => {
      const popup = chrome.extension.getViews({ type: 'popup' })[0];
      return popup
        ? {
            searchOpen: Boolean(
              popup.document.querySelector('#listPickerHost.list-picker'),
            ),
            query: popup.document.getElementById('listSearchInput')?.value,
          }
        : null;
    });
  pressNativeKey(browserPid, 15); // R opens list search in the already focused toolbar popup.
  await expect.poll(popupState).toEqual({ searchOpen: true, query: 'r' });
  pressNativeKey(browserPid, 53); // Escape exits search; the native popup must survive.
  await expect.poll(popupState).toEqual({ searchOpen: false, query: '' });
  pressNativeKey(browserPid, 15);
  await expect.poll(popupState).toEqual({ searchOpen: true, query: 'r' });
  pressNativeKey(browserPid, 53);
  await expect.poll(popupState).toEqual({ searchOpen: false, query: '' });
  pressNativeKey(browserPid, 53); // With no search menu open, Chromium still owns Escape.
  await expect.poll(popupState).toBeNull();
  console.log('Native Escape exits list search first, then closes the popup.');
} finally {
  await context?.close().catch(() => {});
  await daemon?.stop().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  cleanupTestExtensionDir(extensionDir);
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
