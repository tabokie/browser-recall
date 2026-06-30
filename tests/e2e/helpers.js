import crypto from 'crypto';
import { generateSlugFromUrl } from '../../packages/core/page-identity.js';

function timer(label) {
  const t0 = performance.now();
  return () =>
    console.log(`[timer] ${label}: ${(performance.now() - t0).toFixed(0)}ms`);
}

// Reset extension state and seed fresh data for a test.
export async function resetAndSeed(extContext, extensionId, files) {
  let page;
  for (let attempt = 0; attempt < 3; attempt++) {
    let done = timer('resetAndSeed: open helper page');
    page = await extContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
    await page.waitForFunction(
      () => typeof chrome !== 'undefined' && chrome.runtime,
    );
    done();

    done = timer('resetAndSeed: resetForTest');
    const resetResult = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'resetForTest' }),
    );
    if (resetResult?.success) {
      done();
      break;
    }

    await page.close().catch(() => {});
    if (attempt >= 2) {
      throw new Error(`resetForTest failed: ${JSON.stringify(resetResult)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (files?.length > 0) {
    let done = timer('resetAndSeed: seedTestData');
    const seedResult = await page.evaluate(
      (f) => chrome.runtime.sendMessage({ action: 'seedTestData', files: f }),
      files,
    );
    if (!seedResult?.success) {
      throw new Error(`seedTestData failed: ${JSON.stringify(seedResult)}`);
    }
    done();

    done = timer('resetAndSeed: flush connector queue');
    const rehydrateResult = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushDesktopQueueForTest' }),
    );
    if (!rehydrateResult?.success) {
      throw new Error(
        `flushDesktopQueueForTest failed: ${JSON.stringify(rehydrateResult)}`,
      );
    }
    done();
  }

  const done = timer('resetAndSeed: close helper page');
  await page.close();
  done();
}

// Open a lightweight extension page for sending messages.
export async function openHelperPage(extContext, extensionId) {
  const done = timer('openHelperPage');
  const page = await extContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
  await page.waitForFunction(
    () => typeof chrome !== 'undefined' && chrome.runtime,
  );
  done();
  return page;
}

export async function getExtensionMessage(page, key, substitutions) {
  return page.evaluate(
    ({ messageKey, messageSubstitutions }) =>
      chrome.i18n.getMessage(messageKey, messageSubstitutions),
    { messageKey: key, messageSubstitutions: substitutions },
  );
}

export async function longestLeftBorderRun(
  locator,
  expectedColor = [23, 23, 19, 255],
  scanWidth = 8,
) {
  const screenshot = await locator.screenshot({ animations: 'disabled' });
  return locator.evaluate(
    async (_, { base64, expectedColor: color, scanWidth: width }) => {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: 'image/png' }),
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(
        0,
        Math.floor(bitmap.height / 2),
        Math.min(width, bitmap.width),
        1,
      ).data;
      const pixels = Array.from(
        { length: Math.min(width, bitmap.width) },
        (_, index) => {
          const offset = index * 4;
          return Array.from(data.slice(offset, offset + 4));
        },
      );
      let longest = 0;
      let current = 0;
      for (const pixel of pixels) {
        const matches = pixel.every(
          (component, index) => Math.abs(component - color[index]) <= 2,
        );
        current = matches ? current + 1 : 0;
        longest = Math.max(longest, current);
      }
      return longest;
    },
    { base64: screenshot.toString('base64'), expectedColor, scanWidth },
  );
}

export const getSlugForUrl = generateSlugFromUrl;

export function pageCheckpointPath(slug) {
  const shard = crypto
    .createHash('sha256')
    .update(slug)
    .digest()
    .subarray(0, 1)
    .toString('hex');
  return `views/pages/${shard}/${slug}.json`;
}

export function seededRandom(seedText) {
  let seed = 0;
  for (let i = 0; i < seedText.length; i += 1) {
    seed = Math.imul(seed ^ seedText.charCodeAt(i), 2654435761) >>> 0;
  }
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickSeeded(random, values) {
  return values[Math.floor(random() * values.length)];
}

// Wait for a visit_page to be recorded for a URL after a link-click navigation.
// Content scripts at document_idle sometimes fail to inject on fast localhost pages.
// Falls back to sending recordPageActivity explicitly from the helper page.
export async function waitForVisitRecorded(helper, page, url, referrer) {
  const slug = getSlugForUrl(url);
  const pageKey = 'page:' + slug;

  // Check if content script already reported (up to 2s)
  let recorded = false;
  for (let i = 0; i < 20; i++) {
    const r = await helper.evaluate(
      (k) => chrome.runtime.sendMessage({ action: 'readDesktopValue', key: k }),
      pageKey,
    );
    if (r?.value?.timestamps) {
      recorded = true;
      break;
    }
    await helper.evaluate(() => new Promise((r) => setTimeout(r, 100)));
  }

  if (!recorded) {
    // Content script didn't inject — send recordPageActivity from helper page
    const title = await page.title();
    await helper.evaluate(
      ({ url, ref, title }) =>
        chrome.runtime.sendMessage({
          action: 'recordPageActivity',
          url,
          isInitialLoad: true,
          title,
          referrer: ref,
        }),
      { url, ref: referrer, title },
    );
    // Wait for processing
    await helper.evaluate(async (k) => {
      for (let i = 0; i < 20; i++) {
        const r = await chrome.runtime.sendMessage({
          action: 'readDesktopValue',
          key: k,
        });
        if (r?.value?.timestamps) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    }, pageKey);
  }
}
