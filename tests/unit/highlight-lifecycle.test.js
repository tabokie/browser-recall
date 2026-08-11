import { beforeEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { createHighlightLifecycle } from '../../packages/core/highlight-lifecycle.js';

let dom;
let document;
let lifecycle;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
  });
  document = dom.window.document;
  lifecycle = createHighlightLifecycle({ document });
});

describe('highlight lifecycle architecture invariants', () => {
  it('observes bounded hydration without duplicating an intact saved mark', async () => {
    document.body.innerHTML = '<main><p>already present</p></main>';
    let observerCount = 0;
    let notifyMutation;
    class TrackingObserver {
      constructor(callback) {
        observerCount += 1;
        notifyMutation = callback;
      }
      observe() {}
      disconnect() {}
    }
    lifecycle = createHighlightLifecycle({
      document,
      MutationObserver: TrackingObserver,
      getCurrentIdentity: () => 'page-one',
      loadNotes: async () => [
        {
          slug: 'note-present',
          excerpt: ['already present'],
          cssPath: ['main > p'],
        },
      ],
    });

    await lifecycle.reapply();

    expect(
      document.querySelectorAll('mark.browser-recall-highlight'),
    ).toHaveLength(1);
    expect(observerCount).toBe(1);
    notifyMutation();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      document.querySelectorAll('mark.browser-recall-highlight'),
    ).toHaveLength(1);
  });

  it('never indexes Browser Recall panel light DOM or shadow DOM', () => {
    document.body.innerHTML = `<aside id="browser-recall-highlights-panel">saved excerpt</aside><main><p>saved excerpt</p></main>`;

    const marks = lifecycle.applySaved([
      {
        slug: 'note-ui-exclusion',
        excerpt: ['saved excerpt'],
        cssPath: [''],
      },
    ]);

    expect(marks).toEqual([]);
    expect(
      document.querySelector('#browser-recall-highlights-panel mark'),
    ).toBeNull();
    expect(document.querySelector('main mark')?.textContent).toBe(
      'saved excerpt',
    );

    lifecycle.remove({ all: true });
    document.body.innerHTML = '<main><p>saved excerpt</p></main>';
    const browserRecallHosts = [
      'browser-recall-highlights-panel',
      'browser-recall-highlight-overlay',
    ].map((id) => {
      const host = document.createElement('aside');
      host.id = id;
      host.attachShadow({ mode: 'open' }).innerHTML = '<p>saved excerpt</p>';
      document.body.prepend(host);
      return host;
    });
    lifecycle.applySaved([
      {
        slug: 'note-shadow-ui-exclusion',
        excerpt: ['saved excerpt'],
        cssPath: [''],
      },
    ]);

    for (const host of browserRecallHosts) {
      expect(host.shadowRoot.querySelector('mark')).toBeNull();
    }
    expect(document.querySelector('main mark')?.textContent).toBe(
      'saved excerpt',
    );
  });

  it('uses aligned paths and never falls back when a stored scope is invalid', () => {
    document.body.innerHTML = `<main><section><p>duplicate</p></section><section><p>duplicate</p></section></main>`;

    lifecycle.applySaved([
      {
        slug: 'note-scoped',
        excerpt: ['duplicate'],
        cssPath: ['main > section:nth-of-type(2) > p'],
      },
      {
        slug: 'note-invalid-scope',
        excerpt: ['duplicate'],
        cssPath: ['main > section:nth-of-type(3) > p'],
      },
    ]);

    expect(document.querySelector('section:nth-of-type(1) mark')).toBeNull();
    expect(
      document.querySelector('section:nth-of-type(2) mark')?.dataset.noteSlug,
    ).toBe('note-scoped');
    expect(
      document.querySelector('[data-note-slug="note-invalid-scope"]'),
    ).toBeNull();
  });

  it('prepares aligned scoped chunks and applies the exact selected ranges', () => {
    document.body.innerHTML =
      '<main><p>repeat selected text</p><p>repeat selected text</p></main>';
    const paragraphs = document.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(paragraphs[0].firstChild, 7);
    range.setEnd(paragraphs[1].firstChild, 15);
    const selection = document.getSelection();
    selection.addRange(range);
    const prepared = lifecycle.prepareSelection(selection);

    expect(prepared).toMatchObject({
      text: 'selected text\nrepeat selected',
      excerpt: ['selected text', 'repeat selected'],
      cssPath: [
        'browser-recall-text-anchor:v1:{"selector":"body > main > p:nth-of-type(1)","start":7,"end":20}',
        'browser-recall-text-anchor:v1:{"selector":"body > main > p:nth-of-type(2)","start":0,"end":15}',
      ],
    });
    const marks = prepared.apply({ noteSlug: 'prepared-note' });
    expect(marks).toHaveLength(2);
    expect(
      [...document.querySelectorAll('mark')].map((mark) => mark.textContent),
    ).toEqual(['selected text', 'repeat selected']);
  });

  it('reapplies the selected occurrence when text repeats in one block', () => {
    document.body.innerHTML = '<main><p>same middle same</p></main>';
    const textNode = document.querySelector('p').firstChild;
    const range = document.createRange();
    range.setStart(textNode, 12);
    range.setEnd(textNode, 16);
    const selection = document.getSelection();
    selection.addRange(range);

    const prepared = lifecycle.prepareSelection(selection);
    expect(prepared.cssPath).toHaveLength(1);
    expect(prepared.cssPath[0]).toMatch(/^browser-recall-text-anchor:v1:/);

    document.body.innerHTML = '<main><p>same middle same</p></main>';
    lifecycle = createHighlightLifecycle({ document });
    lifecycle.applySaved([
      {
        slug: 'same-block-second-occurrence',
        excerpt: ['same'],
        cssPath: prepared.cssPath,
      },
    ]);

    const paragraph = document.querySelector('p');
    const mark = paragraph.querySelector('mark');
    expect(mark?.textContent).toBe('same');
    expect(paragraph.textContent).toBe('same middle same');
    expect(mark?.previousSibling?.textContent).toBe('same middle ');

    document.body.innerHTML = '<main><p>same shifted middle same</p></main>';
    lifecycle = createHighlightLifecycle({ document });
    lifecycle.applySaved([
      {
        slug: 'same-block-stale-anchor',
        excerpt: ['same'],
        cssPath: prepared.cssPath,
      },
    ]);
    expect(document.querySelector('mark')).toBeNull();
  });

  it('rejects a selection intersecting an existing owned mark', () => {
    document.body.innerHTML =
      '<main><p>before <mark class="browser-recall-highlight">saved text</mark> after</p></main>';
    const mark = document.querySelector('mark');
    const range = document.createRange();
    range.selectNodeContents(mark);
    const selection = document.getSelection();
    selection.addRange(range);

    expect(() => lifecycle.prepareSelection(selection)).toThrow(
      'Selected text is already highlighted by Browser Recall',
    );
  });
});
