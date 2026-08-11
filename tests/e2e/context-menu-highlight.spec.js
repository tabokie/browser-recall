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

test.describe('Context menu highlight', () => {
  test('contextMenuHighlight creates note for page', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/context-menu-create', {
      title: 'Example Article',
      body: '<main><p>key finding from the paper</p></main>',
    });
    const url = localServer.url('/context-menu-create');
    const slug = getSlugForUrl(url);
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Example Article',
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': now },
          createdAt: now,
          visitDates: [],
          scrollDepth: null,
          timeOnPage: null,
          user_title: null,
          likes: null,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.locator('p').selectText();
    const helper = await openHelperPage(extContext, extensionId);
    const resp = await helper.evaluate(
      ({ url, text }) =>
        chrome.runtime.sendMessage({
          action: 'contextMenuHighlight',
          url,
          title: 'Example Article',
          selectionText: text,
        }),
      { url, text: 'key finding from the paper' },
    );
    expect(resp.success).toBe(true);
    expect(resp.noteSlug).toBeTruthy();

    const notesResp = await helper.evaluate(
      (slug) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug }),
      slug,
    );
    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].excerpt).toEqual(['key finding from the paper']);

    await helper.close();
    await page.close();
  });

  test('contextMenuHighlight preserves cross-block selection newlines', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/ctx-lines', {
      title: 'Ctx Lines',
      body: '<main><p>first line</p><p>second line</p><p>third line</p></main>',
    });
    const pageUrl = localServer.url('/ctx-lines');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Ctx Lines',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: [],
          createdAt: now,
          visitDates: [],
          scrollDepth: null,
          timeOnPage: null,
          user_title: null,
          likes: null,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      const paragraphs = document.querySelectorAll('p');
      const range = document.createRange();
      range.setStart(paragraphs[0].firstChild, 0);
      range.setEnd(paragraphs[2].firstChild, paragraphs[2].textContent.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const helper = await openHelperPage(extContext, extensionId);
    const resp = await helper.evaluate(
      ({ url }) =>
        chrome.runtime.sendMessage({
          action: 'contextMenuHighlight',
          url,
          title: 'Ctx Lines',
          selectionText: 'first line second line third line',
        }),
      { url: pageUrl },
    );
    expect(resp.success).toBe(true);
    expect(resp.noteSlug).toBeTruthy();

    const notesResp = await helper.evaluate(
      (pageSlug) =>
        chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: pageSlug }),
      slug,
    );
    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].excerpt).toEqual([
      'first line',
      'second line',
      'third line',
    ]);
    expect(notesResp.notes[0].cssPath).toEqual([
      'browser-recall-text-anchor:v1:{"selector":"body > main > p:nth-of-type(1)","start":0,"end":10}',
      'browser-recall-text-anchor:v1:{"selector":"body > main > p:nth-of-type(2)","start":0,"end":11}',
      'browser-recall-text-anchor:v1:{"selector":"body > main > p:nth-of-type(3)","start":0,"end":10}',
    ]);

    await helper.close();
    await page.close();
  });

  test('highlights panel appears after context menu highlight', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/ctx-test', {
      title: 'Ctx Test',
      body: '<p>important excerpt</p>',
    });
    const pageUrl = localServer.url('/ctx-test');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Ctx Test',
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': now },
          createdAt: now,
          visitDates: [],
          scrollDepth: null,
          timeOnPage: null,
          user_title: null,
          likes: null,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('p').selectText();

    const helper = await openHelperPage(extContext, extensionId);
    const response = await helper.evaluate(
      ({ url, text }) =>
        chrome.runtime.sendMessage({
          action: 'contextMenuHighlight',
          url,
          title: 'Ctx Test',
          selectionText: text,
        }),
      { url: pageUrl, text: 'important excerpt' },
    );
    expect(response).toMatchObject({ success: true });

    await page.waitForSelector('#browser-recall-highlights-panel', {
      timeout: 5000,
    });
    const panelText = await page.evaluate(() => {
      const panel = document.getElementById('browser-recall-highlights-panel');
      return panel?.shadowRoot?.textContent || '';
    });
    expect(panelText).toContain('important excerpt');
    const panelBorderRun = await longestLeftBorderRun(
      page.locator('#browser-recall-highlights-panel'),
    );
    expect(panelBorderRun).toBeGreaterThanOrEqual(2);
    await page.close();
    await helper.close();
  });

  test('highlights panel lists all notes', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/ctx-multi', {
      title: 'Multi',
      body: '<p>third</p>',
    });
    const pageUrl = localServer.url('/ctx-multi');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();
    const wrappedQuoteLine =
      'first line deliberately long enough to wrap across multiple visual lines inside the highlights panel';

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'Multi',
          timestamps: { 'test-device': now },
          parentIds: [],
          childIds: ['note:note-a', 'note:note-b'],
          createdAt: now,
          visitDates: [],
          scrollDepth: null,
          timeOnPage: null,
          user_title: null,
          likes: null,
        }),
      },
      {
        path: 'objects/notes/note-a.json',
        data: noteEntityFixture({
          slug: 'note-a',
          excerpt: [`${wrappedQuoteLine}\nfirst second line`],
          note: 'my note',
          cssPath: [''],
          url: pageUrl,
          deleted: false,
          deletedTs: null,
          deletionReason: null,
          replacedBy: null,
        }),
      },
      {
        path: 'objects/notes/note-b.json',
        data: noteEntityFixture({
          slug: 'note-b',
          excerpt: ['second'],
          note: '',
          cssPath: [''],
          url: pageUrl,
          deleted: false,
          deletedTs: null,
          deletionReason: null,
          replacedBy: null,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('p').selectText();

    const helper = await openHelperPage(extContext, extensionId);
    const response = await helper.evaluate(
      ({ url }) =>
        chrome.runtime.sendMessage({
          action: 'contextMenuHighlight',
          url,
          title: 'Multi',
          selectionText: 'third',
        }),
      { url: pageUrl },
    );
    expect(response).toMatchObject({ success: true });

    await page.waitForSelector('#browser-recall-highlights-panel', {
      timeout: 5000,
    });
    const panelDetails = await page.evaluate(() => {
      const panel = document.getElementById('browser-recall-highlights-panel');
      const items = [
        ...(panel?.shadowRoot?.querySelectorAll('.highlight-item') || []),
      ];
      const firstItem = items.find(
        (item) => item.dataset.noteSlug === 'note-a',
      );
      const firstQuote = firstItem?.querySelector('.highlight-quote');
      const firstQuoteLines = [
        ...(firstQuote?.querySelectorAll('.highlight-quote-line') || []),
      ];
      const firstExcerpts = firstQuoteLines.map((line) =>
        line.querySelector('.highlight-excerpt'),
      );
      const quoteStyle = getComputedStyle(firstQuote);
      const colorProbe = document.createElement('span');
      colorProbe.style.color = 'var(--br-text-primary)';
      panel?.shadowRoot?.appendChild(colorProbe);
      const textPrimary = getComputedStyle(colorProbe).color;
      colorProbe.style.color = 'var(--br-accent-red)';
      const accentRed = getComputedStyle(colorProbe).color;
      colorProbe.remove();
      const range = document.createRange();
      range.selectNodeContents(firstQuote);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const selectedText = selection.toString();
      selection.removeAllRanges();
      return {
        count: items.length,
        texts: items.map((item) =>
          [...item.querySelectorAll('.highlight-excerpt')]
            .map((excerpt) => excerpt.textContent || '')
            .join('\n'),
        ),
        firstWhiteSpaces: firstExcerpts.map(
          (excerpt) => getComputedStyle(excerpt).whiteSpace,
        ),
        firstLineCount: firstQuoteLines.length,
        firstVisualLineCount: firstExcerpts[0]?.getClientRects().length,
        quoteBorderColor: quoteStyle.borderLeftColor,
        quoteBorderStyle: quoteStyle.borderLeftStyle,
        quoteBorderWidth: quoteStyle.borderLeftWidth,
        quoteHeight: firstQuote.getBoundingClientRect().height,
        firstHardLineHeight: firstQuoteLines[0].getBoundingClientRect().height,
        accentRed,
        textPrimary,
        excerptColors: firstExcerpts.map(
          (excerpt) => getComputedStyle(excerpt).color,
        ),
        excerptFontStyles: firstExcerpts.map(
          (excerpt) => getComputedStyle(excerpt).fontStyle,
        ),
        selectedText,
        markerLeft: firstItem
          ? firstItem.getBoundingClientRect().left +
            Number.parseFloat(getComputedStyle(firstItem).paddingLeft)
          : null,
        excerptLeft: firstExcerpts[0]?.getBoundingClientRect().left,
        annotationLeft: firstItem
          ?.querySelector('.highlight-note-row')
          ?.getBoundingClientRect().left,
      };
    });
    expect(panelDetails.count).toBe(3);
    expect(panelDetails.texts).toEqual(
      expect.arrayContaining([
        `${wrappedQuoteLine}\nfirst second line`,
        'second',
        'third',
      ]),
    );
    expect(panelDetails.firstWhiteSpaces).toEqual(['pre-wrap', 'pre-wrap']);
    expect(panelDetails).toMatchObject({
      firstLineCount: 2,
      quoteBorderColor: panelDetails.accentRed,
      quoteBorderStyle: 'solid',
      quoteBorderWidth: '3px',
      excerptColors: [panelDetails.textPrimary, panelDetails.textPrimary],
      excerptFontStyles: ['normal', 'normal'],
    });
    expect(panelDetails.firstVisualLineCount).toBeGreaterThan(1);
    expect(panelDetails.quoteHeight).toBeGreaterThan(
      panelDetails.firstHardLineHeight,
    );
    expect(panelDetails.selectedText).not.toContain('>');
    expect(panelDetails.annotationLeft).toBeCloseTo(panelDetails.markerLeft, 1);
    expect(panelDetails.excerptLeft).toBeGreaterThan(
      panelDetails.annotationLeft,
    );

    await page.close();
    await helper.close();
  });
});
