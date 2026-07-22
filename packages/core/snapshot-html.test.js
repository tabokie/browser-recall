import { describe, expect, it } from 'vitest';

import { prepareSnapshotHtml } from './snapshot-html.js';

describe('snapshot HTML preparation', () => {
  it('is idempotent across capture and repair use', () => {
    const source = `<!doctype html><html><head>
      <link data-rel="preload" rel="stylesheet preload" href="https://example.test/missing.css">
      <link rel="stylesheet" href="data:text/css,body%7Bcolor:red%7D">
      <style>main { color: green; }</style>
    </head><body>
      <mark class="kept browser-recall-highlight" data-highlight-text="saved" data-note-slug="note-1">Remember me</mark>
    </body></html>`;

    const prepared = prepareSnapshotHtml(source, {
      slug: 'page-&-slug',
      url: 'https://example.test/?a=1&b="two"',
    });

    expect(prepareSnapshotHtml(prepared, { slug: 'ignored' })).toBe(prepared);
    expect(prepared).toContain(
      'data-browser-recall-unavailable-href="https://example.test/missing.css"',
    );
    expect(prepared).toContain('href="data:text/css,body%7Bcolor:red%7D"');
    expect(prepared).toContain('<style>main { color: green; }</style>');
    expect(prepared).toContain(
      '<meta name="x-browser-recall-slug" content="page-&amp;-slug">',
    );
    expect(prepared).toContain('a=1&amp;b=&quot;two&quot;');
    expect(prepared).toContain('Remember me');
    expect(prepared).not.toContain('<mark');
    expect(prepared).not.toContain('data-highlight-text');
    expect(prepared).not.toContain('data-note-slug');
  });
});
