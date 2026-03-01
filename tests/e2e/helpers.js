function timer(label) {
  const t0 = performance.now();
  return () => console.log(`[timer] ${label}: ${(performance.now() - t0).toFixed(0)}ms`);
}

// Reset extension state and seed fresh data for a test.
export async function resetAndSeed(extContext, extensionId, files) {
  let done = timer('resetAndSeed: open helper page');
  const page = await extContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
  await page.waitForFunction(() => typeof chrome !== 'undefined' && chrome.runtime);
  done();

  done = timer('resetAndSeed: resetForTest');
  const resetResult = await page.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'resetForTest' })
  );
  if (!resetResult?.success) {
    throw new Error(`resetForTest failed: ${JSON.stringify(resetResult)}`);
  }
  done();

  if (files?.length > 0) {
    done = timer('resetAndSeed: seedTestData');
    const seedResult = await page.evaluate((f) =>
      chrome.runtime.sendMessage({ action: 'seedTestData', files: f })
    , files);
    if (!seedResult?.success) {
      throw new Error(`seedTestData failed: ${JSON.stringify(seedResult)}`);
    }
    done();

    done = timer('resetAndSeed: rehydrateForTest');
    const rehydrateResult = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' })
    );
    if (!rehydrateResult?.success) {
      throw new Error(`rehydrateForTest failed: ${JSON.stringify(rehydrateResult)}`);
    }
    done();
  }

  done = timer('resetAndSeed: close helper page');
  await page.close();
  done();
}

// Open a lightweight extension page for sending messages.
export async function openHelperPage(extContext, extensionId) {
  const done = timer('openHelperPage');
  const page = await extContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
  await page.waitForFunction(() => typeof chrome !== 'undefined' && chrome.runtime);
  done();
  return page;
}

// Open the full options page and wait for initialize() + showExplore() to complete.
// The options page sets document.body.dataset.ready='true' when done.
export async function openOptionsPage(extContext, extensionId) {
  let done = timer('openOptionsPage (goto)');
  const page = await extContext.newPage();
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('-timer]')) console.log(text);
  });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  done();

  done = timer('openOptionsPage (wait ready)');
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 10000 });
  done();

  return page;
}

// Wait for the list view to finish rendering after a sidebar click.
// showList() renders #listLayout visible and populates pinned/explore sections.
export async function waitForListView(page) {
  await page.waitForFunction(
    () => {
      const layout = document.getElementById('listLayout');
      return layout && layout.style.display !== 'none';
    },
    { timeout: 10000 }
  );
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
    const base = text.toLowerCase()
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
  } catch { return 'untitled'; }
}
