import { createHighlightLifecycle } from '../../packages/core/highlight-lifecycle.js';
import { sampleNote } from './sample-note.js';

const surface = globalThis.browserRecallExtensionSurface;
const lifecycle = createHighlightLifecycle({
  document,
  onMark(mark) {
    mark.style.cursor = 'default';
  },
});
lifecycle.applySaved([sampleNote]);

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
    width: min(300px, var(--article-width)); background: var(--br-bg-base); border: var(--br-floating-border);
    border-radius: 2px; color: var(--br-text-primary); font-family: var(--br-font-body);
    font-size: 12px; line-height: 1.45; padding: 0 8px;
  }
  .highlight-item { --br-highlight-side-padding: 0px; border-top: 0; }
</style><div class="overlay">${surface.highlightEntryHtml(sampleNote, { deleteTitle: 'Delete highlight', editTitle: 'Edit note' })}</div>`;
for (const button of shadow.querySelectorAll('button')) button.disabled = true;
document.body.appendChild(host);

function positionNote() {
  const mark = document.querySelector('.browser-recall-highlight');
  if (!mark) return;
  host.style.setProperty(
    '--article-width',
    `${document.querySelector('.sample-article').clientWidth}px`,
  );
  surface.positionNearRect(host, mark.getBoundingClientRect());
}
export function setMarkupHidden(hidden) {
  if (host.hidden === hidden) return;
  host.hidden = hidden;
  if (hidden) {
    lifecycle.remove({ noteSlug: sampleNote.slug });
  } else {
    lifecycle.applySaved([sampleNote]);
    positionNote();
  }
}
new ResizeObserver(positionNote).observe(document.body);
positionNote();
