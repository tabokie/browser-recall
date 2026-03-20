import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage } from './helpers.js';

test.describe('Highlight note edit', () => {

  test('note text persists after edit without page reload', async ({ extContext, extensionId, setupDir, localServer }) => {
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
      { path: `pages/${slug}.json`, data: {
        slug, url: pageUrl, title: 'Note Edit Test', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'quick brown fox', note: '',
        cssPath: null, url: pageUrl,
      }},
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    // Wait for highlight to be applied by content script
    await page.waitForSelector('mark.portal-highlight', { timeout: 5000 });

    // Verify initial noteSlug is set on the mark
    const initialNoteSlug = await page.evaluate(() =>
      document.querySelector('mark.portal-highlight')?.dataset.noteSlug
    );
    expect(initialNoteSlug).toBe(noteSlug);

    // Click the highlight mark to open the edit overlay
    await page.click('mark.portal-highlight');
    await page.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    // Textarea is auto-focused — type a note
    await page.keyboard.type('my important note');

    // Press Escape to save and close
    await page.keyboard.press('Escape');
    await page.waitForSelector('#portal-highlight-overlay', { state: 'detached', timeout: 3000 });

    // Wait for updateNote to complete (async message to background)
    await page.waitForTimeout(500);

    // Click the highlight again to re-open the overlay
    await page.click('mark.portal-highlight');
    await page.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    // The note text should be visible — verify via the mark's noteSlug
    // has been updated to the new slug (updateNote creates a replacement note)
    const updatedNoteSlug = await page.evaluate(() =>
      document.querySelector('mark.portal-highlight')?.dataset.noteSlug
    );
    // The noteSlug should have CHANGED (replace_note creates a new slug)
    expect(updatedNoteSlug).toBeTruthy();
    expect(updatedNoteSlug).not.toBe(noteSlug);

    // Verify the new note has the text via background
    const helper = await openHelperPage(extContext, extensionId);
    const notesResp = await helper.evaluate((s) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s })
    , slug);
    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].note).toBe('my important note');
    // The notes array should contain the new slug, not the old one
    expect(notesResp.notes[0].slug).toBe(updatedNoteSlug);

    await helper.close();
    await page.close();
  });

});
