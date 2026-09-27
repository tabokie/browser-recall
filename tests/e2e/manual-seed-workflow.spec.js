import { test, expect } from './fixtures.js';
import { openHelperPage } from './helpers.js';
import { seedManualData } from '../../scripts/lib/manual-seed.mjs';
import { generateSlugFromUrl } from '../../packages/core/page-identity.js';
import { documentationSeed } from '../../scripts/lib/documentation-seed.mjs';

test('manual seed data is accepted by the daemon and flushes the connector', async ({
  setupDir,
  extContext,
  extensionId,
}) => {
  void setupDir;
  const page = await openHelperPage(extContext, extensionId);
  try {
    const reset = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'resetForTest' }),
    );
    expect(reset).toMatchObject({ success: true });

    const settings = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readDesktopValue',
        key: 'manifest:settings',
      }),
    );
    expect(settings).toMatchObject({ success: true });

    const files = await seedManualData({
      events: [
        {
          action: 'rate_page',
          url: 'https://manual-seed.example/page',
          title: 'Manual seed page',
          timestamp: 1_710_000_000_000,
          likes: 1,
        },
        {
          action: 'update_setting',
          key: 'theme',
          value: 'dark',
          timestamp: 1_710_000_000_001,
        },
      ],
      deviceId: 'manual-seed-device',
      currentSettings: settings.value,
      sendMessage: (message) =>
        page.evaluate(
          (payload) => chrome.runtime.sendMessage(payload),
          message,
        ),
    });
    const settingsFile = files.find(
      (file) => file.path === 'views/manifest/settings.json',
    );
    expect(settingsFile?.data).toMatchObject({
      theme: 'dark',
      titleTrimRules: [],
    });
    expect(settingsFile?.data).not.toHaveProperty('trimRules');

    const pageKey = `page:${generateSlugFromUrl('https://manual-seed.example/page')}`;
    const pageState = await page.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readDesktopValue', key }),
      pageKey,
    );
    expect(pageState).toMatchObject({ success: true });
    expect(pageState.value).toMatchObject({
      url: 'https://manual-seed.example/page',
    });
  } finally {
    await page.close();
  }
});

test('documentation reading collection loads through the real daemon', async ({
  setupDir,
  extContext,
  extensionId,
}) => {
  void setupDir;
  const page = await openHelperPage(extContext, extensionId);
  const sendMessage = (message) =>
    page.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
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
    await seedManualData({
      ...seed,
      currentSettings: settings.value,
      sendMessage,
    });
    const list = await sendMessage({
      action: 'readDesktopValue',
      key: 'list:reading-list-0',
    });
    expect(list).toMatchObject({ success: true });
    expect(list.value.name).toBe('Small web');
    expect(list.value.pins).toHaveLength(4);
    const notes = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        sendMessage({
          action: 'readDesktopValue',
          key: `note:reading-note-${index}`,
        }),
      ),
    );
    for (const note of notes) {
      expect(note).toMatchObject({ success: true });
      expect(note.value.excerpt).toHaveLength(1);
    }
    const annotated = notes.filter(({ value }) => value.note !== null);
    expect(annotated).toHaveLength(2);
    const words = (text) => text.trim().split(/\s+/).length;
    expect(words(annotated[0].value.excerpt[0])).toBeGreaterThan(50);
    expect(words(annotated[0].value.note)).toBeLessThan(8);
    expect(words(annotated[1].value.excerpt[0])).toBeLessThan(9);
    expect(words(annotated[1].value.note)).toBeGreaterThan(40);
    const highlightDates = seed.events
      .filter((event) => event.action === 'create_note')
      .map((event) => new Date(event.timestamp).toISOString().slice(0, 10));
    expect(new Set(highlightDates).size).toBe(3);
    const visited = new Set(
      seed.events
        .filter((event) => event.action === 'visit_page')
        .map((event) => event.url),
    );
    const pinned = new Set(
      seed.events
        .filter((event) => event.action === 'pin_to_list')
        .flatMap((event) => event.urls),
    );
    const highlighted = new Set(notes.map(({ value }) => value.url));
    expect(visited.size).toBe(40);
    expect(pinned.size / visited.size).toBeLessThan(0.2);
    expect(highlighted.size / visited.size).toBeLessThan(0.1);
    const timelineDates = new Map();
    for (const event of seed.events.filter(
      (entry) => entry.action === 'visit_page',
    )) {
      const date = new Date(event.timestamp).toISOString().slice(0, 10);
      const pages = timelineDates.get(date) ?? new Set();
      pages.add(event.url);
      timelineDates.set(date, pages);
    }
    expect(timelineDates.size).toBeGreaterThanOrEqual(35);
    expect(
      new Set([...timelineDates.keys()].map((date) => date.slice(0, 7))),
    ).toEqual(new Set(['2026-08', '2026-09']));
    expect(
      new Set([...timelineDates.values()].map((pages) => pages.size)).size,
    ).toBeGreaterThanOrEqual(7);
    const savedSettings = await sendMessage({
      action: 'readDesktopValue',
      key: 'manifest:settings',
    });
    expect(savedSettings.value).toMatchObject({
      theme: 'light',
      colorScheme: 'amber',
      localeOverride: 'en',
    });
    expect(Object.keys(savedSettings.value).sort()).toEqual(
      Object.keys(settings.value).sort(),
    );
  } finally {
    await page.close();
  }
});
