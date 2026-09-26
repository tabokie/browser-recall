import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { format } from 'prettier';
import { test, expect } from './fixtures.js';
import { openHelperPage, getSlugForUrl } from './helpers.js';
import { documentationSeed } from '../../scripts/lib/documentation-seed.mjs';
import { seedManualData } from '../../scripts/lib/manual-seed.mjs';

import {
  captureInputs,
  assertCaptureInputs,
} from '../../scripts/lib/documentation-freshness.mjs';

const nativeCapture = process.env.BROWSER_RECALL_DOCUMENTATION_NATIVE === '1';
test.use({
  extensionHeadless: !nativeCapture,
  extensionEnglish: nativeCapture,
});

test('browser documentation separates the clean popup from note taking', async ({
  setupDir,
  extContext,
  extensionId,
}, testInfo) => {
  void setupDir;
  const inputs = captureInputs(process.cwd(), 'browser');
  const helper = await openHelperPage(extContext, extensionId);
  const sendMessage = (payload) =>
    helper.evaluate((message) => chrome.runtime.sendMessage(message), payload);
  const page = await extContext.newPage();
  let popup;
  try {
    expect(await sendMessage({ action: 'resetForTest' })).toMatchObject({
      success: true,
    });
    const settings = await sendMessage({
      action: 'readDesktopValue',
      key: 'manifest:settings',
    });
    expect(settings.success).toBe(true);
    const seed = documentationSeed();
    const url = 'https://fieldnotes.example/a-smaller-web';
    const excerpts = [0, 1].map(
      (index) =>
        seed.events.find(
          (event) => event.path === `objects/notes/reading-note-${index}.json`,
        ).excerpt[0],
    );
    // Two lists keep the real popup compact without changing extension styles.
    // Start this article without highlights; create a highlight after popup capture.
    seed.events = seed.events.filter(
      (event) =>
        !(event.action === 'create_note' && event.url === url) &&
        !(
          ['create_list', 'pin_to_list'].includes(event.action) &&
          event.name === 'Design details'
        ),
    );
    await seedManualData({
      ...seed,
      currentSettings: settings.value,
      sendMessage,
    });
    const escape = (text) =>
      text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    const article = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>A smaller, slower web</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #faf9f6; color: #302f2b; font-family: Georgia, serif; }
  header { max-width: 760px; margin: 0 auto; padding: 28px 0 20px; border-bottom: 1px solid #dedcd5; font: 13px system-ui, sans-serif; letter-spacing: .04em; }
  header span { float: right; color: #858178; }
  main { max-width: 640px; margin: 40px auto; }
  .eyebrow { color: #858178; font: 12px system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; }
  h1 { margin: 14px 0 18px; font-size: 42px; font-weight: normal; letter-spacing: -.03em; }
  .intro { color: #777369; font-size: 19px; line-height: 1.5; margin-bottom: 30px; }
  article p { font-size: 18px; line-height: 1.75; margin: 0 0 22px; }
  footer { border-top: 1px solid #dedcd5; padding-top: 16px; margin-top: 30px; color: #858178; font: 12px system-ui, sans-serif; }
  @media (max-width: 820px) {
    header { padding: 10px 0 8px; }
    main { margin: 12px auto; }
    h1 { font-size: 30px; margin: 8px 0 12px; }
    .intro { font-size: 15px; margin-bottom: 12px; }
    article p { font-size: 17px; line-height: 1.6; margin-bottom: 16px; }
  }
</style></head><body>
<header>FIELDNOTES <span>A few things worth keeping</span></header>
<main><div class="eyebrow">On making things · September 16, 2026</div>
<h1>A smaller, slower web</h1>
<div class="intro">A corner of the internet that feels like someone lives there.</div>
<article><p>${escape(excerpts[1])}</p><p>${escape(excerpts[0])}</p>
<p>The pages I return to rarely try to hold my attention. They offer something particular, then let me go: a recipe with a handwritten correction, a photograph of the same tree in another season.</p>
<p>Perhaps that is enough: a place to put what you notice, and a door left open for the next person who wanders by.</p></article>
<footer>Fieldnotes · An occasional notebook</footer></main></body></html>`;
    // Only the fictional website is served here. The extension and daemon are real.
    await page.route(url, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: article }),
    );
    await page.setViewportSize({ width: 800, height: 348 });
    await page.goto(url);
    const marks = page.locator('mark.browser-recall-highlight');
    await expect(marks).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    const images = {};
    async function capture(name, target) {
      const bytes = await target.screenshot({ caret: 'hide' });
      images[name] = bytes;
      await testInfo.attach(name, { body: bytes, contentType: 'image/png' });
    }

    const prepared = await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      return chrome.runtime.sendMessage({
        action: 'preparePopupBootstrapForTest',
        tabId: tab.id,
      });
    }, url);
    expect(prepared.success).toBe(true);
    // Render the unmodified popup document at its real width, with the source
    // tab selected through production popup preparation (no mocked tab reads).
    popup = await extContext.newPage();
    await popup.setViewportSize({ width: 296, height: 720 });
    await popup.goto(`chrome-extension://${extensionId}/${prepared.popupPath}`);
    await expect(popup.locator('#pageTitle')).toHaveText(
      'A smaller, slower web',
    );
    await expect(popup.locator('#highlightList')).toBeEmpty();
    await expect(popup.locator('#listChips')).toContainText('Small web');
    await expect
      .poll(() =>
        popup.evaluate(() => document.documentElement.dataset.popupHidden),
      )
      .toBeUndefined();
    await popup.evaluate(() => document.fonts.ready);
    if (!nativeCapture)
      await capture('browser-popup.png', popup.locator('body'));
    const locale = await popup.evaluate(() => document.documentElement.lang);
    if (nativeCapture) {
      await expect(popup.locator('#listSection .label-row')).toContainText(
        'Lists',
      );
      await expect(popup.locator('#captureBtn')).toHaveText('CAPTURE FRAME');
    }
    let captureWindow;
    let browserSession;
    let pageSession;

    if (nativeCapture) {
      await popup.close();
      popup = null;
      const extensions = await extContext.newPage();
      await extensions.goto(`chrome://extensions/?id=${extensionId}`);
      await extensions.evaluate(
        (id) =>
          chrome.developerPrivate.updateExtensionConfiguration({
            extensionId: id,
            pinnedToToolbar: true,
          }),
        extensionId,
      );
      await extensions.close();
      // Keep the helper out of the captured tab strip, in a minimized window.
      await helper.evaluate(async () => {
        const tab = await chrome.tabs.getCurrent();
        await chrome.windows.create({
          tabId: tab.id,
          state: 'minimized',
          focused: false,
        });
      });
      for (const other of extContext.pages()) {
        if (other !== page && other !== helper) await other.close();
      }
      await page.bringToFront();
      browserSession = await extContext.browser().newBrowserCDPSession();
      const { processInfo } = await browserSession.send(
        'SystemInfo.getProcessInfo',
      );
      const pid = processInfo.find((process) => process.type === 'browser').id;
      const nativeHelper = testInfo.outputPath('documentation-window');
      const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
      if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);
      fs.mkdirSync(path.dirname(nativeHelper), { recursive: true });
      execFileSync('/usr/bin/swiftc', [
        '-suppress-warnings',
        '-target',
        `${arch}-apple-macos14.0`,
        'scripts/lib/documentation-window.swift',
        '-o',
        nativeHelper,
      ]);
      const native = (...args) =>
        execFileSync(nativeHelper, [String(pid), ...args], {
          encoding: 'utf8',
        });
      native('frame-browser', 'A smaller, slower web', '800', '434');
      pageSession = await extContext.newCDPSession(page);
      await pageSession.send('Emulation.clearDeviceMetricsOverride');
      // Open the real toolbar popup for the real source tab.
      await helper.evaluate(async (pageUrl) => {
        const [tab] = await chrome.tabs.query({ url: pageUrl });
        const prepared = await chrome.runtime.sendMessage({
          action: 'preparePopupBootstrapForTest',
          tabId: tab.id,
        });
        if (!prepared.success) throw new Error(prepared.error);
        await chrome.action.setPopup({
          tabId: tab.id,
          popup: prepared.popupPath,
        });
        await chrome.windows.update(tab.windowId, { focused: true });
        await chrome.action.openPopup({ windowId: tab.windowId });
      }, url);
      await expect
        .poll(() =>
          helper.evaluate(() => {
            const view = chrome.extension.getViews({ type: 'popup' })[0];
            return (
              view?.document.querySelector('#pageTitle')?.textContent || ''
            );
          }),
        )
        .toBe('A smaller, slower web');
      expect(
        await helper.evaluate(
          () =>
            chrome.extension
              .getViews({ type: 'popup' })[0]
              .document.querySelector('#highlightList').textContent,
        ),
      ).toBe('');
      await expect(marks).toHaveCount(0);
      const browserBounds = await page.evaluate(() => ({
        left: screenX,
        top: screenY,
        right: screenX + outerWidth,
        bottom: screenY + outerHeight,
      }));
      await expect
        .poll(() =>
          helper.evaluate((bounds) => {
            const view = chrome.extension.getViews({ type: 'popup' })[0];
            return (
              view.screenX >= bounds.left &&
              view.screenY >= bounds.top &&
              view.screenX + view.outerWidth <= bounds.right &&
              view.screenY + view.outerHeight <= bounds.bottom
            );
          }, browserBounds),
        )
        .toBe(true);
      captureWindow = async (name) => {
        const filename = testInfo.outputPath(name);
        let previous;
        let stable = 0;
        await expect
          .poll(
            () => {
              native('capture-browser', filename, 'A smaller, slower web');
              const bytes = fs.readFileSync(filename);
              const hash = createHash('sha256').update(bytes).digest('hex');
              stable = hash === previous ? stable + 1 : 0;
              previous = hash;
              images[name] = bytes;
              return stable;
            },
            { timeout: 10000, intervals: [200] },
          )
          .toBeGreaterThanOrEqual(2);
        await testInfo.attach(name, {
          body: images[name],
          contentType: 'image/png',
        });
      };
      await captureWindow('browser-popup-window.png');
      await helper.evaluate(() =>
        chrome.extension.getViews({ type: 'popup' })[0].close(),
      );
    } else {
      await popup.close();
      popup = null;
    }

    await page.bringToFront();
    await page.getByText(excerpts[1], { exact: true }).selectText();
    const highlighted = await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      return chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
    }, url);
    expect(highlighted.success).toBe(true);
    await expect(marks).toHaveCount(1);
    await expect(marks).toHaveText(excerpts[1]);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await marks.click();
    await expect(
      page.locator('#browser-recall-highlight-overlay'),
    ).toBeVisible();
    const note =
      'A small reminder for the next time I feel behind: write when there is something to say.';
    await page.keyboard.type(note);
    // Move focus to the real save button without dismissing the editor or leaving
    // a blinking caret in the native screenshot.
    await page.keyboard.press('Tab');
    await page.mouse.move(20, 20);
    await expect
      .poll(() =>
        page
          .locator('#browser-recall-highlight-overlay')
          .evaluate((overlay) => {
            const rect = overlay.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= innerWidth &&
              rect.bottom <= innerHeight
            );
          }),
      )
      .toBe(true);
    if (nativeCapture) await captureWindow('browser-note-window.png');
    else await capture('browser-note.png', page);
    await page.keyboard.press('Enter');
    await expect(page.locator('#browser-recall-highlight-overlay')).toHaveCount(
      0,
    );
    await expect
      .poll(async () => {
        const response = await sendMessage({
          action: 'loadPageNotes',
          slug: getSlugForUrl(url),
        });
        expect(response.success).toBe(true);
        expect(response.notes).toHaveLength(1);
        return response.notes[0].note;
      })
      .toBe(note);
    await browserSession?.detach();
    await pageSession?.detach();

    const output = process.env.BROWSER_RECALL_DOCUMENTATION_OUTPUT;
    if (output) {
      assertCaptureInputs(process.cwd(), 'browser', inputs);
      const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
      const manifest = {
        command: 'npm run docs:screenshots:browser',
        inputs,
        platform: `Chromium ${extContext.browser().version()} / production extension`,
        locale,
        requestedWindow: { width: 800, height: 434 },
        capturedAt: new Date().toISOString(),
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        seedSha256: hash(fs.readFileSync('scripts/lib/documentation-seed.mjs')),
        scenarioSha256: hash(fs.readFileSync(testInfo.file)),
        screenshots: Object.fromEntries(
          Object.entries(images).map(([name, bytes]) => [
            name,
            {
              sha256: hash(bytes),
              width: bytes.readUInt32BE(16),
              height: bytes.readUInt32BE(20),
            },
          ]),
        ),
      };
      fs.mkdirSync(output, { recursive: true });
      for (const [name, bytes] of Object.entries(images))
        fs.writeFileSync(path.join(output, name), bytes);
      fs.writeFileSync(
        path.join(output, 'browser-capture.json'),
        await format(JSON.stringify(manifest), { parser: 'json' }),
      );
    }
  } finally {
    await popup?.close();
    await page.close();
    await helper.close();
  }
});
