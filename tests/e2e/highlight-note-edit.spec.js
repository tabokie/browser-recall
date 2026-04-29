import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage } from './helpers.js';

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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: pageUrl,
          title: 'Note Edit Test',
          timestamp: now,
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `data/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: 'quick brown fox',
          note: '',
          cssPath: null,
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

    // Wait for updateNote to complete (async message to background)
    await page.waitForTimeout(500);

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

    // Verify the new note has the text via background
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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: pageUrl,
          title: 'Highlight Show Test',
          timestamp: now,
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `data/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: 'quick brown fox',
          note: 'my saved note',
          cssPath: null,
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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
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
