import { createHighlightLifecycle } from '../../packages/core/highlight-lifecycle.js';

const surface = globalThis.browserRecallExtensionSurface;
const note = {
  slug: 'website-sample-note',
  excerpt: ['Leave room for the unfinished things.'],
  cssPath: ['p:nth-of-type(2)'],
  note: 'Leave a little room for curiosity.',
};
const lifecycle = createHighlightLifecycle({
  document,
  onMark(mark) {
    mark.style.cursor = 'default';
  },
});
lifecycle.applySaved([note]);

// Render the saved state with the production entry renderer and style tokens.
// No editor or mutation handlers are installed in this display-only preview.
const host = document.createElement('div');
host.id = 'browser-recall-highlight-overlay';
host.style.cssText = 'position:absolute;z-index:1';
host.setAttribute('role', 'group');
host.setAttribute('aria-label', 'Saved highlight and note');
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>
  ${surface.shadowCss}
  ${surface.highlightEntryCss}
  .overlay {
    width: 300px; background: var(--br-bg-base); border: var(--br-floating-border);
    border-radius: 2px; color: var(--br-text-primary); font-family: var(--br-font-body);
    font-size: 12px; line-height: 1.45; padding: 0 8px;
  }
  .highlight-item { --br-highlight-side-padding: 0px; border-top: 0; }
</style><div class="overlay">${surface.highlightEntryHtml(note, { deleteTitle: 'Delete highlight', editTitle: 'Edit note' })}</div>`;
for (const button of shadow.querySelectorAll('button')) button.disabled = true;
document.body.appendChild(host);

function positionNote() {
  const mark = document.querySelector('.browser-recall-highlight');
  surface.positionNearRect(host, mark.getBoundingClientRect());
}
new ResizeObserver(positionNote).observe(document.body);
positionNote();
