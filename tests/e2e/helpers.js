import crypto from 'crypto';

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

// Compute the slug that the extension generates for a URL.
// Pure function — no browser context needed.
export function getSlugForUrl(url) {
  try {
    const parsed = new URL(url);
    let domain = parsed.hostname.toLowerCase();
    if (domain.startsWith('www.')) domain = domain.slice(4);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot > 0) domain = domain.slice(0, lastDot);
    const text = domain + parsed.pathname;
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 30)
      .replace(/-+$/, '');
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
    }
    const hashStr = Math.abs(hash).toString(36);
    return `${base}-${hashStr}`.substring(0, 80);
  } catch {
    throw new Error(`getSlugForUrl: invalid URL: ${url}`);
  }
}

export function pageCheckpointPath(slug) {
  const shard = crypto
    .createHash('sha256')
    .update(slug)
    .digest()
    .subarray(0, 1)
    .toString('hex');
  return `views/pages/${shard}/${slug}.json`;
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
