import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  wrapRangeWithMark,
  findTextRange,
  highlightTextInPage,
  isBlockElement,
  getClosestBlock,
  isCrossBlock,
  splitSelectionByBlock,
  highlightSavedExcerptPartsInPage,
} from '../../apps/extension/highlight-helpers.js';

await import('../../apps/extension/extension-surface.js');
const extensionSurface = globalThis.browserRecallExtensionSurface;

// Set up a fresh jsdom for each test
let dom;
beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://example.test/',
  });
  global.document = dom.window.document;
  global.NodeFilter = dom.window.NodeFilter;
  global.Node = dom.window.Node;
});

function setBody(html) {
  document.body.innerHTML = html;
}

function getMarks() {
  return document.querySelectorAll('mark.portal-highlight');
}

// --- Case 1: Plain text, no styling ---
describe('Case 1: plain text (single text node)', () => {
  it('highlights text within a single paragraph', () => {
    setBody('<p>The quick brown fox jumps over the lazy dog.</p>');
    const mark = highlightTextInPage(document.body, 'brown fox');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('brown fox');
    expect(mark.dataset.highlightText).toBe('brown fox');
    expect(getMarks().length).toBe(1);
    // Surrounding text preserved
    expect(document.body.textContent).toBe(
      'The quick brown fox jumps over the lazy dog.',
    );
  });

  it('highlights text at the start of a node', () => {
    setBody('<p>Hello world</p>');
    const mark = highlightTextInPage(document.body, 'Hello');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('Hello');
  });

  it('highlights text at the end of a node', () => {
    setBody('<p>Hello world</p>');
    const mark = highlightTextInPage(document.body, 'world');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('world');
  });

  it('returns null for text not in the document', () => {
    setBody('<p>Hello world</p>');
    const mark = highlightTextInPage(document.body, 'foobar');
    expect(mark).toBeNull();
  });

  it('highlights first occurrence when text appears multiple times', () => {
    setBody('<p>foo bar foo</p>');
    const mark = highlightTextInPage(document.body, 'foo');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('foo');
    // Only one mark should be created
    expect(getMarks().length).toBe(1);
  });
});

// --- Case 2: Inline styles (cross-inline-node, same block) ---
describe('Case 2: inline styled text (cross-inline nodes)', () => {
  it('highlights text spanning <strong><code> and plain text', () => {
    // MDN pattern: "The HTTP <strong><code>Referer</code></strong> request header"
    setBody(
      '<p>The HTTP <strong><code>Referer</code></strong> request header</p>',
    );
    const mark = highlightTextInPage(document.body, 'Referer request header');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('Referer request header');
    expect(getMarks().length).toBe(1);
    // Full paragraph text preserved
    expect(document.body.textContent).toBe('The HTTP Referer request header');
  });

  it('highlights text spanning <em> tags', () => {
    // MDN pattern: "an <em>origin</em>, <em>path</em>, and <em>querystring</em>"
    setBody(
      '<p>an <em>origin</em>, <em>path</em>, and <em>querystring</em></p>',
    );
    const mark = highlightTextInPage(
      document.body,
      'origin, path, and querystring',
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('origin, path, and querystring');
    expect(getMarks().length).toBe(1);
  });

  it('highlights text spanning <a> and plain text', () => {
    setBody('<p>See <a href="/doc">the documentation</a> for details.</p>');
    const mark = highlightTextInPage(
      document.body,
      'the documentation for details',
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('the documentation for details');
  });

  it('highlights text fully inside an inline element', () => {
    setBody('<p>Click <strong>this bold text</strong> here.</p>');
    const mark = highlightTextInPage(document.body, 'this bold text');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('this bold text');
  });

  it('highlights text spanning multiple nested inline elements', () => {
    // <a><code>Referrer-Policy</code></a> pattern from MDN
    setBody(
      '<p>See <a href="/rp"><code>Referrer-Policy</code></a> for info.</p>',
    );
    const mark = highlightTextInPage(document.body, 'Referrer-Policy for info');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('Referrer-Policy for info');
  });

  it('does not break the DOM structure for surrounding elements', () => {
    setBody('<p>Before <em>hello</em> <strong>world</strong> after</p>');
    const mark = highlightTextInPage(document.body, 'hello world');
    expect(mark).not.toBeNull();
    // "Before " and " after" should still be in the paragraph
    expect(document.body.textContent).toBe('Before hello world after');
  });
});

// --- Code blocks ---
describe('Code blocks', () => {
  it('highlights multi-line text in a single text node inside pre>code', () => {
    setBody(
      '<pre><code>Referer: https://example.com\nReferer: https://other.com\n</code></pre>',
    );
    const mark = highlightTextInPage(
      document.body,
      'Referer: https://example.com\nReferer: https://other.com',
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe(
      'Referer: https://example.com\nReferer: https://other.com',
    );
  });

  it('highlights multi-line text across per-line spans in pre>code', () => {
    // MDN syntax highlighting often wraps each line in a span
    setBody(`<pre><code><span class="token">Referer: https://example.com</span>
<span class="token">Referer: https://other.com</span>
</code></pre>`);
    const mark = highlightTextInPage(
      document.body,
      'Referer: https://example.com\nReferer: https://other.com',
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe(
      'Referer: https://example.com\nReferer: https://other.com',
    );
  });

  it('highlights multi-line text across per-line spans with newlines as separate text nodes', () => {
    // Another common pattern: spans with text nodes for newlines between them
    setBody(
      '<pre><code><span>line1</span>\n<span>line2</span>\n<span>line3</span></code></pre>',
    );
    const mark = highlightTextInPage(document.body, 'line1\nline2\nline3');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('line1\nline2\nline3');
  });

  it('does not synthesize line breaks between separate paragraph blocks', () => {
    setBody('<div><p>first line</p><p>second line</p><p>third line</p></div>');
    const mark = highlightTextInPage(
      document.body,
      'first line\nsecond line\nthird line',
    );
    expect(mark).toBeNull();
  });
});

it('highlights multi-line text in MDN-style syntax-highlighted code block', () => {
  // Exact MDN structure: nested token spans with newline text nodes between lines
  setBody(`<pre><code><span class="token header"><span class="token header-name keyword">Referer</span><span class="token punctuation">:</span> <span class="token header-value">https://developer.mozilla.org/en-US/docs/Web/JavaScript</span></span>
<span class="token header"><span class="token header-name keyword">Referer</span><span class="token punctuation">:</span> <span class="token header-value">https://example.com/page?q=123</span></span>
<span class="token header"><span class="token header-name keyword">Referer</span><span class="token punctuation">:</span> <span class="token header-value">https://example.com/</span></span>
</code></pre>`);
  const text =
    'Referer: https://developer.mozilla.org/en-US/docs/Web/JavaScript\nReferer: https://example.com/page?q=123\nReferer: https://example.com/';
  const mark = highlightTextInPage(document.body, text);
  expect(mark).not.toBeNull();
  expect(mark.textContent).toBe(text);
  expect(getMarks().length).toBe(1);
});

it('highlights partial selection within MDN code block (single line)', () => {
  setBody(`<pre><code><span class="token header"><span class="token header-name keyword">Referer</span><span class="token punctuation">:</span> <span class="token header-value">https://example.com/</span></span>
</code></pre>`);
  const mark = highlightTextInPage(
    document.body,
    'Referer: https://example.com/',
  );
  expect(mark).not.toBeNull();
  expect(mark.textContent).toBe('Referer: https://example.com/');
});

it('wrapRangeWithMark works when text param differs from range content (trim mismatch)', () => {
  // Simulates: selection includes trailing newline but selectedText is trimmed
  setBody('<pre><code><span>line1</span>\n<span>line2</span>\n</code></pre>');
  const code = document.querySelector('code');
  const firstText = code.querySelector('span').firstChild; // "line1"
  const lastText = code.lastChild; // trailing "\n"

  const range = document.createRange();
  range.setStart(firstText, 0);
  range.setEnd(lastText, lastText.textContent.length);

  // The range covers "line1\nline2\n" but we pass trimmed text
  const mark = wrapRangeWithMark(range, 'line1\nline2');
  expect(mark).not.toBeNull();
  // The mark wraps the full range content (including trailing newline)
  expect(mark.textContent).toContain('line1');
  expect(mark.textContent).toContain('line2');
  // But dataset stores the trimmed version
  expect(mark.dataset.highlightText).toBe('line1\nline2');
});

// --- Shadow DOM ---
describe('Shadow DOM content', () => {
  it('highlights text inside an open shadow root', () => {
    setBody('<div id="host"></div>');
    const host = document.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<pre><code><span>Referer: https://example.com</span></code></pre>';

    const mark = highlightTextInPage(
      document.body,
      'Referer: https://example.com',
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('Referer: https://example.com');
    // Mark should be inside the shadow root
    expect(shadow.querySelector('mark.portal-highlight')).toBe(mark);
  });

  it('highlights text spanning multiple spans inside shadow root', () => {
    setBody('<div id="host"></div>');
    const host = document.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<pre><code><span class="keyword">Referer</span><span class="punct">:</span> <span class="value">https://example.com</span></code></pre>`;

    const mark = highlightTextInPage(
      document.body,
      'Referer: https://example.com',
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('Referer: https://example.com');
  });
});

// --- MDN-specific patterns ---
describe('MDN page patterns', () => {
  it('note box: strong label + link text', () => {
    setBody(`<div class="notecard note">
      <p><strong>Note:</strong> The header name "referer" is actually a misspelling.
      See <a href="/wiki" class="external">HTTP referer on Wikipedia</a> for details.</p>
    </div>`);
    const mark = highlightTextInPage(
      document.body,
      'The header name "referer" is actually a misspelling.',
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe(
      'The header name "referer" is actually a misspelling.',
    );
  });

  it('note box: selection spanning strong into text', () => {
    setBody(
      `<div class="notecard note"><p><strong>Note:</strong> The misspelling is intentional.</p></div>`,
    );
    const mark = highlightTextInPage(document.body, 'Note: The misspelling');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('Note: The misspelling');
  });

  it('definition list: text within a single dd paragraph', () => {
    setBody(`<dl>
      <dt id="url"><a href="#url"><code>&lt;url&gt;</code></a></dt>
      <dd><p>An absolute or partial address. URL fragments (i.e., <code>#section</code>) are not included.</p></dd>
    </dl>`);
    const mark = highlightTextInPage(
      document.body,
      'URL fragments (i.e., #section) are not included.',
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe(
      'URL fragments (i.e., #section) are not included.',
    );
  });

  it('heading with anchor link', () => {
    setBody(
      '<h2 id="syntax" class="heading"><a class="heading-anchor" href="#syntax">Syntax</a></h2>',
    );
    const mark = highlightTextInPage(document.body, 'Syntax');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('Syntax');
  });

  it('list item with code inside link', () => {
    setBody(`<ul>
      <li><a href="/rp"><code>Referrer-Policy</code></a></li>
      <li><a href="/origin"><code>Origin</code></a></li>
    </ul>`);
    const mark = highlightTextInPage(document.body, 'Referrer-Policy');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('Referrer-Policy');
  });

  it('table cell with link', () => {
    setBody(`<table><tbody>
      <tr><th scope="row">Header type</th><td><a href="/glossary">Request header</a></td></tr>
    </tbody></table>`);
    const mark = highlightTextInPage(document.body, 'Request header');
    expect(mark).not.toBeNull();
  });

  it('text adjacent to visually-hidden spans does not include hidden text', () => {
    setBody(
      `<td class="bc-support"><abbr class="icon" title="Full support"><span class="visually-hidden">Full support</span></abbr> 77</td>`,
    );
    // User sees and selects "77" — should not match hidden "Full support"
    const mark = highlightTextInPage(document.body, '77');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('77');
  });

  it('deeply nested code example with lit comments (light DOM)', () => {
    // Lit comments between elements shouldn't affect highlighting
    setBody(
      '<p><!--lit-part-->The <code>Referer</code><!--/lit-part--> header</p>',
    );
    const mark = highlightTextInPage(document.body, 'The Referer header');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('The Referer header');
  });

  it('cross-shadow-boundary selection falls back gracefully', () => {
    // Text starts in light DOM, continues in shadow DOM
    setBody('<p>Before shadow</p><div id="host"></div>');
    const host = document.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>Inside shadow</p>';
    // Selection spanning both — findTextRange would find it since collectTextNodes
    // traverses shadow roots, but the range crosses trees
    const mark = highlightTextInPage(
      document.body,
      'Before shadow Inside shadow',
    );
    // This SHOULD work since findTextRange concatenates all text including shadow
    // and wrapRangeWithMark uses extractContents
    // But the range spans different DOM trees (light + shadow) which may fail
    // We just need it to not corrupt the DOM
    if (mark) {
      expect(mark.textContent).toContain('Before shadow');
    }
    // Either works or returns null — either is acceptable
    // Key: no empty marks left in DOM
    const emptyMarks = [
      ...document.querySelectorAll('mark.portal-highlight'),
    ].filter((m) => !m.textContent);
    expect(emptyMarks.length).toBe(0);
  });
});

// --- findTextRange ---
describe('findTextRange', () => {
  it('finds range within a single text node', () => {
    setBody('<p>Hello world</p>');
    const range = findTextRange(document.body, 'world');
    expect(range).not.toBeNull();
    expect(range.toString()).toBe('world');
    expect(range.startContainer).toBe(range.endContainer);
  });

  it('finds range spanning two text nodes (across inline element)', () => {
    setBody('<p>Hello <em>beautiful</em> world</p>');
    const range = findTextRange(document.body, 'beautiful world');
    expect(range).not.toBeNull();
    expect(range.toString()).toBe('beautiful world');
    expect(range.startContainer).not.toBe(range.endContainer);
  });

  it('returns null for text not present', () => {
    setBody('<p>Hello world</p>');
    const range = findTextRange(document.body, 'xyz');
    expect(range).toBeNull();
  });

  it('skips text inside existing marks', () => {
    setBody('<p>Hello <mark class="portal-highlight">world</mark> end</p>');
    const range = findTextRange(document.body, 'world');
    // "world" is inside a mark, should be skipped
    expect(range).toBeNull();
  });
});

// --- wrapRangeWithMark ---
describe('wrapRangeWithMark', () => {
  it('wraps single-node range with surroundContents', () => {
    setBody('<p>Hello world</p>');
    const textNode = document.querySelector('p').firstChild;
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 11);

    const mark = wrapRangeWithMark(range, 'world', 12345);
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('world');
    expect(mark.dataset.highlightText).toBe('world');
    expect(mark.dataset.highlightTimestamp).toBe('12345');
    expect(document.body.textContent).toBe('Hello world');
  });

  it('wraps cross-node range with extractContents', () => {
    setBody('<p>Hello <em>beautiful</em> world</p>');
    const p = document.querySelector('p');
    // "beautiful" is in em's text node, " world" is p's last text node
    const emText = document.querySelector('em').firstChild;
    const afterText = p.lastChild; // " world"
    const range = document.createRange();
    range.setStart(emText, 0);
    range.setEnd(afterText, 6); // " world".length

    const mark = wrapRangeWithMark(range, 'beautiful world');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('beautiful world');
    expect(document.body.textContent).toBe('Hello beautiful world');
  });
});

// --- Case 3: Cross-block helpers ---
describe('Case 3: cross-block selection', () => {
  describe('getClosestBlock', () => {
    it('returns parent <p> for text in paragraph', () => {
      setBody('<p>Hello</p>');
      const text = document.querySelector('p').firstChild;
      expect(getClosestBlock(text)).toBe(document.querySelector('p'));
    });

    it('returns <li> for text in list item', () => {
      setBody('<ul><li>Item</li></ul>');
      const text = document.querySelector('li').firstChild;
      expect(getClosestBlock(text)).toBe(document.querySelector('li'));
    });

    it('skips inline elements to find block ancestor', () => {
      setBody('<p>Hello <em>world</em></p>');
      const emText = document.querySelector('em').firstChild;
      expect(getClosestBlock(emText)).toBe(document.querySelector('p'));
    });

    it('returns body for text not inside any block', () => {
      setBody('Just text');
      expect(getClosestBlock(document.body.firstChild)).toBe(document.body);
    });
  });

  describe('isCrossBlock', () => {
    it('returns false for range within a single paragraph', () => {
      setBody('<p>Hello <em>world</em></p>');
      const range = document.createRange();
      range.setStart(document.querySelector('p').firstChild, 0);
      range.setEnd(document.querySelector('em').firstChild, 5);
      expect(isCrossBlock(range)).toBe(false);
    });

    it('returns true for range spanning two paragraphs', () => {
      setBody('<div><p>First</p><p>Second</p></div>');
      const p1 = document.querySelectorAll('p')[0];
      const p2 = document.querySelectorAll('p')[1];
      const range = document.createRange();
      range.setStart(p1.firstChild, 0);
      range.setEnd(p2.firstChild, 6);
      expect(isCrossBlock(range)).toBe(true);
    });

    it('returns true for range spanning list items', () => {
      setBody('<ul><li>A</li><li>B</li></ul>');
      const li1 = document.querySelectorAll('li')[0];
      const li2 = document.querySelectorAll('li')[1];
      const range = document.createRange();
      range.setStart(li1.firstChild, 0);
      range.setEnd(li2.firstChild, 1);
      expect(isCrossBlock(range)).toBe(true);
    });
  });

  describe('splitSelectionByBlock', () => {
    it('splits selection across two paragraphs', () => {
      setBody('<div><p>First paragraph</p><p>Second paragraph</p></div>');
      const p1 = document.querySelectorAll('p')[0];
      const p2 = document.querySelectorAll('p')[1];
      const range = document.createRange();
      range.setStart(p1.firstChild, 0);
      range.setEnd(p2.firstChild, p2.firstChild.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual([
        'First paragraph',
        'Second paragraph',
      ]);
      expect(chunks[0].block).toBe(p1);
      expect(chunks[1].block).toBe(p2);
    });

    it('splits selection across list items', () => {
      setBody('<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>');
      const li1 = document.querySelectorAll('li')[0];
      const li3 = document.querySelectorAll('li')[2];
      const range = document.createRange();
      range.setStart(li1.firstChild, 0);
      range.setEnd(li3.firstChild, li3.firstChild.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual(['Item 1', 'Item 2', 'Item 3']);
      // Each chunk references its own <li>
      expect(chunks[0].block.tagName).toBe('LI');
      expect(chunks[2].block.tagName).toBe('LI');
    });

    it('handles partial selection at block boundaries', () => {
      setBody('<div><p>Hello world</p><p>Goodbye world</p></div>');
      const p1 = document.querySelectorAll('p')[0];
      const p2 = document.querySelectorAll('p')[1];
      const range = document.createRange();
      range.setStart(p1.firstChild, 6); // starts at "world"
      range.setEnd(p2.firstChild, 7); // ends at "Goodbye"

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual(['world', 'Goodbye']);
    });

    it('handles blocks with inline elements', () => {
      setBody('<div><p>Foo <em>bar</em> baz</p><p>Next</p></div>');
      const p1Text = document.querySelectorAll('p')[0].firstChild;
      const p2 = document.querySelectorAll('p')[1];
      const range = document.createRange();
      range.setStart(p1Text, 0);
      range.setEnd(p2.firstChild, p2.firstChild.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual(['Foo bar baz', 'Next']);
    });

    it('returns single chunk for same-block selection', () => {
      setBody('<p>Hello world</p>');
      const range = document.createRange();
      range.setStart(document.querySelector('p').firstChild, 0);
      range.setEnd(document.querySelector('p').firstChild, 11);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual(['Hello world']);
    });

    it('handles selection across divs', () => {
      setBody('<div><div>Block A</div><div>Block B</div></div>');
      const div1 = document.querySelectorAll('div > div')[0];
      const div2 = document.querySelectorAll('div > div')[1];
      const range = document.createRange();
      range.setStart(div1.firstChild, 0);
      range.setEnd(div2.firstChild, div2.firstChild.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual(['Block A', 'Block B']);
    });

    it('splits heading metadata divs from following body text', () => {
      setBody(`<main>
        <h1>煎诸君的跳蛋</h1>
        <div>发布于 2026-06-03 17:41</div>
        <p>我养的橘猫孩子已经走了一年半了。突然想起一件事</p>
      </main>`);
      const h1 = document.querySelector('h1');
      const paragraph = document.querySelector('p');
      const range = document.createRange();
      range.setStart(h1.firstChild, 0);
      range.setEnd(paragraph.firstChild, paragraph.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual([
        '煎诸君的跳蛋',
        '发布于 2026-06-03 17:41',
        '我养的橘猫孩子已经走了一年半了。突然想起一件事',
      ]);
      expect(chunks.map((c) => c.block.tagName)).toEqual(['H1', 'DIV', 'P']);
    });

    it('splits visual block children when selection starts inside inline metadata', () => {
      setBody(`<main>
        <div class="meta"><span>煎诸君的跳蛋</span> <span>发布于 2026-06-03 17:41</span></div>
        <div class="body">我养的橘猫孩子已经走了一年半了。突然想起一件事</div>
        <div class="body">它平时很警觉的，但某天我发现它一条猫瘫着。</div>
      </main>`);
      const firstSpan = document.querySelector('.meta span');
      const secondBody = document.querySelectorAll('.body')[1];
      const range = document.createRange();
      range.setStart(firstSpan.firstChild, 0);
      range.setEnd(secondBody.firstChild, secondBody.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual([
        '煎诸君的跳蛋 发布于 2026-06-03 17:41',
        '我养的橘猫孩子已经走了一年半了。突然想起一件事',
        '它平时很警觉的，但某天我发现它一条猫瘫着。',
      ]);
      expect(chunks.map((c) => c.block.className)).toEqual([
        'meta',
        'body',
        'body',
      ]);
    });

    it('splits direct text before child paragraphs in mixed comment blocks', () => {
      setBody(`<div class="commtext c00">Everything is search.
        <p>Software development is search through the space of useful/interesting automations.</p>
        <p>Business is search for product market fit.</p>
      </div>`);
      const commtext = document.querySelector('.commtext');
      const lastParagraph = document.querySelectorAll('p')[1];
      const range = document.createRange();
      range.setStart(commtext.firstChild, 0);
      range.setEnd(lastParagraph.firstChild, lastParagraph.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual([
        'Everything is search.',
        'Software development is search through the space of useful/interesting automations.',
        'Business is search for product market fit.',
      ]);
      expect(chunks.map((c) => c.block)).toEqual([
        commtext,
        document.querySelectorAll('p')[0],
        lastParagraph,
      ]);
    });

    it('trims whitespace from chunks', () => {
      setBody('<div><p>  Padded text  </p><p>  More text  </p></div>');
      const p1 = document.querySelectorAll('p')[0];
      const p2 = document.querySelectorAll('p')[1];
      const range = document.createRange();
      range.setStart(p1.firstChild, 0);
      range.setEnd(p2.firstChild, p2.firstChild.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual(['Padded text', 'More text']);
    });

    it('skips empty blocks', () => {
      setBody('<div><p>Content</p><p>   </p><p>More content</p></div>');
      const p1 = document.querySelectorAll('p')[0];
      const p3 = document.querySelectorAll('p')[2];
      const range = document.createRange();
      range.setStart(p1.firstChild, 0);
      range.setEnd(p3.firstChild, p3.firstChild.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual(['Content', 'More content']);
    });

    it('block-scoped search finds correct occurrence (not global first)', () => {
      // "Apple" appears in both <p> and <li>, but the chunk from <li> should
      // only be searched within that <li>
      setBody(
        '<div><p>Apple is a fruit</p><ul><li>Apple</li><li>Banana</li></ul></div>',
      );
      const li1 = document.querySelectorAll('li')[0];
      const li2 = document.querySelectorAll('li')[1];
      const range = document.createRange();
      range.setStart(li1.firstChild, 0);
      range.setEnd(li2.firstChild, li2.firstChild.textContent.length);

      const chunks = splitSelectionByBlock(range);
      expect(chunks.map((c) => c.text)).toEqual(['Apple', 'Banana']);
      // "Apple" chunk's block should be the <li>, not the <p>
      expect(chunks[0].block).toBe(li1);

      // Highlight scoped to blocks should mark the <li> Apple, not the <p> Apple
      const mark = highlightTextInPage(chunks[0].block, chunks[0].text);
      expect(mark).not.toBeNull();
      expect(mark.textContent).toBe('Apple');
      // The mark should be inside the <li>, not the <p>
      expect(mark.closest('li')).toBe(li1);
      // The <p>'s "Apple" should remain unmarked
      expect(document.querySelector('p').textContent).toContain('Apple');
    });
  });

  describe('end-to-end: highlight array chunks', () => {
    it('highlights each chunk from a split selection', () => {
      setBody(
        '<div><p>First paragraph text here</p><p>Second paragraph text here</p></div>',
      );
      const texts = ['First paragraph', 'Second paragraph'];
      const marks = texts
        .map((t) => highlightTextInPage(document.body, t))
        .filter(Boolean);
      expect(marks.length).toBe(2);
      expect(marks[0].textContent).toBe('First paragraph');
      expect(marks[1].textContent).toBe('Second paragraph');
      expect(getMarks().length).toBe(2);
    });

    it('highlights chunks from list items', () => {
      setBody(
        '<ul><li>Buy groceries</li><li>Walk the dog</li><li>Read a book</li></ul>',
      );
      const texts = ['Buy groceries', 'Walk the dog'];
      const marks = texts
        .map((t) => highlightTextInPage(document.body, t))
        .filter(Boolean);
      expect(marks.length).toBe(2);
      // Original list structure preserved
      expect(document.querySelectorAll('li').length).toBe(3);
    });

    it('handles chunks with inline formatting', () => {
      setBody(
        '<div><p>See <a href="/doc">the docs</a> here</p><p>Another <strong>block</strong></p></div>',
      );
      const texts = ['the docs here', 'Another block'];
      const marks = texts
        .map((t) => highlightTextInPage(document.body, t))
        .filter(Boolean);
      expect(marks.length).toBe(2);
    });
  });
});

describe('Saved highlight reapply', () => {
  it('reapplies array excerpt parts to their aligned css paths', () => {
    setBody(
      '<article><p>Author Meta First selected line</p><p>Second selected line</p><p>Third selected line</p></article>',
    );

    const marks = highlightSavedExcerptPartsInPage(
      document.body,
      [
        'Author Meta First selected line',
        'Second selected line',
        'Third selected line',
      ],
      [
        'article > p:nth-of-type(1)',
        'article > p:nth-of-type(2)',
        'article > p:nth-of-type(3)',
      ],
    );

    expect(marks).toHaveLength(3);
    expect([...getMarks()].map((mark) => mark.textContent)).toEqual([
      'Author Meta First selected line',
      'Second selected line',
      'Third selected line',
    ]);
    expect([...getMarks()].map((mark) => mark.dataset.highlightText)).toEqual([
      'Author Meta First selected line\nSecond selected line\nThird selected line',
      'Author Meta First selected line\nSecond selected line\nThird selected line',
      'Author Meta First selected line\nSecond selected line\nThird selected line',
    ]);
  });

  it('keeps cross-element highlights as explicit array parts without synthesized breaks', () => {
    setBody(`<article>
      <h1>煎诸君的跳蛋</h1>
      <div>发布于 2026-06-03 17:41</div>
      <p>我养的橘猫孩子已经走了一年半了。突然想起一件事</p>
      <p>它平时很警觉的，但某天我发现它一条猫瘫着。</p>
      <p>捞起来发现软绵绵一条，还温的，</p>
    </article>`);

    const marks = highlightSavedExcerptPartsInPage(
      document.body,
      [
        '煎诸君的跳蛋',
        '发布于 2026-06-03 17:41',
        '我养的橘猫孩子已经走了一年半了。突然想起一件事',
        '它平时很警觉的，但某天我发现它一条猫瘫着。',
        '捞起来发现软绵绵一条，还温的，',
      ],
      [
        'article > h1',
        'article > div',
        'article > p:nth-of-type(1)',
        'article > p:nth-of-type(2)',
        'article > p:nth-of-type(3)',
      ],
    );

    expect(marks).toHaveLength(5);
    expect([...getMarks()].map((mark) => mark.textContent)).toEqual([
      '煎诸君的跳蛋',
      '发布于 2026-06-03 17:41',
      '我养的橘猫孩子已经走了一年半了。突然想起一件事',
      '它平时很警觉的，但某天我发现它一条猫瘫着。',
      '捞起来发现软绵绵一条，还温的，',
    ]);
  });

  it('uses css paths to avoid marking an earlier duplicate elsewhere on the page', () => {
    setBody(`<main>
      <section class="unrelated"><p>Everything is search.</p></section>
      <section class="comment"><p>Everything is search.</p></section>
    </main>`);

    const marks = highlightSavedExcerptPartsInPage(
      document.body,
      ['Everything is search.'],
      ['main > section:nth-of-type(2) > p'],
    );

    expect(marks).toHaveLength(1);
    expect(document.querySelector('.unrelated mark')).toBeNull();
    expect(document.querySelector('.comment mark')?.textContent).toBe(
      'Everything is search.',
    );
  });

  it('does not search globally when a non-empty css path no longer resolves', () => {
    setBody(`<main>
      <section class="unrelated"><p>Everything is search.</p></section>
      <section class="comment"><p>Everything is search.</p></section>
    </main>`);

    const marks = highlightSavedExcerptPartsInPage(
      document.body,
      ['Everything is search.'],
      ['main > section:nth-of-type(3) > p'],
    );

    expect(marks).toHaveLength(0);
    expect(getMarks()).toHaveLength(0);
  });

  it('reapplies table row highlights with migrated escaped numeric id selectors', () => {
    setBody(`<table><tbody><tr id="48419236"><td><table><tbody><tr><td></td><td></td><td>
      <div><span><a>staticshock</a> <span>1 day ago</span> | next [–]</span></div>
      <br>
      <div class="comment"><div class="commtext c00">Everything is search.
        <p>Software development is search through the space of useful/interesting automations.</p>
        <p>Business is search for product market fit.</p>
      </div></div>
    </td></tr></tbody></table></td></tr></tbody></table>`);

    const marks = highlightSavedExcerptPartsInPage(
      document.body,
      [
        'staticshock 1 day ago  | next [–]',
        'Everything is search.',
        'Software development is search through the space of useful/interesting automations.',
        'Business is search for product market fit.',
      ],
      [
        'tr#\\34 8419236 > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(1)',
        'tr#\\34 8419236 > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(1)',
        'tr#\\34 8419236 > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(1) > p:nth-of-type(1)',
        'tr#\\34 8419236 > td > table > tbody > tr > td:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(1) > p:nth-of-type(2)',
      ],
    );

    expect(marks).toHaveLength(4);
    expect([...getMarks()].map((mark) => mark.textContent)).toEqual([
      'staticshock 1 day ago | next [–]',
      'Everything is search.',
      'Software development is search through the space of useful/interesting automations.',
      'Business is search for product market fit.',
    ]);
  });

  it('uses document root only for intentionally empty migrated css paths', () => {
    setBody('<main><p>Everything is search.</p></main>');

    const marks = highlightSavedExcerptPartsInPage(
      document.body,
      ['Everything is search.'],
      [''],
    );

    expect(marks).toHaveLength(1);
    expect(getMarks()[0].textContent).toBe('Everything is search.');
  });

  it('reapplies a single multiline element as one excerpt part', () => {
    setBody('<main><pre>line one\nline two\nline three</pre></main>');

    const marks = highlightSavedExcerptPartsInPage(
      document.body,
      ['line one\nline two\nline three'],
      ['main > pre'],
    );

    expect(marks).toHaveLength(1);
    expect(getMarks()[0].textContent).toBe('line one\nline two\nline three');
  });

  it('does not render a highlight title in the note overlay html', () => {
    const html = extensionSurface.noteOverlayHtml({
      excerpt: 'quick brown fox',
      placeholder: 'Add a note...',
      includeDelete: true,
    });
    expect(html).toContain('quick brown fox');
    expect(html).not.toContain('HIGHLIGHT NOTE');
  });
});
