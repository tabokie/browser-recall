import { test, expect, chromium } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extPath = path.join(__dirname, '../../extension');

const BROWSERS = {
  brave: {
    appName: 'Brave Browser',
    executablePath:
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    launchArgs: [
      '--enable-features=FileSystemAccessAPI',
      '--lang=en-US',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,OptimizationHints,MediaRouter',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  },
  edge: {
    appName: 'Microsoft Edge Beta',
    executablePath:
      '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
    launchArgs: ['--lang=en-US'],
  },
};

function getBrowserConfig() {
  const key = (process.env.REAL_FS_BROWSER || 'brave').toLowerCase();
  return BROWSERS[key] || null;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runAppleScript(script, args = []) {
  return execFileSync('osascript', ['-e', script, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function waitForExtensionId(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  return sw.url().split('/')[2];
}

async function openHelperPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
  await page.waitForFunction(
    () => typeof chrome !== 'undefined' && chrome.runtime,
    { timeout: 10000 },
  );
  return page;
}

async function withHelperPage(context, extensionId, fn) {
  const page = await openHelperPage(context, extensionId);
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function openOptionsPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

function openGoToFolderDialog(appName) {
  const script = `
on run argv
  set appName to item 1 of argv
  tell application appName to activate
  delay 0.5
  tell application "System Events"
    keystroke "G" using {command down, shift down}
  end tell
end run
`;
  runAppleScript(script, [appName]);
}

function pastePickerPath(appName, targetDir) {
  const script = `
on run argv
  set appName to item 1 of argv
  set targetDir to item 2 of argv
  tell application appName to activate
  delay 0.2
  tell application "System Events"
    set the clipboard to targetDir
    keystroke "v" using {command down}
  end tell
end run
`;
  runAppleScript(script, [appName, targetDir]);
}

function submitPickerPath(appName) {
  const script = `
on run argv
  set appName to item 1 of argv
  tell application appName to activate
  delay 0.2
  tell application "System Events"
    key code 36
    delay 0.7
    key code 36
  end tell
end run
`;
  runAppleScript(script, [appName]);
}

function dismissBraveTranslatePrompt(appName) {
  const script = `
on run argv
  set appName to item 1 of argv
  tell application appName to activate
  delay 0.2
  tell application "System Events"
    key code 53
  end tell
end run
`;
  runAppleScript(script, [appName]);
}

function inspectPickerState(appName) {
  const script = `
on run argv
  set appName to item 1 of argv
  tell application "System Events"
    if not (exists process appName) then return "PROCESS_MISSING"
    tell process appName
      set out to {}
      try
        set end of out to ("WINDOWS|" & ((name of every window) as text))
      end try
      try
        if (count of windows) ≥ 1 then
          set end of out to ("WINDOW1_BUTTONS|" & ((name of every button of window 1) as text))
        end if
      end try
      try
        if (count of windows) ≥ 2 then
          set end of out to ("WINDOW2_BUTTONS|" & ((name of every button of window 2) as text))
        end if
      end try
      try
        if exists sheet 1 of window 1 then
          set end of out to "SHEET|present"
          try
            set end of out to ("TEXT_FIELDS|" & ((value of every text field of sheet 1 of window 1) as text))
          end try
          try
            set end of out to ("COMBO_BOXES|" & ((value of every combo box of sheet 1 of window 1) as text))
          end try
          try
            set end of out to ("SHEET_BUTTONS|" & ((name of every button of sheet 1 of window 1) as text))
          end try
        end if
      end try
      return out
    end tell
  end tell
end run
`;
  const output = runAppleScript(script, [appName]);
  return output ? output.split(/, ?/) : [];
}

function inspectBraveUi(appName) {
  const script = `
on run argv
  set appName to item 1 of argv
  tell application "System Events"
    if not (exists process appName) then return "PROCESS_MISSING"
    tell process appName
      set out to {}
      repeat with w in windows
        try
          set end of out to ("WINDOW|" & (name of w))
        end try
        try
          set end of out to ("WINDOW_BUTTONS|" & ((name of every button of w) as text))
        end try
        try
          repeat with s in sheets of w
            set end of out to ("SHEET|" & (name of w))
            try
              set end of out to ("SHEET_BUTTONS|" & ((name of every button of s) as text))
            end try
          end repeat
        end try
      end repeat
      return out
    end tell
  end tell
end run
`;
  const output = runAppleScript(script, [appName]);
  return output ? output.split(/, ?/) : [];
}

function clickBraveButtonOnce(appName) {
  const script = `
on run argv
  set appName to item 1 of argv
  set buttonNames to {"Allow", "允许", "Open", "打开", "Choose", "选取", "OK", "确定"}
  tell application appName to activate
  delay 0.2
  tell application "System Events"
    if not (exists process appName) then return "PROCESS_MISSING"
    tell process appName
      repeat with w in windows
        try
          repeat with s in sheets of w
            repeat with btnName in buttonNames
              if exists button btnName of s then
                click button btnName of s
                return btnName as text
              end if
            end repeat
          end repeat
        end try
        try
          repeat with btnName in buttonNames
            if exists button btnName of w then
              click button btnName of w
              return btnName as text
            end if
          end repeat
        end try
        try
          repeat with g in groups of w
            repeat with btnName in buttonNames
              if exists button btnName of g then
                click button btnName of g
                return btnName as text
              end if
            end repeat
            try
              repeat with gg in groups of g
                repeat with btnName in buttonNames
                  if exists button btnName of gg then
                    click button btnName of gg
                    return btnName as text
                  end if
                end repeat
              end repeat
            end try
          end repeat
        end try
      end repeat
      return ""
    end tell
  end tell
end run
`;
  return runAppleScript(script, [appName]);
}

function clickApprovalPromptByPositionOnce(appName) {
  const script = `
on run argv
  set appName to item 1 of argv
  tell application appName to activate
  delay 0.2
  tell application "System Events"
    if not (exists process appName) then return "PROCESS_MISSING"
    tell process appName
      repeat with w in windows
        set windowName to ""
        try
          set windowName to name of w
        end try
        if windowName contains "允许此网站修改文件" or windowName contains "wants to edit files" or windowName contains "Allow this site to edit files" then
          try
            set windowPosition to position of w
            set windowSize to size of w
            set clickX to (item 1 of windowPosition) + (item 1 of windowSize) - 70
            set clickY to (item 2 of windowPosition) + (item 2 of windowSize) - 35
            click at {clickX, clickY}
            return "position:" & clickX & "," & clickY
          on error errMsg
            return "POSITION_ERROR:" & errMsg
          end try
        end if
      end repeat
      return ""
    end tell
  end tell
end run
`;
  return runAppleScript(script, [appName]);
}

function hasNativeApprovalPrompt(nativeUi) {
  return nativeUi.some(
    (entry) =>
      entry.includes('允许此网站修改文件') ||
      entry.includes('wants to edit files') ||
      entry.includes('Allow this site to edit files'),
  );
}

async function waitForOnboardingReadyOrApprovePrompt(optionsPage, appName) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pageState = await optionsPage.evaluate(() => {
      const startBtn = document.getElementById('onboardingStartBtn');
      const dirStatus = document.getElementById('onboardingDirStatus');
      const startStyle = startBtn ? getComputedStyle(startBtn) : null;
      const startVisible =
        !!startBtn &&
        !!startStyle &&
        startStyle.display !== 'none' &&
        startStyle.visibility !== 'hidden' &&
        startBtn.getClientRects().length > 0;
      return {
        startVisible,
        dirStatusText: dirStatus?.textContent?.trim() || '',
      };
    });
    if (pageState.startVisible || pageState.dirStatusText) {
      return pageState;
    }

    const nativeUi = inspectBraveUi(appName);
    if (hasNativeApprovalPrompt(nativeUi)) {
      console.log(
        `[real-fs] native approval prompt detected: ${JSON.stringify(nativeUi)}`,
      );
      const clicked = clickBraveButtonOnce(appName);
      if (clicked) {
        console.log(`[real-fs] clicked native button: ${clicked}`);
        await waitMs(1000);
      } else {
        const coordinateClick = clickApprovalPromptByPositionOnce(appName);
        console.log(
          `[real-fs] native approval prompt coordinate click: ${coordinateClick}`,
        );
        await waitMs(1000);
        const afterClickUi = inspectBraveUi(appName);
        if (hasNativeApprovalPrompt(afterClickUi)) {
          throw new Error(
            `Native approval prompt remained after coordinate click: ${JSON.stringify(afterClickUi)}`,
          );
        }
      }
    }

    await waitMs(500);
  }

  return await optionsPage.evaluate(() => {
    const startBtn = document.getElementById('onboardingStartBtn');
    const dirStatus = document.getElementById('onboardingDirStatus');
    const startStyle = startBtn ? getComputedStyle(startBtn) : null;
    const startVisible =
      !!startBtn &&
      !!startStyle &&
      startStyle.display !== 'none' &&
      startStyle.visibility !== 'hidden' &&
      startBtn.getClientRects().length > 0;
    return {
      startVisible,
      dirStatusText: dirStatus?.textContent?.trim() || '',
    };
  });
}

async function initializeOnboarding(optionsPage, appName) {
  const startBtn = optionsPage.locator('#onboardingStartBtn');
  const dirStatus = optionsPage.locator('#onboardingDirStatus');
  let pageState;
  try {
    pageState = await waitForOnboardingReadyOrApprovePrompt(optionsPage, appName);
  } catch (error) {
    const nativeUi = inspectBraveUi(appName);
    throw new Error(
      `Onboarding did not advance after directory pick. Native UI: ${JSON.stringify(nativeUi)}`,
      { cause: error },
    );
  }

  const dirStatusText = pageState.dirStatusText || '';
  if (dirStatusText) {
    throw new Error(`Directory selection failed: ${dirStatusText}`);
  }

  if (!pageState.startVisible) {
    const nativeUi = inspectBraveUi(appName);
    throw new Error(
      `Onboarding did not become ready after directory pick. Native UI: ${JSON.stringify(nativeUi)}`,
    );
  }

  console.log('[real-fs] directory selected, onboarding ready');
  await expect(startBtn).toBeVisible({ timeout: 5000 });
  await startBtn.click();
  await optionsPage.waitForFunction(
    () => document.body.dataset.ready === 'true',
    { timeout: 15000 },
  );
  await expect(optionsPage.locator('.sidebar')).toBeVisible({ timeout: 15000 });
  console.log('[real-fs] onboarding completed');
}

async function pickDirectory(optionsPage, appName, targetDir) {
  const pickerMode = (process.env.REAL_FS_PICKER || 'auto').toLowerCase();

  console.log(`[real-fs] opening picker for ${targetDir}`);
  await optionsPage.locator('#onboardingDirBtn').click();

  if (pickerMode === 'manual') {
    console.log(
      `[real-fs] Manual picker mode. Choose this directory in the browser dialog: ${targetDir}`,
    );
    return;
  }

  await waitMs(300);
  openGoToFolderDialog(appName);
  await waitMs(700);
  const pickerBeforePaste = inspectPickerState(appName);
  console.log(
    `[real-fs] picker state before paste: ${JSON.stringify(pickerBeforePaste)}`,
  );
  const windowsBeforePaste = pickerBeforePaste.find((entry) =>
    entry.startsWith('WINDOWS|'),
  );
  if (windowsBeforePaste?.includes('翻译此页？')) {
    dismissBraveTranslatePrompt(appName);
    await waitMs(700);
    console.log(
      `[real-fs] picker state after dismissing translate prompt: ${JSON.stringify(
        inspectPickerState(appName),
      )}`,
    );
  }

  pastePickerPath(appName, targetDir);
  await waitMs(700);

  const pickerAfterPaste = inspectPickerState(appName);
  console.log(
    `[real-fs] picker state after paste: ${JSON.stringify(pickerAfterPaste)}`,
  );

  submitPickerPath(appName);
  await waitMs(1200);

  const nativeUiAfterSubmit = inspectBraveUi(appName);
  console.log(
    `[real-fs] native ui after picker submit: ${JSON.stringify(nativeUiAfterSubmit)}`,
  );
}


async function probeFilesystem(context, extensionId, step) {
  const url = `https://example.com/real-fs-repro-${step}`;
  return await withHelperPage(context, extensionId, async (helper) => {
    const pageResult = await helper.evaluate(
      async ({ url, step }) =>
        await chrome.runtime.sendMessage({
          action: 'reportPage',
          url,
          title: `Real FS Probe ${step}`,
          isInitialLoad: true,
        }),
      { url, step },
    );

    const flushResult = await helper.evaluate(
      async () => await chrome.runtime.sendMessage({ action: 'flushLogBuffer' }),
    );

    const dirInfo = await helper.evaluate(
      async () => await chrome.runtime.sendMessage({ action: 'getDirectoryInfo' }),
    );

    const serviceError = await helper.evaluate(
      async () =>
        (await chrome.storage.session.get('serviceError')).serviceError || null,
    );

    return { pageResult, flushResult, dirInfo, serviceError };
  });
}

function getRealVisitUrls() {
  if (process.env.REAL_FS_REAL_URLS) {
    return process.env.REAL_FS_REAL_URLS.split(',')
      .map((url) => url.trim())
      .filter(Boolean);
  }

  return [
    'https://example.com/',
    'https://example.org/',
    'https://en.wikipedia.org/wiki/Web_browser',
  ];
}

async function getActiveTabInfo(context, extensionId) {
  return await withHelperPage(context, extensionId, async (helper) => {
    return await helper.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab
        ? { id: tab.id, url: tab.url || '', title: tab.title || '' }
        : null;
    });
  });
}

async function waitForActiveTabUrl(context, extensionId, expectedUrl, phase) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const activeTab = await getActiveTabInfo(context, extensionId);
    if (activeTab?.url === expectedUrl) {
      return activeTab;
    }
    await waitMs(250);
  }

  const activeTab = await getActiveTabInfo(context, extensionId);
  throw new Error(
    `Active tab did not match visited page during ${phase}: expected ${expectedUrl}, got ${JSON.stringify(activeTab)}`,
  );
}

function dismissPopupWithEscape(appName) {
  const script = `
on run argv
  set appName to item 1 of argv
  tell application appName to activate
  delay 0.2
  tell application "System Events"
    key code 53
  end tell
end run
`;
  runAppleScript(script, [appName]);
}

async function openAndDismissPopup(context, extensionId, appName, phase) {
  const openResult = await withHelperPage(context, extensionId, async (helper) => {
    return await helper.evaluate(async () => {
      if (!chrome.action?.openPopup) {
        return { success: false, error: 'chrome.action.openPopup is unavailable' };
      }
      try {
        await chrome.action.openPopup();
        return { success: true };
      } catch (error) {
        return { success: false, error: error?.message || String(error) };
      }
    });
  });
  if (!openResult?.success) {
    throw new Error(
      `Could not open action popup for ${phase}: ${JSON.stringify(openResult)}`,
    );
  }
  console.log(`[real-fs] opened popup for ${phase}`);
  await waitMs(700);
  dismissPopupWithEscape(appName);
  await waitMs(500);
  console.log(`[real-fs] dismissed popup for ${phase}`);
}

async function assertHistoryContainsBatch(
  context,
  extensionId,
  visits,
  phase,
) {
  const options = await openOptionsPage(context, extensionId);
  console.log(`[real-fs] opened options for ${phase} history check`);
  try {
    await options.waitForFunction(
      ({ urls }) =>
        urls.every((url) =>
          Array.from(document.querySelectorAll('.result-row')).some(
            (row) => row.dataset.url === url,
          ),
        ),
      { urls: visits.map((visit) => visit.url) },
      { timeout: 15000 },
    );
    const historyState = await options.evaluate(({ urls }) => {
      return urls.map((url) => {
        const row = Array.from(document.querySelectorAll('.result-row')).find(
          (candidate) => candidate.dataset.url === url,
        );
        const item = row?.closest('.result-item');
        return {
          url,
          found: !!row,
          titleText: row?.querySelector('.result-title')?.textContent?.trim() || '',
          siteText: row?.querySelector('.result-site')?.textContent?.trim() || '',
          itemText: item?.textContent?.trim() || '',
        };
      });
    }, { urls: visits.map((visit) => visit.url) });
    console.log(
      `[real-fs] options history state for ${phase}: ${JSON.stringify(historyState)}`,
    );
    for (const visit of visits) {
      const rowState = historyState.find((row) => row.url === visit.url);
      if (!rowState?.found) {
        throw new Error(
          `Visited page missing from options history during ${phase}: ${visit.url}`,
        );
      }
      if (visit.title && !rowState.itemText.includes(visit.title)) {
        throw new Error(
          `Visited page title mismatch in options during ${phase}: expected ${visit.title}, got ${JSON.stringify(rowState)}`,
        );
      }
    }
  } finally {
    await options.close().catch(() => {});
    console.log(`[real-fs] closed options for ${phase} history check`);
  }
}

async function visitPages(context, extensionId, appName, phase) {
  const urls = getRealVisitUrls();
  console.log(`[real-fs] opening tabs for ${phase}: ${JSON.stringify(urls)}`);
  const visits = [];
  for (const [index, url] of urls.entries()) {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await page.bringToFront();
    const visitedUrl = page.url();
    const activeTab = await waitForActiveTabUrl(
      context,
      extensionId,
      visitedUrl,
      `${phase}-${index + 1}`,
    );

    await waitMs(1500);
    await openAndDismissPopup(
      context,
      extensionId,
      appName,
      `${phase}-${index + 1}`,
    );
    visits.push({ url: visitedUrl, title: activeTab.title || '' });
    await page.close();
  }
  await assertHistoryContainsBatch(context, extensionId, visits, phase);
  return visits;
}

async function openAnchorPage(context) {
  const page = await context.newPage();
  await page.goto('https://example.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
  await page.bringToFront();
  console.log('[real-fs] anchor page opened');
  return page;
}

async function checkAndCloseOptionsPage(context, extensionId, phase) {
  const page = await openOptionsPage(context, extensionId);
  console.log(`[real-fs] opened options for ${phase}`);
  await page.waitForFunction(
    () => document.body.dataset.ready === 'true',
    { timeout: 15000 },
  );
  const state = await page.evaluate(() => {
    const banner = document.getElementById('serviceErrorBanner');
    const visible =
      !!banner && getComputedStyle(banner).display !== 'none' && banner.textContent;
    return {
      ready: document.body.dataset.ready === 'true',
      serviceErrorText: visible ? banner.textContent.trim() : '',
    };
  });
  console.log(`[real-fs] options state for ${phase}: ${JSON.stringify(state)}`);
  if (state.serviceErrorText) {
    throw new Error(
      `Options page shows service error during ${phase}: ${state.serviceErrorText}`,
    );
  }
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal.open', { timeout: 5000 });
  console.log(`[real-fs] opened settings modal for ${phase}`);
  await waitMs(1000);
  await page.click('#settingsClose');
  await page.waitForSelector('#settingsModal', { state: 'hidden', timeout: 5000 });
  console.log(`[real-fs] closed settings modal for ${phase}`);
  await page.close();
  console.log(`[real-fs] closed options for ${phase}`);
}

async function expectAndCloseOptionsServiceError(context, extensionId, phase) {
  const page = await openOptionsPage(context, extensionId);
  console.log(`[real-fs] opened options for ${phase} error check`);
  try {
    await page.waitForFunction(
      () => document.body.dataset.ready === 'true',
      { timeout: 15000 },
    );
    await expect(page.locator('#serviceErrorBanner')).toBeVisible({
      timeout: 5000,
    });
    const serviceErrorText = await page
      .locator('#serviceErrorBanner')
      .textContent();
    console.log(
      `[real-fs] options error state for ${phase}: ${JSON.stringify(serviceErrorText?.trim() || '')}`,
    );
  } finally {
    await page.close().catch(() => {});
    console.log(`[real-fs] closed options for ${phase} error check`);
  }
}

function isProbeHealthy(result) {
  return !(
    result.serviceError ||
    result.pageResult?.success === false ||
    result.flushResult?.success === false ||
    result.dirInfo?.success === false ||
    result.dirInfo?.info?.hasPermission === false
  );
}

function isFsPermissionReproduced(result) {
  return (
    result.pageResult?.code === 'fs_permission' ||
    result.flushResult?.code === 'fs_permission' ||
    result.dirInfo?.code === 'fs_permission' ||
    result.serviceError?.code === 'fs_permission'
  );
}

function assertHealthyProbe(result, label) {
  if (!isProbeHealthy(result)) {
    throw new Error(`${label} failed: ${JSON.stringify(result)}`);
  }
}

test.describe('Real Browser FS Permission Repro', () => {
  test.skip(
    process.platform !== 'darwin',
    'This reproduction currently uses macOS dialog automation.',
  );

  test.skip(
    !process.env.REAL_FS_BROWSER,
    'Set REAL_FS_BROWSER=brave or REAL_FS_BROWSER=edge to run the real-browser reproduction.',
  );

  test('reproduces fs_permission using a real picked directory in a real browser', async () => {
    const browser = getBrowserConfig();
    test.skip(!browser, 'Unsupported REAL_FS_BROWSER value.');
    test.skip(
      !fs.existsSync(browser.executablePath),
      `${browser.appName} is not installed at ${browser.executablePath}.`,
    );

    const idleMs = Number(process.env.REAL_FS_IDLE_MS || 180000);
    test.setTimeout(idleMs + 180000);
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-recall-real-fs-profile-'),
    );
    const storageDir = process.env.REAL_FS_STORAGE_DIR
      ? path.resolve(process.env.REAL_FS_STORAGE_DIR)
      : '/tmp/browser-recall-real-fs-data';
    const keepStorage = process.env.REAL_FS_KEEP_STORAGE === '1';
    const keepBrowserOpenOnFailure =
      process.env.REAL_FS_KEEP_BROWSER_OPEN_ON_FAILURE === '1';
    if (!keepStorage) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
    fs.mkdirSync(storageDir, { recursive: true });

    let context;
    let hardStopTimer = null;
    let anchorPage = null;
    let failure = null;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        executablePath: browser.executablePath,
        locale: 'en-US',
        args: [
          ...(browser.launchArgs || []),
          `--disable-extensions-except=${extPath}`,
          `--load-extension=${extPath}`,
        ],
      });
      hardStopTimer = setTimeout(() => {
        context?.close().catch(() => {});
      }, idleMs + 120000);

      const extensionId = await waitForExtensionId(context);
      console.log(`[real-fs] extension loaded: ${extensionId}`);

      await waitMs(1000);
      for (const page of context.pages()) {
        if (page.url().includes('options.html')) {
          await page.close().catch(() => {});
        }
      }

      const optionsPage = await openOptionsPage(context, extensionId);
      await expect(optionsPage.locator('#onboardingDirBtn')).toBeVisible({
        timeout: 10000,
      });
      console.log('[real-fs] options onboarding visible');

      await pickDirectory(optionsPage, browser.appName, storageDir);
      const nativeUi = inspectBraveUi(browser.appName);
      console.log(`[real-fs] native ui after picker: ${JSON.stringify(nativeUi)}`);
      if (hasNativeApprovalPrompt(nativeUi)) {
        const clicked = clickBraveButtonOnce(browser.appName);
        if (clicked) {
          console.log(`[real-fs] clicked native button immediately: ${clicked}`);
          await waitMs(1000);
        }
      }
      await initializeOnboarding(optionsPage, browser.appName);

      anchorPage = await openAnchorPage(context);

      await optionsPage.close();
      console.log('[real-fs] options page closed after onboarding');

      const initialProbe = await probeFilesystem(context, extensionId, 'initial');
      console.log(`[real-fs] initial probe: ${JSON.stringify(initialProbe)}`);
      if (isFsPermissionReproduced(initialProbe)) {
        await expectAndCloseOptionsServiceError(
          context,
          extensionId,
          'post-initial',
        );
        test.info().annotations.push({
          type: 'real-fs-repro',
          description: `initial:${JSON.stringify(initialProbe)}`,
        });
        return;
      }
      assertHealthyProbe(initialProbe, 'initial probe');
      await checkAndCloseOptionsPage(context, extensionId, 'post-initial');

      const gapMs = Math.floor(idleMs / 3);
      console.log(`[real-fs] waiting ${gapMs}ms before activity-1`);
      await waitMs(gapMs);
      await visitPages(
        context,
        extensionId,
        browser.appName,
        'activity-1',
      );
      const activityOne = await probeFilesystem(context, extensionId, 'activity-1');
      console.log(`[real-fs] activity-1 probe: ${JSON.stringify(activityOne)}`);
      if (isFsPermissionReproduced(activityOne)) {
        await expectAndCloseOptionsServiceError(
          context,
          extensionId,
          'post-activity-1',
        );
        test.info().annotations.push({
          type: 'real-fs-repro',
          description: `activity-1:${JSON.stringify(activityOne)}`,
        });
        return;
      }
      assertHealthyProbe(activityOne, 'activity-1 probe');
      await checkAndCloseOptionsPage(context, extensionId, 'post-activity-1');

      console.log(`[real-fs] waiting ${gapMs}ms before activity-2`);
      await waitMs(gapMs);
      await visitPages(
        context,
        extensionId,
        browser.appName,
        'activity-2',
      );
      const activityTwo = await probeFilesystem(context, extensionId, 'activity-2');
      console.log(`[real-fs] activity-2 probe: ${JSON.stringify(activityTwo)}`);
      if (isFsPermissionReproduced(activityTwo)) {
        await expectAndCloseOptionsServiceError(
          context,
          extensionId,
          'post-activity-2',
        );
        test.info().annotations.push({
          type: 'real-fs-repro',
          description: `activity-2:${JSON.stringify(activityTwo)}`,
        });
        return;
      }
      assertHealthyProbe(activityTwo, 'activity-2 probe');
      await checkAndCloseOptionsPage(context, extensionId, 'post-activity-2');

      console.log(`[real-fs] waiting ${gapMs}ms before final activity`);
      await waitMs(gapMs);
      await visitPages(
        context,
        extensionId,
        browser.appName,
        'activity-3',
      );
      const finalProbe = await probeFilesystem(context, extensionId, 'activity-3');
      console.log(`[real-fs] final probe: ${JSON.stringify(finalProbe)}`);
      if (isFsPermissionReproduced(finalProbe)) {
        await expectAndCloseOptionsServiceError(context, extensionId, 'post-final');
        test.info().annotations.push({
          type: 'real-fs-repro',
          description: `activity-3:${JSON.stringify(finalProbe)}`,
        });
        return;
      }
      await checkAndCloseOptionsPage(context, extensionId, 'post-final');
      throw new Error(
        `fs_permission was not reproduced in any phase: ${JSON.stringify({
          initialProbe,
          activityOne,
          activityTwo,
          finalProbe,
        })}`,
      );
      await optionsPage.close();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (hardStopTimer) clearTimeout(hardStopTimer);
      if (failure && keepBrowserOpenOnFailure && context) {
        console.log(
          '[real-fs] keeping browser open after failure for manual inspection; close the browser when finished',
        );
        await new Promise((resolve) => {
          const done = () => resolve();
          context.once('close', done);
        }).catch(() => {});
      } else {
        await anchorPage?.close().catch(() => {});
        await context?.close().catch(() => {});
        fs.rmSync(userDataDir, { recursive: true, force: true });
        if (!keepStorage) {
          fs.rmSync(storageDir, { recursive: true, force: true });
        }
      }
    }
  });
});
