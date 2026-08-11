import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  settingsCheckpoint,
  getSlugForUrl,
  openHelperPage,
  pageCheckpointPath,
  pageEntityFixture,
  noteEntityFixture,
  longestLeftBorderRun,
} from './helpers.js';

test.describe('Highlight note edit', () => {
  test('live-page note editor stays private and does not reach page input handlers', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/note-editor-keyboard-isolation', {
      title: 'Note Editor Keyboard Isolation',
      body: '<p>The browser page owns this video player shortcut.</p>',
    });
    const pageUrl = localServer.url('/note-editor-keyboard-isolation');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-editor-keyboard-isolation';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Note Editor Keyboard Isolation',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: ['browser page owns this video player shortcut'],
          note: '',
          cssPath: [''],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.addInitScript(() => {
      globalThis.__pageHotkeys = [];
      globalThis.__pageClicks = [];
      for (const eventName of ['keydown', 'keypress', 'keyup']) {
        window.addEventListener(eventName, (event) => {
          globalThis.__pageHotkeys.push(`${event.type}:${event.key}`);
        });
      }
      window.addEventListener('click', (event) => {
        globalThis.__pageClicks.push(event.target?.id || event.target?.tagName);
      });
    });
    await page.goto(pageUrl);
    await page.waitForSelector('mark.browser-recall-highlight', {
      timeout: 5000,
    });
    await page
      .locator('mark.browser-recall-highlight')
      .evaluate((mark) => mark.click());

    const pageCanReadEditor = await page.evaluate(() => {
      const host = document.getElementById('browser-recall-highlight-overlay');
      globalThis.__pageClicks = [];
      return Boolean(host?.shadowRoot?.querySelector('.highlight-note-editor'));
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe('browser-recall-highlight-overlay');
    await page.keyboard.type('play pause');
    expect(await page.evaluate(() => globalThis.__pageHotkeys)).toEqual([]);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      state: 'detached',
      timeout: 3000,
    });

    expect.soft(pageCanReadEditor).toBe(false);
    expect.soft(await page.evaluate(() => globalThis.__pageClicks)).toEqual([]);
    const helper = await openHelperPage(extContext, extensionId);
    const notesResp = await helper.evaluate(
      (pageSlug) =>
        chrome.runtime.sendMessage({
          action: 'loadPageNotes',
          slug: pageSlug,
        }),
      slug,
    );
    expect(notesResp.notes?.[0]?.note).toBe('play pause');

    await helper.close();
    await page.close();
  });

  test('note text persists after edit without page reload', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    // Page with a highlight-able excerpt
    localServer.addPage('/note-edit', {
      title: 'Note Edit Test',
      body: '<p>The quick brown fox jumps over the lazy dog.</p>',
    });
    const pageUrl = localServer.url('/note-edit');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-edit-test-slug';
    const now = Date.now();

    // Seed page entity + note with excerpt but empty note text
    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Note Edit Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: ['quick brown fox'],
          note: '',
          cssPath: [''],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    // Wait for highlight to be applied by content script
    await page.waitForSelector('mark.browser-recall-highlight', {
      timeout: 5000,
    });

    // Verify initial noteSlug is set on the mark
    const initialNoteSlug = await page.evaluate(
      () =>
        document.querySelector('mark.browser-recall-highlight')?.dataset
          .noteSlug,
    );
    expect(initialNoteSlug).toBe(noteSlug);

    // Click the highlight mark to open the edit overlay
    await page.click('mark.browser-recall-highlight');
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      timeout: 3000,
    });

    const overlayBorderRun = await longestLeftBorderRun(
      page.locator('#browser-recall-highlight-overlay'),
    );
    expect(overlayBorderRun).toBeGreaterThanOrEqual(2);

    expect(
      await page.evaluate(
        () =>
          document.getElementById('browser-recall-highlight-overlay')
            ?.shadowRoot,
      ),
    ).toBeNull();
    await page.keyboard.type('my important note');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      state: 'detached',
      timeout: 3000,
    });

    await expect
      .poll(async () => {
        const helper = await openHelperPage(extContext, extensionId);
        try {
          const notesResp = await helper.evaluate(
            (s) =>
              chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s }),
            slug,
          );
          return notesResp.notes?.[0]?.note || '';
        } finally {
          await helper.close();
        }
      })
      .toBe('my important note');

    // Click the highlight again to re-open the overlay
    await page.click('mark.browser-recall-highlight');
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      timeout: 3000,
    });

    // The note text should be visible — verify via the mark's noteSlug
    // has been updated to the new slug (updateNote creates a replacement note)
    const updatedNoteSlug = await page.evaluate(
      () =>
        document.querySelector('mark.browser-recall-highlight')?.dataset
          .noteSlug,
    );
    // The noteSlug should have CHANGED (replace_note creates a new slug)
    expect(updatedNoteSlug).toBeTruthy();
    expect(updatedNoteSlug).not.toBe(noteSlug);

    const helper = await openHelperPage(extContext, extensionId);
    const notesResp = await helper.evaluate(
      (s) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s }),
      slug,
    );
    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].note).toBe('my important note');
    // The notes array should contain the new slug, not the old one
    expect(notesResp.notes[0].slug).toBe(updatedNoteSlug);

    await helper.close();
    await page.close();
  });

  test('highlight note overlay stays inside the viewport near page edge', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/note-edge', {
      title: 'Note Edge Test',
      body: '<main style="height:120vh;padding-top:32px;text-align:right"><p><span id="edge">edge highlight phrase</span></p></main>',
    });
    const pageUrl = localServer.url('/note-edge');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-edge-test-slug';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Note Edge Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: ['edge highlight phrase'],
          note: '',
          cssPath: [''],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.setViewportSize({ width: 360, height: 300 });
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('mark.browser-recall-highlight', {
      timeout: 5000,
    });
    await page.click('mark.browser-recall-highlight');
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      timeout: 3000,
    });

    const box = await page.evaluate(() => {
      const rect = document
        .getElementById('browser-recall-highlight-overlay')
        .getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
      };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.width);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(box.height);

    await page.close();
  });

  test('seeded highlight note loads into the private editor on mark click', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/hl-show', {
      title: 'Highlight Show Test',
      body: '<p>The quick brown fox jumps over the lazy dog.</p>',
    });
    const pageUrl = localServer.url('/hl-show');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-show-test';
    const now = Date.now();

    // Seed page with a note that has both excerpt and note text
    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Highlight Show Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: ['quick brown fox'],
          note: 'my saved note',
          cssPath: [''],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    // Wait for highlight to be applied by reapplyHighlights
    const mark = page.locator('mark.browser-recall-highlight');
    await expect(mark).toBeVisible({ timeout: 5000 });

    // Click the mark
    await mark.click();
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      timeout: 3000,
    });

    await page.keyboard.press('End');
    await page.keyboard.type(' appended');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      state: 'detached',
      timeout: 3000,
    });

    const helper = await openHelperPage(extContext, extensionId);
    const notesResp = await helper.evaluate(
      (s) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s }),
      slug,
    );
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].note).toBe('my saved note appended');

    // Verify noteSlug on mark matches the note slug
    const markSlug = await page.evaluate(
      () =>
        document.querySelector('mark.browser-recall-highlight')?.dataset
          .noteSlug,
    );
    expect(markSlug).toBe(notesResp.notes[0].slug);

    await helper.close();
    await page.close();
  });

  test('reapplies saved multiline highlight across visual block breaks after reload', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/hl-reapply-lines', {
      title: 'Highlight Reapply Lines Test',
      body: `<main>
        <h1>煎诸君的跳蛋</h1>
        <div>发布于 2026-06-03 17:41</div>
        <p>我养的橘猫孩子已经走了一年半了。突然想起一件事</p>
        <p>它平时很警觉的，但某天我发现它一条猫瘫着。</p>
        <p>捞起来发现软绵绵一条，还温的，</p>
      </main>`,
    });
    const pageUrl = localServer.url('/hl-reapply-lines');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-reapply-lines-test';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Highlight Reapply Lines Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [
            '煎诸君的跳蛋',
            '发布于 2026-06-03 17:41',
            '我养的橘猫孩子已经走了一年半了。突然想起一件事',
            '它平时很警觉的，但某天我发现它一条猫瘫着。',
            '捞起来发现软绵绵一条，还温的，',
          ],
          note: '',
          cssPath: [
            'body > main > h1',
            'body > main > div',
            'body > main > p:nth-of-type(1)',
            'body > main > p:nth-of-type(2)',
            'body > main > p:nth-of-type(3)',
          ],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    const marks = page.locator('mark.browser-recall-highlight');
    await expect(marks).toHaveCount(5, { timeout: 5000 });

    const markDetails = await marks.evaluateAll((nodes) =>
      nodes.map((el) => ({
        text: el.textContent,
        noteSlug: el.dataset.noteSlug,
      })),
    );
    expect(markDetails).toEqual([
      {
        text: '煎诸君的跳蛋',
        noteSlug,
      },
      {
        text: '发布于 2026-06-03 17:41',
        noteSlug,
      },
      {
        text: '我养的橘猫孩子已经走了一年半了。突然想起一件事',
        noteSlug,
      },
      {
        text: '它平时很警觉的，但某天我发现它一条猫瘫着。',
        noteSlug,
      },
      {
        text: '捞起来发现软绵绵一条，还温的，',
        noteSlug,
      },
    ]);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await expect(marks).toHaveCount(5, { timeout: 5000 });
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll('mark.browser-recall-highlight')].map(
            (mark) => mark.dataset.noteSlug,
          ),
        ),
      )
      .toEqual([noteSlug, noteSlug, noteSlug, noteSlug, noteSlug]);

    await page.close();
  });

  test('PDF highlight reapply does not mark the panel contents', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/pdf-panel-mark', {
      title: 'PDF Panel Mark Test',
      body: '<p id="new-highlight">new pdf highlight</p><embed type="application/pdf" src="about:blank" style="width:100%;height:100vh" />',
    });
    const pageUrl = localServer.url('/pdf-panel-mark');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();
    const noteEntries = Array.from({ length: 14 }, (_, index) => {
      const noteSlug = `pdf-panel-mark-note-${index + 1}`;
      return {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [`PDF panel highlight text ${index + 1}`],
          note: index === 0 ? 'PDF annotation 1' : '',
          cssPath: [''],
          url: pageUrl,
        }),
      };
    });

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'PDF Panel Mark Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: noteEntries.map(
            (_, index) => `note:pdf-panel-mark-note-${index + 1}`,
          ),
        }),
      },
      ...noteEntries,
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#browser-recall-highlights-panel', {
      timeout: 5000,
    });

    const panelState = await page.evaluate(() => {
      const panel = document
        .getElementById('browser-recall-highlights-panel')
        ?.shadowRoot?.querySelector('.panel');
      if (!panel) return null;
      panel.scrollTop = panel.scrollHeight;
      const header = panel.querySelector('.panel-header');
      const closeButton = panel.querySelector('.close-btn');
      const firstItem = panel.querySelector('.highlight-item');
      const emptyItem = panel.querySelectorAll('.highlight-item')[1];
      const quoteRow = firstItem?.querySelector('.highlight-quote-row');
      const quote = firstItem?.querySelector('.highlight-quote');
      const noteRow = firstItem?.querySelector('.highlight-note-row');
      const deleteButton = firstItem?.querySelector('.note-action-btn.delete');
      const editButton = firstItem?.querySelector('.note-action-btn.edit');
      const itemRect = firstItem?.getBoundingClientRect();
      const itemStyle = firstItem ? getComputedStyle(firstItem) : null;
      const deleteRect = deleteButton?.getBoundingClientRect();
      const editRect = editButton?.getBoundingClientRect();
      const colorProbe = document.createElement('span');
      colorProbe.style.color = 'var(--br-accent-red)';
      panel.appendChild(colorProbe);
      const accentRed = getComputedStyle(colorProbe).color;
      colorProbe.remove();
      const quoteStyle = quote ? getComputedStyle(quote) : null;
      const quoteRect = quote?.getBoundingClientRect();
      const noteRowRect = noteRow?.getBoundingClientRect();
      return {
        scrollTop: panel.scrollTop,
        markCount: panel.querySelectorAll('mark.browser-recall-highlight')
          .length,
        text: panel.textContent || '',
        panelTop: panel.getBoundingClientRect().top,
        headerTop: header?.getBoundingClientRect().top ?? null,
        headerPosition: header ? getComputedStyle(header).position : null,
        closeButtonTop: closeButton?.getBoundingClientRect().top ?? null,
        textareaCount: firstItem?.querySelectorAll('textarea').length ?? null,
        emptyAnnotationText:
          emptyItem
            ?.querySelector('.highlight-note-row')
            ?.textContent?.trim() ?? null,
        emptyPlaceholderCount:
          emptyItem?.querySelectorAll('.highlight-note-placeholder').length ??
          null,
        hasPopupRows: Boolean(quoteRow && noteRow),
        scrollbarWidth: getComputedStyle(panel).scrollbarWidth,
        scrollbarDisplay: getComputedStyle(panel, '::-webkit-scrollbar')
          .display,
        quoteBorderColor: quoteStyle?.borderLeftColor ?? null,
        quoteBorderStyle: quoteStyle?.borderLeftStyle ?? null,
        quoteBorderWidth: quoteStyle?.borderLeftWidth ?? null,
        quoteNoteGap:
          quoteRect && noteRowRect ? noteRowRect.top - quoteRect.bottom : null,
        accentRed,
        actionSizes: [deleteRect, editRect].map((rect) => ({
          width: rect?.width ?? null,
          height: rect?.height ?? null,
        })),
        actionsRightAligned:
          itemRect && itemStyle && deleteRect && editRect
            ? Math.abs(
                itemRect.right -
                  Number.parseFloat(itemStyle.paddingRight) -
                  deleteRect.right,
              ) <= 1 &&
              Math.abs(
                itemRect.right -
                  Number.parseFloat(itemStyle.paddingRight) -
                  editRect.right,
              ) <= 1
            : false,
        editIsBelowDelete:
          deleteRect && editRect ? editRect.top > deleteRect.top : false,
        editBottomInset:
          itemRect && editRect ? itemRect.bottom - editRect.bottom : null,
      };
    });

    expect(panelState).not.toBeNull();
    expect(panelState.text).toContain('PDF panel highlight text 1');
    expect(panelState.markCount).toBe(0);
    expect(panelState.scrollTop).toBeGreaterThan(0);
    expect(panelState.headerPosition).toBe('sticky');
    expect(
      Math.abs(panelState.headerTop - panelState.panelTop),
    ).toBeLessThanOrEqual(2);
    expect(panelState.closeButtonTop).toBeGreaterThanOrEqual(
      panelState.panelTop,
    );
    expect(panelState.textareaCount).toBe(0);
    expect(panelState.emptyAnnotationText).toBe('');
    expect(panelState.emptyPlaceholderCount).toBe(0);
    expect(panelState.hasPopupRows).toBe(true);
    expect(panelState.scrollbarWidth).toBe('none');
    expect(panelState.scrollbarDisplay).toBe('none');
    expect(panelState.quoteBorderColor).toBe(panelState.accentRed);
    expect(panelState.quoteBorderStyle).toBe('solid');
    expect(panelState.quoteBorderWidth).toBe('3px');
    expect(panelState.quoteNoteGap).toBe(8);
    expect(panelState.actionSizes).toEqual([
      { width: 16, height: 16 },
      { width: 16, height: 16 },
    ]);
    expect(panelState.actionsRightAligned).toBe(true);
    expect(panelState.editIsBelowDelete).toBe(true);
    expect(panelState.editBottomInset).toBeCloseTo(9, 1);

    const highlightsPanelHost = page.locator(
      '#browser-recall-highlights-panel',
    );
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
          let updateAttempts = 0;
          let rejectNextDelete = true;
          chrome.runtime.sendMessage = (request, ...args) => {
            if (request?.action === 'updateNote') {
              updateAttempts++;
              if (updateAttempts === 1) {
                return Promise.resolve({
                  success: false,
                  error: 'forced PDF note update failure',
                });
              }
              if (updateAttempts === 2) {
                return new Promise((resolve, reject) => {
                  globalThis.__releaseBrowserRecallPdfNoteUpdate = () => {
                    delete globalThis.__releaseBrowserRecallPdfNoteUpdate;
                    sendMessage(request, ...args).then(resolve, reject);
                  };
                });
              }
            }
            if (request?.action === 'deleteNote' && rejectNextDelete) {
              rejectNextDelete = false;
              return Promise.resolve({
                success: false,
                error: 'forced PDF note delete failure',
              });
            }
            return sendMessage(request, ...args);
          };
        },
      });
    }, pageUrl);
    const emptyHighlight = highlightsPanelHost
      .locator('.highlight-item')
      .nth(1);
    const emptyViewHeight = await emptyHighlight.evaluate(
      (item) => item.getBoundingClientRect().height,
    );
    await emptyHighlight.locator('.note-action-btn.edit').click();
    const emptyEditor = emptyHighlight.locator(
      '.highlight-note-editor[contenteditable="plaintext-only"]',
    );
    await expect(emptyEditor).toBeFocused();
    const emptyEditHeight = await emptyHighlight.evaluate(
      (item) => item.getBoundingClientRect().height,
    );
    expect(Math.abs(emptyEditHeight - emptyViewHeight)).toBeLessThan(0.1);
    await emptyEditor.press('Escape');

    await highlightsPanelHost
      .locator('.highlight-item .note-action-btn.edit')
      .first()
      .click();
    const editor = highlightsPanelHost.locator(
      '.highlight-item .highlight-note-editor[contenteditable="plaintext-only"]',
    );
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(
      highlightsPanelHost.locator('.highlight-item textarea'),
    ).toHaveCount(0);
    const confirmButton = highlightsPanelHost.locator(
      '.highlight-item .note-action-btn.confirm',
    );
    await expect(confirmButton.locator('svg')).toHaveAttribute(
      'data-icon',
      'checkmark',
    );
    await editor.fill('Updated PDF annotation');
    await confirmButton.click();
    await expect(editor).toBeVisible();
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();
    const editedItem = highlightsPanelHost.locator('.highlight-item').first();
    await expect(editedItem.locator('.note-action-btn.delete')).toBeDisabled();
    const releasedUpdate = await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          const release = globalThis.__releaseBrowserRecallPdfNoteUpdate;
          if (typeof release !== 'function') {
            return { success: false, error: 'delayed update is not pending' };
          }
          release();
          return { success: true };
        },
      });
      return result.result;
    }, pageUrl);
    expect(releasedUpdate).toEqual({ success: true });
    await expect(
      highlightsPanelHost
        .locator('.highlight-item .highlight-note-text')
        .first(),
    ).toHaveText('Updated PDF annotation');

    await expect
      .poll(async () => {
        const response = await helper.evaluate(
          (pageSlug) =>
            chrome.runtime.sendMessage({
              action: 'loadPageNotes',
              slug: pageSlug,
            }),
          slug,
        );
        return response.notes.find((note) =>
          note.excerpt?.includes('PDF panel highlight text 1'),
        )?.note;
      })
      .toBe('Updated PDF annotation');
    const itemCountBeforeRejectedDelete = await highlightsPanelHost
      .locator('.highlight-item')
      .count();
    const rejectedDeleteItem = highlightsPanelHost
      .locator('.highlight-item')
      .nth(2);
    const rejectedDeleteSlug =
      await rejectedDeleteItem.getAttribute('data-note-slug');
    await rejectedDeleteItem.locator('.note-action-btn.delete').click();
    await expect(highlightsPanelHost.locator('.highlight-item')).toHaveCount(
      itemCountBeforeRejectedDelete,
    );
    await expect(rejectedDeleteItem).toBeVisible();
    await expect
      .poll(async () => {
        const response = await helper.evaluate(
          (pageSlug) =>
            chrome.runtime.sendMessage({
              action: 'loadPageNotes',
              slug: pageSlug,
            }),
          slug,
        );
        return response.notes.some((note) => note.slug === rejectedDeleteSlug);
      })
      .toBe(true);
    await page.evaluate(() => {
      const panel = document
        .getElementById('browser-recall-highlights-panel')
        ?.shadowRoot?.querySelector('.panel');
      if (panel) panel.scrollTop = panel.scrollHeight;
    });
    await page.evaluate(() => {
      const paragraph = document.getElementById('new-highlight');
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const addResp = await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
    }, pageUrl);
    expect(addResp.success).toBe(true);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const panel = document
            .getElementById('browser-recall-highlights-panel')
            ?.shadowRoot?.querySelector('.panel');
          return panel?.scrollTop ?? -1;
        }),
      )
      .toBeGreaterThan(0);

    await helper.close();

    const panelHost = page.locator('#browser-recall-highlights-panel');
    const panelHeader = panelHost.locator('.panel-header');
    const beforeDrag = await panelHost.boundingBox();
    const headerBox = await panelHeader.boundingBox();
    expect(beforeDrag).not.toBeNull();
    expect(headerBox).not.toBeNull();
    await page.mouse.move(headerBox.x + 40, headerBox.y + headerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(headerBox.x - 60, headerBox.y + 60, { steps: 5 });
    await page.mouse.up();

    const afterDrag = await panelHost.boundingBox();
    expect(afterDrag).not.toBeNull();
    expect(Math.abs(afterDrag.x - beforeDrag.x)).toBeGreaterThan(50);
    expect(Math.abs(afterDrag.y - beforeDrag.y)).toBeGreaterThan(30);

    await panelHost.locator('.close-btn').click();
    await expect(panelHost).toHaveCount(0);

    await page.close();
  });

  test('highlight created across visual blocks stores excerpt and css paths as structural arrays', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/hl-create-visual-block-array', {
      title: 'Highlight Visual Block Array Test',
      body: `<main>
        <div class="meta"><span>煎诸君的跳蛋</span> <span>发布于 2026-06-03 17:41</span></div>
        <div class="body">我养的橘猫孩子已经走了一年半了。突然想起一件事</div>
        <div class="body">它平时很警觉的，但某天我发现它一条猫瘫着。</div>
      </main>`,
    });
    const pageUrl = localServer.url('/hl-create-visual-block-array');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Highlight Visual Block Array Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [],
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      const firstSpan = document.querySelector('.meta span');
      const secondBody = document.querySelectorAll('.body')[1];
      const range = document.createRange();
      range.setStart(firstSpan.firstChild, 0);
      range.setEnd(secondBody.firstChild, secondBody.textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const helper = await openHelperPage(extContext, extensionId);
    const highlightResp = await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
    }, pageUrl);
    expect(highlightResp.success).toBe(true);
    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(3);

    const notesResp = await helper.evaluate(
      (pageSlug) =>
        chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: pageSlug }),
      slug,
    );

    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].excerpt).toEqual([
      '煎诸君的跳蛋 发布于 2026-06-03 17:41',
      '我养的橘猫孩子已经走了一年半了。突然想起一件事',
      '它平时很警觉的，但某天我发现它一条猫瘫着。',
    ]);
    expect(notesResp.notes[0].cssPath).toEqual(
      notesResp.notes[0].excerpt.map(
        (excerpt, index) =>
          `browser-recall-text-anchor:v1:${JSON.stringify({
            selector: `body > main > div:nth-of-type(${index + 1})`,
            start: 0,
            end: excerpt.length,
          })}`,
      ),
    );

    await helper.close();
    await page.close();
  });

  test('highlight created inside one multiline element stores excerpt as one string', async ({
    extContext,
    extensionId,
    localServer,
  }) => {
    localServer.addPage('/hl-create-single-multiline', {
      title: 'Highlight Single Multiline Test',
      body: `<main><pre><code><span class="token">Referer: https://developer.mozilla.org/en-US/docs/Web/JavaScript</span>
<span class="token">Referer: https://example.com/page?q=123</span>
<span class="token">Referer: https://example.com/</span></code></pre></main>`,
    });
    const pageUrl = localServer.url('/hl-create-single-multiline');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Highlight Single Multiline Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [],
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      const code = document.querySelector('code');
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const helper = await openHelperPage(extContext, extensionId);
    const highlightResp = await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
    }, pageUrl);
    expect(highlightResp.success).toBe(true);
    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(1);

    const notesResp = await helper.evaluate(
      (pageSlug) =>
        chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: pageSlug }),
      slug,
    );

    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    const expectedExcerpt =
      'Referer: https://developer.mozilla.org/en-US/docs/Web/JavaScript\nReferer: https://example.com/page?q=123\nReferer: https://example.com/';
    expect(notesResp.notes[0].excerpt).toEqual([expectedExcerpt]);
    expect(notesResp.notes[0].cssPath).toEqual([
      `browser-recall-text-anchor:v1:${JSON.stringify({
        selector: 'body > main > pre',
        start: 0,
        end: expectedExcerpt.length,
      })}`,
    ]);

    await helper.close();
    await page.close();
  });

  test('reapplies saved highlight using exact comment part paths after reload', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/hl-reapply-stale-metadata', {
      title: 'Highlight Stale Metadata Test',
      body: `<table><tbody><tr id="48419236"><td><table><tbody><tr><td></td><td></td><td>
        <div><span><a>staticshock</a> <span>1 hour ago</span> | next [–]</span></div>
        <br>
        <div class="comment"><div class="commtext c00">Everything is search.
          <p>Software development is search through the space of useful/interesting automations.</p>
          <p>Business is search for product market fit.</p>
        </div></div>
      </td></tr></tbody></table></td></tr></tbody></table>`,
    });
    const pageUrl = localServer.url('/hl-reapply-stale-metadata');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-reapply-stale-metadata-test';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Highlight Stale Metadata Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [
            'staticshock 1 hour ago | next [–]',
            'Everything is search.',
            'Software development is search through the space of useful/interesting automations.',
            'Business is search for product market fit.',
          ],
          note: '',
          cssPath: [
            'body > table > tbody > tr > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(1)',
            'body > table > tbody > tr > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(2) > div',
            'body > table > tbody > tr > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(2) > div > p:nth-of-type(1)',
            'body > table > tbody > tr > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(2) > div > p:nth-of-type(2)',
          ],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(4, {
      timeout: 5000,
    });
    await expect(
      page.locator('mark.browser-recall-highlight', {
        hasText: 'staticshock 1 hour ago | next [–]',
      }),
    ).toBeVisible();
    await expect(
      page.locator('mark.browser-recall-highlight', {
        hasText:
          'Software development is search through the space of useful/interesting automations.',
      }),
    ).toBeVisible();
    await expect(
      page.locator('mark.browser-recall-highlight').first(),
    ).toHaveAttribute('data-note-slug', noteSlug);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(4, {
      timeout: 5000,
    });
    await expect(
      page.locator('mark.browser-recall-highlight', {
        hasText:
          'Software development is search through the space of useful/interesting automations.',
      }),
    ).toBeVisible();

    await page.close();
  });

  test('reapplies HN highlights saved with migrated escaped numeric row id paths', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/hl-reapply-hn-numeric-row-id', {
      title: 'Highlight HN Numeric Row Id Test',
      body: `<table><tbody><tr id="48419236"><td><table><tbody><tr><td></td><td></td><td>
        <div><span><a>staticshock</a> <span>1 day ago</span> | next [–]</span></div>
        <br>
        <div class="comment"><div class="commtext c00">Everything is search.
          <p>Software development is search through the space of useful/interesting automations.</p>
          <p>Business is search for product market fit.</p>
        </div></div>
      </td></tr></tbody></table></td></tr></tbody></table>`,
    });
    const pageUrl = localServer.url('/hl-reapply-hn-numeric-row-id');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-reapply-hn-numeric-row-id-test';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Highlight HN Numeric Row Id Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [
            'staticshock 1 day ago  | next [–]',
            'Everything is search.',
            'Software development is search through the space of useful/interesting automations.',
            'Business is search for product market fit.',
          ],
          note: '',
          cssPath: [
            'tr#\\34 8419236 > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(1)',
            'tr#\\34 8419236 > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(1)',
            'tr#\\34 8419236 > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(1) > p:nth-of-type(1)',
            'tr#\\34 8419236 > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(1) > p:nth-of-type(2)',
          ],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(4, {
      timeout: 5000,
    });
    await expect(
      page.locator('mark.browser-recall-highlight', {
        hasText: 'staticshock 1 day ago | next [–]',
      }),
    ).toBeVisible();
    await expect(
      page.locator('mark.browser-recall-highlight', {
        hasText: 'Everything is search.',
      }),
    ).toBeVisible();

    await page.close();
  });

  test('reapplies saved highlight on mixed-case URL paths using canonical page slug', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/MixedCase/HighlightPath', {
      title: 'Mixed Case Highlight Path Test',
      body: '<main><p id="block49">Mixed case path highlighted text.</p></main>',
    });
    const pageUrl = localServer.url('/MixedCase/HighlightPath');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-reapply-mixed-case-url-path-test';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Mixed Case Highlight Path Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: ['Mixed case path highlighted text.'],
          note: '',
          cssPath: ['p#block49'],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    const articleMark = page.locator('p#block49 mark.browser-recall-highlight');
    await expect(articleMark).toHaveCount(1, {
      timeout: 5000,
    });
    await expect(articleMark).toHaveText('Mixed case path highlighted text.');
    await expect(articleMark).toHaveAttribute('data-note-slug', noteSlug);

    await page.close();
  });

  test('reapplies saved highlight after client hydration replaces the marked paragraph', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const beforeWisdom =
      'Learning data science made me realize that I could use the';
    const wisdom = 'Wisdom of the Crowds';
    const afterWisdom =
      "to tease out what the common problem was in all of my interactions with people. It wasn't easy: the different instances were superficially totally different.";
    const excerpt = `${beforeWisdom}\u00a0${wisdom}\u00a0${afterWisdom}`;
    const paragraphHtml = `<p id="block49"><strong>(d)</strong>&nbsp;${beforeWisdom}&nbsp;<span><span><a href="http://en.wikipedia.org/wiki/Wisdom_of_the_crowd">${wisdom}</a></span></span>&nbsp;${afterWisdom} It's not at all&nbsp;<em>a priori&nbsp;</em>clear what the two things</p>`;
    localServer.addPage('/hl-reapply-hydration-replaces-mark', {
      title: 'Hydration Replaces Highlight Test',
      body: `<main id="article-root">${paragraphHtml}</main>
        <script>
          const paragraphHtml = ${JSON.stringify(paragraphHtml)};
          setTimeout(() => {
            const root = document.getElementById('article-root');
            root.innerHTML = paragraphHtml;
            root.dataset.hydrated = '1';
          }, 250);
        </script>`,
    });
    const pageUrl = localServer.url('/hl-reapply-hydration-replaces-mark');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-reapply-hydration-replaces-mark-test';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Hydration Replaces Highlight Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [excerpt],
          note: '',
          cssPath: ['p#block49'],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#article-root[data-hydrated="1"]', {
      timeout: 5000,
    });

    const articleMark = page.locator(
      '#article-root mark.browser-recall-highlight',
    );
    await expect(articleMark).toHaveCount(1, {
      timeout: 5000,
    });
    await expect(articleMark).toBeVisible();
    await expect(articleMark).toHaveText(excerpt);
    await expect(articleMark).toHaveAttribute('data-note-slug', noteSlug);

    await page.close();
  });

  test('deleting a grouped reapplied highlight removes every mark immediately', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/hl-delete-grouped-reapply', {
      title: 'Highlight Delete Grouped Reapply Test',
      body: `<main>
        <h1>煎诸君的跳蛋</h1>
        <div>发布于 2026-06-03 17:41</div>
        <p>我养的橘猫孩子已经走了一年半了。突然想起一件事</p>
      </main>`,
    });
    const pageUrl = localServer.url('/hl-delete-grouped-reapply');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-delete-grouped-reapply-test';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Highlight Delete Grouped Reapply Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [
            '煎诸君的跳蛋',
            '发布于 2026-06-03 17:41',
            '我养的橘猫孩子已经走了一年半了。突然想起一件事',
          ],
          note: '',
          cssPath: ['body > main > h1', 'body > main > div', 'body > main > p'],
          url: pageUrl,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(3, {
      timeout: 5000,
    });
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.sendMessage(tab.id, {
        action: 'removeHighlightMark',
        noteSlug: 'note-delete-grouped-reapply-test',
      });
    }, pageUrl);
    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(0);

    await helper.close();
    await page.close();
  });

  test('highlight created via Alt+H retains note on re-click', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/hl-reclick', {
      title: 'Highlight Reclick Test',
      body: '<p>The quick brown fox jumps over the lazy dog.</p>',
    });
    const pageUrl = localServer.url('/hl-reclick');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Highlight Reclick Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [],
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    // Select text on the page
    await page.evaluate(() => {
      const p = document.querySelector('p');
      const range = document.createRange();
      const text = p.firstChild;
      range.setStart(text, 4);
      range.setEnd(text, 19);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Trigger highlightSelection (simulates Alt+H) via tabs.sendMessage
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
    }, pageUrl);

    // Wait for mark to appear
    await page.waitForSelector('mark.browser-recall-highlight', {
      timeout: 5000,
    });
    // Wait for overlay to appear
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      timeout: 3000,
    });

    await page.keyboard.type('important insight');
    await page.keyboard.press('Control+Enter');
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      state: 'detached',
      timeout: 5000,
    });

    // Verify the note was saved via background
    const notesResp = await helper.evaluate(
      (s) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s }),
      slug,
    );
    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].note).toBe('important insight');

    // Get the current noteSlug on the mark
    const markNoteSlug = await page.evaluate(
      () =>
        document.querySelector('mark.browser-recall-highlight')?.dataset
          .noteSlug,
    );
    // It should match the note we just verified
    expect(markNoteSlug).toBe(notesResp.notes[0].slug);

    // Click the highlight mark again
    await page.click('mark.browser-recall-highlight');
    await page.waitForSelector('#browser-recall-highlight-overlay', {
      timeout: 3000,
    });

    await page.keyboard.press('Escape');

    // Verify from background that note data is intact after re-click
    const notesAfterClick = await helper.evaluate(
      (s) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s }),
      slug,
    );
    expect(notesAfterClick.notes).toHaveLength(1);
    expect(notesAfterClick.notes[0].note).toBe('important insight');

    await helper.close();
    await page.close();
  });
});
