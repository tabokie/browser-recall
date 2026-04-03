import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { parseBookmarkHtml } from '../extension/bookmark-parser.js';

// Provide DOMParser globally for the parser module
const dom = new JSDOM('');
global.DOMParser = dom.window.DOMParser;

// Helper to build Netscape Bookmark Format HTML
function bookmarkFile(body) {
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${body}
</DL><p>`;
}

function folder(title, ...children) {
  return `<DT><H3>${title}</H3>\n<DL><p>\n${children.join('\n')}\n</DL><p>`;
}

function bookmark(title, url) {
  return `<DT><A HREF="${url}" ADD_DATE="1234567890">${title}</A>`;
}

describe('parseBookmarkHtml', () => {
  it('parses a basic tree with one folder and bookmarks', () => {
    const html = bookmarkFile(
      folder('Dev',
        bookmark('GitHub', 'https://github.com'),
        bookmark('MDN', 'https://developer.mozilla.org'),
      )
    );
    const result = parseBookmarkHtml(html);
    expect(result.children).toHaveLength(1);
    const dev = result.children[0];
    expect(dev.title).toBe('Dev');
    expect(dev.bookmarks).toHaveLength(2);
    expect(dev.bookmarks[0]).toEqual({ url: 'https://github.com', title: 'GitHub' });
    expect(dev.bookmarks[1]).toEqual({ url: 'https://developer.mozilla.org', title: 'MDN' });
    expect(dev.bookmarkCount).toBe(2);
    expect(dev.subfolderCount).toBe(0);
    expect(dev.children).toHaveLength(0);
    expect(dev.skipped).toHaveLength(0);
  });

  it('parses nested folders (3 levels deep)', () => {
    const html = bookmarkFile(
      folder('Top',
        folder('Middle',
          folder('Bottom',
            bookmark('Deep Link', 'https://example.com/deep'),
          ),
          bookmark('Mid Link', 'https://example.com/mid'),
        ),
        bookmark('Top Link', 'https://example.com/top'),
      )
    );
    const result = parseBookmarkHtml(html);
    const top = result.children[0];
    expect(top.title).toBe('Top');
    expect(top.bookmarks).toHaveLength(1);
    expect(top.subfolderCount).toBe(1);
    // Recursive bookmark count: 1 (top) + 1 (mid) + 1 (bottom) = 3
    expect(top.bookmarkCount).toBe(3);

    const mid = top.children[0];
    expect(mid.title).toBe('Middle');
    expect(mid.bookmarks).toHaveLength(1);
    expect(mid.bookmarkCount).toBe(2); // 1 own + 1 in Bottom
    expect(mid.subfolderCount).toBe(1);

    const bottom = mid.children[0];
    expect(bottom.title).toBe('Bottom');
    expect(bottom.bookmarks).toHaveLength(1);
    expect(bottom.bookmarkCount).toBe(1);
    expect(bottom.subfolderCount).toBe(0);
  });

  it('handles empty folders', () => {
    const html = bookmarkFile(
      folder('Empty Folder') +
      folder('Has Links', bookmark('A', 'https://a.com'))
    );
    const result = parseBookmarkHtml(html);
    expect(result.children).toHaveLength(2);
    const empty = result.children[0];
    expect(empty.title).toBe('Empty Folder');
    expect(empty.bookmarks).toHaveLength(0);
    expect(empty.bookmarkCount).toBe(0);
    expect(empty.children).toHaveLength(0);
  });

  it('filters non-web URLs and puts them in skipped', () => {
    const html = bookmarkFile(
      folder('Mixed',
        bookmark('Good', 'https://example.com'),
        bookmark('JS Bookmarklet', 'javascript:void(0)'),
        bookmark('Chrome Internal', 'chrome://settings'),
        bookmark('Extension', 'chrome-extension://abc123/page.html'),
        bookmark('Data URI', 'data:text/html,hello'),
        bookmark('File', 'file:///home/user/doc.pdf'),
        bookmark('HTTP', 'http://insecure.com'),
      )
    );
    const result = parseBookmarkHtml(html);
    const mixed = result.children[0];
    // Only http and https pass
    expect(mixed.bookmarks).toHaveLength(2);
    expect(mixed.bookmarks[0].url).toBe('https://example.com');
    expect(mixed.bookmarks[1].url).toBe('http://insecure.com');
    // The rest are skipped
    expect(mixed.skipped).toHaveLength(5);
    expect(mixed.skipped.map(s => s.url)).toEqual([
      'javascript:void(0)',
      'chrome://settings',
      'chrome-extension://abc123/page.html',
      'data:text/html,hello',
      'file:///home/user/doc.pdf',
    ]);
    // Each skipped entry has a reason
    for (const s of mixed.skipped) {
      expect(s.reason).toBeTruthy();
    }
    // bookmarkCount only counts valid bookmarks
    expect(mixed.bookmarkCount).toBe(2);
  });

  it('handles missing href attribute', () => {
    const html = bookmarkFile(
      folder('Bad',
        '<DT><A>No Href</A>',
        bookmark('Good', 'https://example.com'),
      )
    );
    const result = parseBookmarkHtml(html);
    const bad = result.children[0];
    expect(bad.bookmarks).toHaveLength(1);
    expect(bad.bookmarks[0].url).toBe('https://example.com');
    expect(bad.skipped).toHaveLength(1);
    expect(bad.skipped[0].title).toBe('No Href');
  });

  it('handles empty href attribute', () => {
    const html = bookmarkFile(
      folder('Bad',
        '<DT><A HREF="">Empty</A>',
        bookmark('Good', 'https://example.com'),
      )
    );
    const result = parseBookmarkHtml(html);
    const bad = result.children[0];
    expect(bad.bookmarks).toHaveLength(1);
    expect(bad.skipped).toHaveLength(1);
    expect(bad.skipped[0].title).toBe('Empty');
  });

  it('preserves special characters in titles', () => {
    // Real exports entity-encode angle brackets, so use &lt; &gt;
    const html = bookmarkFile(
      folder('Café &amp; "Quotes" &lt;Tags&gt;',
        bookmark('Über &amp; Größe', 'https://example.com'),
      )
    );
    const result = parseBookmarkHtml(html);
    const folder_ = result.children[0];
    expect(folder_.title).toBe('Café & "Quotes" <Tags>');
    expect(folder_.bookmarks[0].title).toBe('Über & Größe');
  });

  it('handles minimal file with a single bookmark in root', () => {
    // Some exports put bookmarks directly at root level (no folder)
    const html = bookmarkFile(
      bookmark('Lone Bookmark', 'https://lone.com')
    );
    const result = parseBookmarkHtml(html);
    // Root-level bookmarks go into result.bookmarks
    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0].url).toBe('https://lone.com');
  });

  it('handles multiple top-level folders (Chrome structure)', () => {
    const html = bookmarkFile(
      folder('Bookmarks Bar',
        bookmark('A', 'https://a.com'),
      ) +
      folder('Other Bookmarks',
        bookmark('B', 'https://b.com'),
      ) +
      folder('Mobile Bookmarks')
    );
    const result = parseBookmarkHtml(html);
    expect(result.children).toHaveLength(3);
    expect(result.children[0].title).toBe('Bookmarks Bar');
    expect(result.children[1].title).toBe('Other Bookmarks');
    expect(result.children[2].title).toBe('Mobile Bookmarks');
  });

  it('handles malformed HTML gracefully (unclosed tags)', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3>Broken</H3>
<DL><p>
<DT><A HREF="https://ok.com">OK
</DL>`;
    // Should not throw — DOMParser handles malformed HTML
    const result = parseBookmarkHtml(html);
    expect(result.children.length).toBeGreaterThanOrEqual(1);
    const broken = result.children[0];
    expect(broken.bookmarks).toHaveLength(1);
    expect(broken.bookmarks[0].url).toBe('https://ok.com');
  });

  it('computes recursive bookmarkCount across nested folders', () => {
    const html = bookmarkFile(
      folder('Root',
        bookmark('R1', 'https://r1.com'),
        bookmark('R2', 'https://r2.com'),
        folder('Child A',
          bookmark('A1', 'https://a1.com'),
          folder('Grandchild',
            bookmark('G1', 'https://g1.com'),
            bookmark('G2', 'https://g2.com'),
          ),
        ),
        folder('Child B',
          bookmark('B1', 'https://b1.com'),
        ),
      )
    );
    const result = parseBookmarkHtml(html);
    const root = result.children[0];
    expect(root.bookmarkCount).toBe(6); // R1+R2+A1+G1+G2+B1
    expect(root.subfolderCount).toBe(2); // Child A, Child B
    expect(root.children[0].bookmarkCount).toBe(3); // A1+G1+G2
    expect(root.children[0].subfolderCount).toBe(1); // Grandchild
    expect(root.children[0].children[0].bookmarkCount).toBe(2); // G1+G2
    expect(root.children[1].bookmarkCount).toBe(1); // B1
  });

  it('handles Firefox place: URLs as skipped', () => {
    const html = bookmarkFile(
      folder('Firefox',
        bookmark('Recent Tags', 'place:type=6&sort=14&maxResults=10'),
        bookmark('Good', 'https://example.com'),
      )
    );
    const result = parseBookmarkHtml(html);
    const ff = result.children[0];
    expect(ff.bookmarks).toHaveLength(1);
    expect(ff.skipped).toHaveLength(1);
    expect(ff.skipped[0].url).toContain('place:');
  });

  it('returns root-level title from the file', () => {
    const html = bookmarkFile(
      folder('A', bookmark('X', 'https://x.com'))
    );
    const result = parseBookmarkHtml(html);
    expect(result.title).toBe('Bookmarks');
  });
});
