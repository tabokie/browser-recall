import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  settingsCheckpoint,
  getSlugForUrl,
  openHelperPage,
  pageCheckpointPath,
  pageEntityFixture,
  noteEntityFixture,
} from './helpers.js';

for (const scenario of [
  'webpage',
  'webpage-delete',
  'popup',
  'popup-delete',
  'popup-retry',
  'PDF',
]) {
  const surface = scenario.startsWith('popup')
    ? 'popup'
    : scenario.startsWith('webpage')
      ? 'webpage'
      : scenario;
  test(`${scenario} dismissal saves unfinished note edits`, async ({
    extContext,
    extensionId,
    localServer,
    setupDir,
    daemon,
  }) => {
    const title = `${surface} autosave`;
    localServer.addPage('/dismiss-note', {
      title,
      body:
        '<p>First highlight</p><p>Second highlight</p>' +
        (surface === 'PDF'
          ? '<embed type="application/pdf" src="about:blank" />'
          : ''),
    });
    const url = localServer.url('/dismiss-note');
    const slug = getSlugForUrl(url);
    const notes = ['First highlight', 'Second highlight'].map(
      (excerpt, index) =>
        noteEntityFixture({
          slug: `dismiss-note-${index}`,
          excerpt: [excerpt],
          note: `Original ${index}`,
          cssPath: [''],
          url,
        }),
    );
    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title,
          timestamps: { 'test-device': Date.now() },
          parentIds: [],
          childIds: notes.map((note) => `note:${note.slug}`),
        }),
      },
      ...notes.map((note) => ({
        path: `objects/notes/${note.slug}.json`,
        data: note,
      })),
    ]);
    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(url);
    const readNotes = () =>
      helper.evaluate(
        (slug) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug }),
        slug,
      );
    const expected = ['First highlight', 'Second highlight'].map(
      (excerpt, index) => ({
        excerpt: [excerpt],
        note: `${surface} draft ${index}\n保存`,
      }),
    );

    if (surface !== 'popup' && scenario !== 'webpage-delete') {
      await helper.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'ISOLATED',
          func: () => {
            const send = chrome.runtime.sendMessage.bind(chrome.runtime);
            let rejectNextSave = true;
            chrome.runtime.sendMessage = (request, ...args) => {
              if (request.action === 'updateNote' && rejectNextSave) {
                rejectNextSave = false;
                globalThis.__dismissSaveRejected = true;
                return Promise.resolve({
                  success: false,
                  error: 'Forced dismissal save failure',
                });
              }
              return send(request, ...args);
            };
          },
        });
      }, url);
    }
    const expectFailedClose = async (container) => {
      await expect
        .poll(() =>
          helper.evaluate(async (url) => {
            const [tab] = await chrome.tabs.query({ url });
            const [result] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'ISOLATED',
              func: () => globalThis.__dismissSaveRejected,
            });
            return result.result;
          }, url),
        )
        .toBe(true);
      await expect(container).toBeVisible();
    };

    if (scenario === 'webpage-delete') {
      await page
        .locator('p')
        .nth(1)
        .evaluate((paragraph) => {
          paragraph.style.marginTop = '300px';
        });
      await helper.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'ISOLATED',
          func: () => {
            const send = chrome.runtime.sendMessage.bind(chrome.runtime);
            globalThis.__dismissUpdateAttempts = 0;
            chrome.runtime.sendMessage = (request, ...args) => {
              if (request.action === 'updateNote')
                globalThis.__dismissUpdateAttempts++;
              if (request.action === 'deleteNote')
                return new Promise((resolve) => {
                  globalThis.__releaseDismissDelete = async () =>
                    resolve(await send(request, ...args));
                });
              return send(request, ...args);
            };
          },
        });
      }, url);
      const inspect = (release = false) =>
        helper.evaluate(
          async ({ url, release }) => {
            const [tab] = await chrome.tabs.query({ url });
            const [result] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'ISOLATED',
              args: [release],
              func: async (release) => {
                if (release) await globalThis.__releaseDismissDelete();
                return {
                  deleting: Boolean(globalThis.__releaseDismissDelete),
                  updates: globalThis.__dismissUpdateAttempts,
                };
              },
            });
            return result.result;
          },
          { url, release },
        );
      await page.locator('mark.browser-recall-highlight').first().click();
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe('browser-recall-highlight-overlay');
      await page.keyboard.insertText('Draft being deleted');
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Enter');
      await expect
        .poll(() => inspect())
        .toEqual({ deleting: true, updates: 0 });
      await page.locator('mark.browser-recall-highlight').nth(1).click();
      // The pending delete must lock both the confirmation button and the
      // programmatic close invoked by clicking a different highlight.
      const locked = await helper.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'ISOLATED',
          func: () => {
            const root = chrome.dom.openOrClosedShadowRoot(
              document.getElementById('browser-recall-highlight-overlay'),
            );
            return root?.querySelector('.note-action-btn.confirm')?.disabled;
          },
        });
        return result.result;
      }, url);
      expect(locked).toBe(true);
      expect((await inspect()).updates).toBe(0);
      await inspect(true);
      await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(
        1,
      );
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe('browser-recall-highlight-overlay');
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText(expected[1].note);
      await page.keyboard.press('Escape');
      await expect(
        page.locator('#browser-recall-highlight-overlay'),
      ).toHaveCount(0);
      expected.shift();
    } else if (surface === 'webpage') {
      for (let index = 0; index < 2; index++) {
        await page.locator('mark.browser-recall-highlight').nth(index).click();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.id))
          .toBe('browser-recall-highlight-overlay');
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.insertText(expected[index].note);
        if (index === 0) {
          await page.mouse.click(500, 300);
          await expectFailedClose(
            page.locator('#browser-recall-highlight-overlay'),
          );
          expect(
            (await readNotes()).notes.find(
              (note) => note.slug === notes[0].slug,
            ).note,
          ).toBe('Original 0');
          await page.mouse.click(500, 300);
        } else await page.keyboard.press('Escape');
        await expect(
          page.locator('#browser-recall-highlight-overlay'),
        ).toHaveCount(0);
      }
    } else {
      let editorPage = page;
      if (surface === 'popup') {
        const prepared = await helper.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url });
          return chrome.runtime.sendMessage({
            action: 'preparePopupBootstrapForTest',
            tabId: tab.id,
          });
        }, url);
        expect(prepared.success).toBe(true);
        editorPage = await extContext.newPage();
        await editorPage.goto(
          `chrome-extension://${extensionId}/${prepared.popupPath}`,
        );
      }
      const container =
        surface === 'PDF'
          ? page.locator('#browser-recall-highlights-panel')
          : editorPage.locator('#notesSection');
      for (let index = 0; index < 2; index++) {
        const item = container
          .locator('.highlight-item')
          .filter({ hasText: expected[index].excerpt[0] });
        await item.locator('.note-action-btn.edit').click();
        await item.locator('.highlight-note-editor').fill(expected[index].note);
      }
      if (scenario === 'popup-retry') {
        try {
          await helper.evaluate(() =>
            chrome.runtime.sendMessage({
              action: 'setConnectorPortsForTest',
              ports: [1],
            }),
          );
          await editorPage.close();
          await expect
            .poll(() =>
              helper.evaluate(async () => {
                const { desktopCommandBuffer = [] } =
                  await chrome.storage.local.get('desktopCommandBuffer');
                return desktopCommandBuffer
                  .filter((entry) => entry.action === 'updateNote')
                  .map((entry) => entry.request.note)
                  .sort();
              }),
            )
            .toEqual(expected.map((note) => note.note).sort());
          // Reloading the connector runtime must not erase the only copy.
          await helper.evaluate(() =>
            chrome.runtime.sendMessage({
              action: 'restartConnectorRuntimeForTest',
            }),
          );
        } finally {
          await helper.evaluate(
            (port) =>
              chrome.runtime.sendMessage({
                action: 'setConnectorPortsForTest',
                ports: [port],
              }),
            daemon.port,
          );
        }
        await helper.evaluate(() =>
          chrome.runtime.sendMessage({
            action: 'flushDesktopQueueForTest',
            keepDesktopQueue: true,
          }),
        );
      } else if (surface === 'popup') {
        // Hold the explicit save response after the daemon commits, then close
        // with both an in-flight confirmation and another unsaved editor.
        const action =
          scenario === 'popup-delete' ? 'deleteNote' : 'updateNote';
        await editorPage.evaluate((action) => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = async (request, ...args) => {
            const response = await send(request, ...args);
            if (request.action === action) {
              globalThis.__confirmedNoteSaved = response.success;
              await new Promise(() => {});
            }
            return response;
          };
        }, action);
        await container
          .locator(
            scenario === 'popup-delete'
              ? '.note-action-btn.delete'
              : '.note-action-btn.confirm',
          )
          .first()
          .click();
        await expect
          .poll(() =>
            editorPage.evaluate(() => globalThis.__confirmedNoteSaved),
          )
          .toBe(true);
        await editorPage.close();
        if (scenario === 'popup-delete') expected.shift();
      } else {
        await container.locator('.close-btn').click();
        await expectFailedClose(container);
        await expect(container.locator('.highlight-note-editor')).toHaveCount(
          1,
        );
        await expect(container.locator('.highlight-note-editor')).toHaveText(
          expected[0].note,
        );
        await container.locator('.close-btn').click();
        await expect(container).toHaveCount(0);
      }
    }
    await expect
      .poll(async () =>
        (await readNotes()).notes
          .map(({ excerpt, note }) => ({ excerpt, note }))
          .sort((a, b) => a.excerpt[0].localeCompare(b.excerpt[0])),
      )
      .toEqual(expected);
    await page.reload();
    const persisted = await readNotes();
    expect(persisted.notes).toHaveLength(expected.length);
    expect(
      persisted.notes.every(
        (note) => !notes.some((original) => original.slug === note.slug),
      ),
    ).toBe(true);
    await page.close();
    await helper.close();
  });
}
