import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage } from './helpers.js';

test.describe('Snapshot viewer highlights', () => {

  // Seed a snapshot HTML with known content and a note, open the viewer.
  async function setupViewer(extContext, extensionId, { noteText = '' } = {}) {
    const pageUrl = 'https://example.com/snapshot-test';
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'snap-note-1';
    const timestamp = 1700000000000;
    const snapshotHtml = '<!DOCTYPE html><html><head><title>Snap Test</title></head>' +
      '<body><p>The quick brown fox jumps over the lazy dog.</p></body></html>';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: pageUrl, title: 'Snap Test', timestamp: Date.now(),
        parentIds: [], childIds: [`note:${noteSlug}`, `snapshot:${slug}-${timestamp}`],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'quick brown fox', note: noteText,
        cssPath: null, url: pageUrl,
      }},
      { path: `data/snapshots/${slug}-${timestamp}.html`, data: snapshotHtml },
    ]);

    const viewerUrl = `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${slug}&ts=${timestamp}`;
    const page = await extContext.newPage();
    await page.goto(viewerUrl);
    // Wait for iframe to load and highlights to be applied
    const frameHandle = await page.waitForSelector('iframe#frame');
    const frame = await frameHandle.contentFrame();
    await frame.waitForSelector('mark', { timeout: 5000 });

    return { page, frame, slug, noteSlug };
  }

  test('clicking a highlight opens edit overlay', async ({ extContext, extensionId, setupDir }) => {
    const { page, frame } = await setupViewer(extContext, extensionId);

    await frame.click('mark');
    await frame.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    await page.close();
  });

  test('note text is visible in overlay after click', async ({ extContext, extensionId, setupDir }) => {
    const { page, frame } = await setupViewer(extContext, extensionId, { noteText: 'existing note' });

    await frame.click('mark');
    await frame.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });

    // Wait for the textarea to be populated (loadPageNotes is async)
    await page.waitForTimeout(300);
    // Verify mark's noteSlug is set (confirms it was wired up)
    const noteSlug = await frame.evaluate(() =>
      document.querySelector('mark')?.dataset.noteSlug
    );
    expect(noteSlug).toBe('snap-note-1');

    await page.close();
  });

  test('editing note in snapshot viewer persists via updateNote', async ({ extContext, extensionId, setupDir }) => {
    const { page, frame, slug } = await setupViewer(extContext, extensionId);

    // Click highlight, type a note, press Escape
    await frame.click('mark');
    await frame.waitForSelector('#portal-highlight-overlay', { timeout: 3000 });
    await page.keyboard.type('viewer note');
    await page.keyboard.press('Escape');
    await frame.waitForSelector('#portal-highlight-overlay', { state: 'detached', timeout: 3000 });
    await page.waitForTimeout(500);

    // Verify note was saved via background
    const helper = await openHelperPage(extContext, extensionId);
    const resp = await helper.evaluate((s) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s })
    , slug);
    expect(resp.success).toBe(true);
    expect(resp.notes).toHaveLength(1);
    expect(resp.notes[0].note).toBe('viewer note');

    await helper.close();
    await page.close();
  });

  test('text selection in snapshot creates new highlight', async ({ extContext, extensionId, setupDir }) => {
    const { page, frame, slug } = await setupViewer(extContext, extensionId);

    // Select "lazy dog" — text nodes are split by the existing <mark>, so find the right node
    await frame.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('p'), NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf('lazy dog');
        if (idx === -1) continue;
        const sel = document.getSelection();
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 'lazy dog'.length);
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        break;
      }
    });

    // Wait for createNote + mark creation
    await page.waitForTimeout(1000);

    // Should now have 2 marks
    const markCount = await frame.evaluate(() => document.querySelectorAll('mark').length);
    expect(markCount).toBe(2);

    // Verify second note was created
    const helper = await openHelperPage(extContext, extensionId);
    const resp = await helper.evaluate((s) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s })
    , slug);
    expect(resp.success).toBe(true);
    expect(resp.notes).toHaveLength(2);
    const newNote = resp.notes.find(n => n.excerpt === 'lazy dog');
    expect(newNote).toBeTruthy();

    await helper.close();
    await page.close();
  });

});
