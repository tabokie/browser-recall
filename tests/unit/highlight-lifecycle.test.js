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

    expect(document.querySelectorAll('mark.portal-highlight')).toHaveLength(1);
    expect(observerCount).toBe(1);
    notifyMutation();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelectorAll('mark.portal-highlight')).toHaveLength(1);
  });

  it('never indexes Browser Recall panel light DOM or shadow DOM', () => {
    document.body.innerHTML = `<aside id="portal-highlights-panel">saved excerpt</aside><main><p>saved excerpt</p></main>`;

    const marks = lifecycle.applySaved([
      {
        slug: 'note-ui-exclusion',
        excerpt: ['saved excerpt'],
        cssPath: [''],
      },
    ]);

    expect(marks).toEqual([]);
    expect(document.querySelector('#portal-highlights-panel mark')).toBeNull();
    expect(document.querySelector('main mark')?.textContent).toBe(
      'saved excerpt',
    );

    lifecycle.remove({ all: true });
    document.body.innerHTML = '<main><p>saved excerpt</p></main>';
    const browserRecallHosts = [
      'portal-highlights-panel',
      'portal-highlight-overlay',
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

  it('returns aligned excerpt and path arrays for cross-block selections', () => {
    document.body.innerHTML =
      '<main><p>first selected text</p><p>second selected text</p></main>';
    const paragraphs = document.querySelectorAll('p');
    const range = document.createRange();
    range.setStart(paragraphs[0].firstChild, 6);
    range.setEnd(paragraphs[1].firstChild, 15);
    const selection = document.getSelection();
    selection.addRange(range);
    lifecycle = createHighlightLifecycle({
      document,
      getCssPath: (element) =>
        `main > p:nth-of-type(${[...paragraphs].indexOf(element) + 1})`,
    });

    expect(lifecycle.describeSelection(selection)).toMatchObject({
      selectionText: 'selected text\nsecond selected',
      selectionExcerpt: ['selected text', 'second selected'],
      selectionCssPath: ['main > p:nth-of-type(1)', 'main > p:nth-of-type(2)'],
    });
  });
});
