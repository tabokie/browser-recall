import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage } from './helpers.js';

// Bug: onLeavePage() sends Date.now() - startTime (cumulative since page load).
// When leave_page fires multiple times (tab switch away, switch back, switch away),
// replay accumulates these cumulative values, overcounting time on page.
// Fix: track foreground-only deltas.
//
// Test strategy: In headless mode, visibilitychange → hidden can't be simulated
// (document.visibilityState is always 'visible' in content script's isolated world).
// Instead:
//   - Use `freeze` event to trigger onLeavePage() (handler is unconditional)
//   - Use `visibilitychange` event to trigger the "visible" branch (since headless
//     reports visibilityState='visible', the else branch resets the foreground timer)

test('timeOnPage reports foreground delta, not cumulative time since load', async ({
  extContext,
  extensionId,
  setupDir,
  localServer,
}) => {
  localServer.addPage('/time-test', {
    title: 'Time Test',
    body: '<h1>Time Test</h1>',
  });
  await resetAndSeed(extContext, extensionId, [
    { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
  ]);
  const testUrl = localServer.url('/time-test');

  // Open the test page and spend ~2s in foreground
  const page = await extContext.newPage();
  await page.goto(testUrl);
  await page.waitForSelector('h1');
  await page.waitForTimeout(2000);

  // Simulate "tab switch away" via freeze event → leave_page #1 (~2s)
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await page.waitForTimeout(300);

  // Simulate background time (should NOT count toward foreground with fix)
  await page.waitForTimeout(2000);

  // Simulate "tab switch back" via visibilitychange event.
  // In headless, document.visibilityState is 'visible', so the content script's
  // visibilitychange handler enters the else (visible) branch, resetting the timer.
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );

  // Spend ~500ms in foreground
  await page.waitForTimeout(500);

  // Simulate "tab switch away" again via freeze → leave_page #2
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await page.waitForTimeout(300);

  // Read leave_page entries for the test URL through the daemon-backed cache.
  const helper = await openHelperPage(extContext, extensionId);
  const leaveEntries = await helper.evaluate(async (url) => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const key = 'log:' + today;
    for (let i = 0; i < 40; i++) {
      const resp = await chrome.runtime.sendMessage({
        action: 'readCacheable',
        key,
      });
      const entries = resp?.value || [];
      const matches = entries.filter(
        (e) => e.url === url && e.action === 'leave_page',
      );
      if (matches.length >= 2) return matches;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return [];
  }, testUrl);
  await helper.close();

  // Should have 2 leave_page entries
  expect(leaveEntries.length).toBeGreaterThanOrEqual(2);

  // Key assertion: 2nd leave should report LESS time than 1st leave
  // because the 2nd foreground period (~500ms) is shorter than the 1st (~2s).
  //
  // With the bug (cumulative): both report Date.now() - startTime
  //   #1 ≈ 2s, #2 ≈ 5s → 2nd > 1st → FAILS
  // With the fix (foreground delta):
  //   #1 ≈ 2s, #2 ≈ 500ms → 2nd < 1st → PASSES
  expect(leaveEntries[1].timeOnPage).toBeLessThan(leaveEntries[0].timeOnPage);

  await page.close();
});
