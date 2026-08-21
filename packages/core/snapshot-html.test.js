import { describe, expect, it } from 'vitest';

import {
  prepareSnapshotHtml,
  validateSnapshotIdentity,
} from './snapshot-html.js';

describe('snapshot HTML preparation', () => {
  it('is idempotent across capture and repair use', () => {
    const source = `<!doctype html><html><head>
      <link data-rel="preload" rel="stylesheet preload" href="https://example.test/missing.css">
      <link rel="stylesheet" href="data:text/css,body%7Bcolor:red%7D">
      <style>main { color: green; }</style>
      <script id="savepage-shadowloader">savepage_ShadowLoader(5);</script>
    </head><body>
      <snapshot-card><template data-savepage-shadowroot=""><p>Shadow content</p></template></snapshot-card>
      <mark class="kept browser-recall-highlight" data-highlight-text="saved" data-note-slug="note-1">Remember me</mark>
    </body></html>`;

    const prepared = prepareSnapshotHtml(source, {
      slug: 'page-&-slug',
      url: 'https://example.test/?a=1&b="two"',
    });

    expect(
      prepareSnapshotHtml(prepared, {
        slug: 'page-&-slug',
        url: 'https://example.test/?a=1&b="two"',
      }),
    ).toBe(prepared);
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
    expect(prepared).not.toContain('savepage-shadowloader');
    expect(prepared).toContain(
      'template data-savepage-shadowroot="" shadowrootmode="open"',
    );
  });

  it('does not rewrite serialized tags inside an iframe srcdoc attribute', () => {
    const nested =
      '<iframe srcdoc="<legacy-card><template data-savepage-shadowroot=&quot;&quot;>nested</template></legacy-card>"></iframe>';

    expect(prepareSnapshotHtml(nested, { slug: 'legacy-page' })).toContain(
      'srcdoc="<legacy-card><template data-savepage-shadowroot=&quot;&quot;>nested</template></legacy-card>"',
    );
  });

  it('adds missing URL identity to a snapshot that already has its slug', () => {
    const legacy =
      '<html><head><meta name="x-browser-recall-slug" content="legacy-page"></head><body>Legacy</body></html>';

    const prepared = prepareSnapshotHtml(legacy, {
      slug: 'legacy-page',
      url: 'https://example.test/legacy',
    });

    expect(prepared.match(/x-browser-recall-slug/g)).toHaveLength(1);
    expect(prepared).toContain(
      '<meta name="x-browser-recall-url" content="https://example.test/legacy">',
    );
  });

  it('replaces conflicting and duplicate identity with one authoritative pair', () => {
    const source = `<html><head>
      <meta name="x-browser-recall-slug" content="spoofed-slug">
      <meta content="https://spoofed.example/" name="x-browser-recall-url">
      <meta name="x-browser-recall-slug" content="duplicate-slug">
      <meta name=x-browser-recall-url content=https://unquoted.example/>
    </head><body>Source page</body></html>`;

    const prepared = prepareSnapshotHtml(source, {
      slug: 'canonical-slug',
      url: 'https://example.test/canonical',
    });

    expect(prepared.match(/x-browser-recall-slug/g)).toHaveLength(1);
    expect(prepared.match(/x-browser-recall-url/g)).toHaveLength(1);
    expect(prepared).toContain(
      '<meta name="x-browser-recall-slug" content="canonical-slug">',
    );
    expect(prepared).toContain(
      '<meta name="x-browser-recall-url" content="https://example.test/canonical">',
    );
    expect(prepared).not.toContain('spoofed');
    expect(prepared).not.toContain('duplicate-slug');
    expect(prepared).not.toContain('unquoted.example');
  });

  it('strictly validates the one current snapshot identity shape', () => {
    const valid = prepareSnapshotHtml('<html><head></head></html>', {
      slug: 'canonical-slug',
      url: 'https://example.test/canonical',
    });

    expect(validateSnapshotIdentity(valid, { slug: 'canonical-slug' })).toEqual(
      {
        slug: 'canonical-slug',
        url: 'https://example.test/canonical',
      },
    );
    expect(() =>
      validateSnapshotIdentity('<html><head></head></html>', {
        slug: 'canonical-slug',
      }),
    ).toThrow('exactly one x-browser-recall-slug');
  });
});
