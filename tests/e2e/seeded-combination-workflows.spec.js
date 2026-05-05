import { test, expect } from './fixtures.js';
import {
  pickSeeded,
  seededRandom,
  getSlugForUrl,
  openHelperPage,
  resetAndSeed,
  waitForVisitRecorded,
} from './helpers.js';

const EXTENSION_COMBO_SEED = 'extension-combo-20260505-a';

function slugPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function openPopupForUrl(extContext, extensionId, { url, title }) {
  const popup = await extContext.newPage();
  await popup.addInitScript(
    ({ url, title }) => {
      const patchTabsQuery = () => {
        if (!globalThis.chrome?.tabs?.query) {
          setTimeout(patchTabsQuery, 0);
          return;
        }
        const originalQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (queryInfo) => {
          if (queryInfo?.active && queryInfo?.currentWindow) {
            return [{ id: 51001, url, title }];
          }
          return originalQuery(queryInfo);
        };
      };
      patchTabsQuery();
    },
    { url, title },
  );
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#dashboard')).toBeVisible();
  return popup;
}

test.describe('seeded randomized workflow combinations', () => {
  test(`extension visits, notes, pins, and popup stay in sync seed=${EXTENSION_COMBO_SEED}`, async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const random = seededRandom(EXTENSION_COMBO_SEED);
    const nouns = ['Atlas', 'Beacon', 'Cinder', 'Drift', 'Ember', 'Fjord'];
    const verbs = ['draft', 'audit', 'brief', 'index', 'review', 'map'];
    const lists = [
      `Inbox ${pickSeeded(random, nouns)}`,
      `Queue ${pickSeeded(random, nouns)}`,
    ];
    const pages = Array.from({ length: 4 }, (_, index) => {
      const noun = pickSeeded(random, nouns);
      const verb = pickSeeded(random, verbs);
      const token = `${noun}-${verb}-${index}`;
      return {
        path: `/combo/${index}-${slugPart(token)}`,
        title: `${noun} ${verb} ${index}`,
        body: `<main><h1>${noun}</h1><p>${verb} workflow ${index}</p></main>`,
        excerpt: `${noun} excerpt ${verb} ${index}`,
        note: `${verb} note for ${noun} ${index}`,
        listIndex: index % lists.length,
      };
    });

    for (const page of pages) {
      localServer.addPage(page.path, { title: page.title, body: page.body });
      page.url = localServer.url(page.path);
      page.slug = getSlugForUrl(page.url);
    }

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const listIds = [];
    for (const name of lists) {
      const response = await helper.evaluate(
        (listName) =>
          chrome.runtime.sendMessage({
            action: 'saveListMeta',
            name: listName,
          }),
        name,
      );
      expect(response.success).toBe(true);
      expect(response.listId).toBeTruthy();
      listIds.push(response.listId);
    }

    for (const pageInfo of pages) {
      const page = await extContext.newPage();
      await page.goto(pageInfo.url);
      await page.waitForLoadState('domcontentloaded');
      await waitForVisitRecorded(helper, page, pageInfo.url, null);
      await page.close();

      const noteResponse = await helper.evaluate(
        ({ url, title, excerpt, note }) =>
          chrome.runtime.sendMessage({
            action: 'createNote',
            url,
            title,
            excerpt,
            note,
            cssPath: null,
          }),
        pageInfo,
      );
      expect(noteResponse.success).toBe(true);
      expect(noteResponse.noteSlug).toBeTruthy();

      const pinResponse = await helper.evaluate(
        ({ listId, url }) =>
          chrome.runtime.sendMessage({
            action: 'toggleListPin',
            listId,
            url,
          }),
        { listId: listIds[pageInfo.listIndex], url: pageInfo.url },
      );
      expect(pinResponse.success).toBe(true);
    }

    for (const pageInfo of pages) {
      const pageEntity = await helper.evaluate(
        (slug) =>
          chrome.runtime.sendMessage({
            action: 'readDesktopValue',
            key: `page:${slug}`,
          }),
        pageInfo.slug,
      );
      expect(pageEntity.value.title).toBe(pageInfo.title);
      expect(pageEntity.value.parentIds).toContain(
        `list:${listIds[pageInfo.listIndex]}`,
      );
      expect(
        pageEntity.value.childIds.some((id) => id.startsWith('note:')),
      ).toBe(true);

      const notes = await helper.evaluate(
        (slug) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug }),
        pageInfo.slug,
      );
      expect(notes.success).toBe(true);
      expect(notes.notes.map((note) => note.excerpt)).toContain(
        pageInfo.excerpt,
      );
    }

    for (const [index, listId] of listIds.entries()) {
      const list = await helper.evaluate(
        (id) =>
          chrome.runtime.sendMessage({
            action: 'readDesktopValue',
            key: `list:${id}`,
          }),
        listId,
      );
      const expectedPins = pages.filter((page) => page.listIndex === index);
      expect(list.value.pins.map((pin) => pin.id).sort()).toEqual(
        expectedPins.map((page) => `page:${page.slug}`).sort(),
      );
    }

    const popupPage = pages[2];
    const popup = await openPopupForUrl(extContext, extensionId, popupPage);
    await expect(popup.locator('#pageTitle')).toHaveText(popupPage.title);
    await expect(popup.locator('#listChips .list-chip.selected')).toContainText(
      lists[popupPage.listIndex],
    );
    await expect(popup.locator('#highlightList')).toContainText(
      popupPage.excerpt,
    );
    await expect(popup.locator('#highlightList')).toContainText(popupPage.note);

    await popup.close();
    await helper.close();
  });
});
