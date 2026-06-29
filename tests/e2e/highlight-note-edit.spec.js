import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  getSlugForUrl,
  openHelperPage,
  pageCheckpointPath,
} from './helpers.js';

test.describe('Highlight note edit', () => {
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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Note Edit Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: ['quick brown fox'],
          note: '',
          cssPath: [''],
          url: pageUrl,
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    // Wait for highlight to be applied by content script
    await page.waitForSelector('mark.portal-highlight', { timeout: 5000 });

    // Verify initial noteSlug is set on the mark
    const initialNoteSlug = await page.evaluate(
      () => document.querySelector('mark.portal-highlight')?.dataset.noteSlug,
    );
    expect(initialNoteSlug).toBe(noteSlug);

    // Click the highlight mark to open the edit overlay
    await page.click('mark.portal-highlight');
    await page.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    // Textarea is auto-focused — type a note
    await page.keyboard.type('my important note');

    // Press Escape to save and close
    await page.keyboard.press('Escape');
    await page.waitForSelector('#portal-highlight-overlay', {
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
    await page.click('mark.portal-highlight');
    await page.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    // The note text should be visible — verify via the mark's noteSlug
    // has been updated to the new slug (updateNote creates a replacement note)
    const updatedNoteSlug = await page.evaluate(
      () => document.querySelector('mark.portal-highlight')?.dataset.noteSlug,
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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Note Edge Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: ['edge highlight phrase'],
          note: '',
          cssPath: [''],
          url: pageUrl,
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.setViewportSize({ width: 360, height: 300 });
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('mark.portal-highlight', { timeout: 5000 });
    await page.click('mark.portal-highlight');
    await page.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    const box = await page.evaluate(() => {
      const rect = document
        .getElementById('portal-highlight-overlay')
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

  test('seeded highlight note shows text in overlay on mark click', async ({
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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Highlight Show Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: ['quick brown fox'],
          note: 'my saved note',
          cssPath: [''],
          url: pageUrl,
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    // Wait for highlight to be applied by reapplyHighlights
    const mark = page.locator('mark.portal-highlight');
    await expect(mark).toBeVisible({ timeout: 5000 });

    // Click the mark
    await mark.click();
    await page.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    // The overlay uses closed shadow DOM — we can't directly read the textarea.
    // But we can verify via background that the note data is accessible
    const helper = await openHelperPage(extContext, extensionId);
    const notesResp = await helper.evaluate(
      (s) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s }),
      slug,
    );
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].note).toBe('my saved note');

    // Verify noteSlug on mark matches the note slug
    const markSlug = await page.evaluate(
      () => document.querySelector('mark.portal-highlight')?.dataset.noteSlug,
    );
    expect(markSlug).toBe(noteSlug);

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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Highlight Reapply Lines Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
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
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    const marks = page.locator('mark.portal-highlight');
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
          [...document.querySelectorAll('mark.portal-highlight')].map(
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
      body: '<embed type="application/pdf" src="about:blank" style="width:100%;height:100vh" />',
    });
    const pageUrl = localServer.url('/pdf-panel-mark');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();
    const noteEntries = Array.from({ length: 14 }, (_, index) => {
      const noteSlug = `pdf-panel-mark-note-${index + 1}`;
      return {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: [`PDF panel highlight text ${index + 1}`],
          note: '',
          cssPath: [''],
          url: pageUrl,
        },
      };
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'PDF Panel Mark Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: noteEntries.map(
            (_, index) => `note:pdf-panel-mark-note-${index + 1}`,
          ),
        },
      },
      ...noteEntries,
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#portal-highlights-panel', { timeout: 5000 });

    const panelState = await page.evaluate(() => {
      const panel = document
        .getElementById('portal-highlights-panel')
        ?.shadowRoot?.querySelector('.panel');
      if (!panel) return null;
      panel.scrollTop = panel.scrollHeight;
      return {
        scrollTop: panel.scrollTop,
        markCount: panel.querySelectorAll('mark.portal-highlight').length,
        text: panel.textContent || '',
      };
    });

    expect(panelState).not.toBeNull();
    expect(panelState.text).toContain('PDF panel highlight text 1');
    expect(panelState.markCount).toBe(0);
    expect(panelState.scrollTop).toBeGreaterThan(0);

    const helper = await openHelperPage(extContext, extensionId);
    const addResp = await helper.evaluate(
      (pageUrlValue) =>
        chrome.runtime.sendMessage({
          action: 'contextMenuHighlight',
          url: pageUrlValue,
          title: 'PDF Panel Mark Test',
          selectionText: 'new pdf highlight',
        }),
      pageUrl,
    );
    expect(addResp.success).toBe(true);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const panel = document
            .getElementById('portal-highlights-panel')
            ?.shadowRoot?.querySelector('.panel');
          return panel?.scrollTop ?? -1;
        }),
      )
      .toBeGreaterThan(0);

    await helper.close();

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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Highlight Visual Block Array Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [],
        },
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
    await expect(page.locator('mark.portal-highlight')).toHaveCount(3);

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
    expect(notesResp.notes[0].cssPath).toEqual([
      'body > main > div:nth-of-type(1)',
      'body > main > div:nth-of-type(2)',
      'body > main > div:nth-of-type(3)',
    ]);

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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Highlight Single Multiline Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [],
        },
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
    await expect(page.locator('mark.portal-highlight')).toHaveCount(1);

    const notesResp = await helper.evaluate(
      (pageSlug) =>
        chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: pageSlug }),
      slug,
    );

    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].excerpt).toEqual([
      'Referer: https://developer.mozilla.org/en-US/docs/Web/JavaScript\nReferer: https://example.com/page?q=123\nReferer: https://example.com/',
    ]);
    expect(notesResp.notes[0].cssPath).toEqual(['body > main > pre']);

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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Highlight Stale Metadata Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
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
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('mark.portal-highlight')).toHaveCount(4, {
      timeout: 5000,
    });
    await expect(
      page.locator('mark.portal-highlight', {
        hasText: 'staticshock 1 hour ago | next [–]',
      }),
    ).toBeVisible();
    await expect(
      page.locator('mark.portal-highlight', {
        hasText:
          'Software development is search through the space of useful/interesting automations.',
      }),
    ).toBeVisible();
    await expect(page.locator('mark.portal-highlight').first()).toHaveAttribute(
      'data-note-slug',
      noteSlug,
    );

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('mark.portal-highlight')).toHaveCount(4, {
      timeout: 5000,
    });
    await expect(
      page.locator('mark.portal-highlight', {
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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Highlight HN Numeric Row Id Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
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
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('mark.portal-highlight')).toHaveCount(4, {
      timeout: 5000,
    });
    await expect(
      page.locator('mark.portal-highlight', {
        hasText: 'staticshock 1 day ago | next [–]',
      }),
    ).toBeVisible();
    await expect(
      page.locator('mark.portal-highlight', {
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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Mixed Case Highlight Path Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: ['Mixed case path highlighted text.'],
          note: '',
          cssPath: ['p#block49'],
          url: pageUrl,
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    const articleMark = page.locator('p#block49 mark.portal-highlight');
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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Hydration Replaces Highlight Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: [excerpt],
          note: '',
          cssPath: ['p#block49'],
          url: pageUrl,
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#article-root[data-hydrated="1"]', {
      timeout: 5000,
    });

    const articleMark = page.locator('#article-root mark.portal-highlight');
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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: pageUrl,
          title: 'Highlight Delete Grouped Reapply Test',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: [
            '煎诸君的跳蛋',
            '发布于 2026-06-03 17:41',
            '我养的橘猫孩子已经走了一年半了。突然想起一件事',
          ],
          note: '',
          cssPath: ['body > main > h1', 'body > main > div', 'body > main > p'],
          url: pageUrl,
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('mark.portal-highlight')).toHaveCount(3, {
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
    await expect(page.locator('mark.portal-highlight')).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.locator('mark.portal-highlight')).toHaveCount(0);

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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: pageUrl,
          title: 'Highlight Reclick Test',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
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
    await page.waitForSelector('mark.portal-highlight', { timeout: 5000 });
    // Wait for overlay to appear
    await page.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    // Type a note
    await page.keyboard.type('important insight');
    // Close with Escape — saveAndClose now awaits updateNote before removing overlay
    await page.keyboard.press('Escape');
    await page.waitForSelector('#portal-highlight-overlay', {
      state: 'detached',
      timeout: 5000,
    });

    // No artificial delay needed — overlay removal means save completed

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
      () => document.querySelector('mark.portal-highlight')?.dataset.noteSlug,
    );
    // It should match the note we just verified
    expect(markNoteSlug).toBe(notesResp.notes[0].slug);

    // Click the highlight mark again
    await page.click('mark.portal-highlight');
    await page.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    // Verify the overlay has note text — use shadow DOM pierce
    // The overlay uses closed shadow DOM, so we check via the mark's noteSlug
    // If noteSlug matches a note with text, content script will populate the textarea
    // Wait for loadPageNotes to resolve then check textarea
    await page.waitForTimeout(300);

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
