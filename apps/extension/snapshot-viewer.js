import { logDebug } from './logger.js';
import {
  highlightSavedExcerptPartsInPage,
  wrapRangeWithMark as wrapSharedRangeWithMark,
} from './highlight-helpers.js';
import {
  applyPaperErrorPopoutStyle,
  paperErrorPopoutCss,
} from './extension-ui-tokens.js';
import { initializeExtensionI18n, tr } from '../../packages/core/i18n.js';

const extensionSurface = globalThis.browserRecallExtensionSurface;

await initializeExtensionI18n();

const params = new URLSearchParams(location.search);
const slug = params.get('slug');
const ts = Number(params.get('ts'));

function showSnapshotRuntimeError(error) {
  if (!globalThis.browserRecallWebExtension?.isRuntimeFailure?.(error)) {
    return false;
  }
  const message = tr(
    'extensionReloaded',
    'Browser Recall extension reloaded. Please reload the page and try again.',
    undefined,
  );
  let banner = document.getElementById('snapshotRuntimeError');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'snapshotRuntimeError';
    banner.setAttribute('role', 'status');
    banner.style.cssText = paperErrorPopoutCss({
      zIndex: 2147483647,
      fontSize: '13px',
      padding: '8px 14px',
      maxWidth: '420px',
    });
    applyPaperErrorPopoutStyle(banner);
    document.body.appendChild(banner);
  }
  banner.textContent = message;
  return true;
}

if (!slug || !Number.isFinite(ts)) {
  document.body.textContent = tr(
    'extensionSnapshotMissingParams',
    'Missing snapshot parameters.',
    undefined,
  );
  throw new Error(
    tr(
      'extensionSnapshotMissingParams',
      'Missing snapshot parameters.',
      undefined,
    ),
  );
}

let htmlResp;
let pageResp;
try {
  [htmlResp, pageResp] = await Promise.all([
    chrome.runtime.sendMessage({
      action: 'getSnapshotHtml',
      slug,
      timestamp: ts,
    }),
    chrome.runtime.sendMessage({
      action: 'getPageInfo',
      slug,
    }),
  ]);
} catch (error) {
  if (!showSnapshotRuntimeError(error)) throw error;
}

if (!htmlResp?.success || !htmlResp.html) {
  document.body.textContent = tr(
    'extensionSnapshotNotFound',
    'Snapshot not found.',
    undefined,
  );
  throw new Error(htmlResp?.error || 'getSnapshotHtml failed');
}

const pageUrl = pageResp?.entry?.url || '';
const html = htmlResp.html;
const frame = document.getElementById('frame');
frame.srcdoc = html;

const parsed = new DOMParser().parseFromString(html, 'text/html');
const title = parsed.querySelector('title')?.textContent;
if (title) document.title = title;

frame.addEventListener('load', async () => {
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'loadPageNotes',
      slug,
    });
    if (!resp?.success || !resp?.notes) return;

    const doc = frame.contentDocument;
    for (const note of resp.notes) {
      if (note.excerpt === null) continue;
      const marks = highlightSavedExcerptPartsInPage(
        doc.body,
        note.excerpt,
        note.cssPath,
      );
      for (const mark of marks) {
        if (note.slug) mark.dataset.noteSlug = note.slug;
        attachMarkClickHandler(doc, mark);
      }
    }

    doc.addEventListener('mouseup', () => {
      const selection = doc.getSelection();
      const selectedText = selection?.toString().trim();
      if (!selectedText || selection.rangeCount === 0) return;
      const anchor = selection.anchorNode;
      if (
        anchor &&
        (anchor.nodeType === Node.TEXT_NODE
          ? anchor.parentElement
          : anchor
        )?.closest?.('mark')
      ) {
        return;
      }

      const range = selection.getRangeAt(0);
      chrome.runtime
        .sendMessage({
          action: 'createNote',
          pageSlug: slug,
          url: pageUrl,
          excerpt: [selectedText],
          note: '',
          cssPath: [''],
        })
        .then((response) => {
          if (!response?.success) return;
          const noteSlug = response.noteSlug;
          const mark = wrapRangeWithMark(doc, range, selectedText, noteSlug);
          if (mark) {
            attachMarkClickHandler(doc, mark);
            showHighlightEditOverlay(doc, mark, selectedText, noteSlug, '');
          }
          selection.removeAllRanges();
        })
        .catch((error) => {
          showSnapshotRuntimeError(error);
        });
    });
  } catch (error) {
    if (showSnapshotRuntimeError(error)) return;
    logDebug('[snapshot-viewer] highlight injection failed:', error.message);
  }
});

function wrapRangeWithMark(doc, range, text, noteSlug) {
  const mark = wrapSharedRangeWithMark(range, text);
  if (!mark) return null;
  if (noteSlug) mark.dataset.noteSlug = noteSlug;
  return mark;
}

function unwrapHighlightMark(mark) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize();
}

function removeHighlightMarksByNoteSlug(doc, noteSlug) {
  const escaped = cssEscape(doc, noteSlug);
  doc
    .querySelectorAll(`mark.portal-highlight[data-note-slug="${escaped}"]`)
    .forEach((mark) => unwrapHighlightMark(mark));
}

function cssEscape(doc, value) {
  if (doc.defaultView.CSS && typeof doc.defaultView.CSS.escape === 'function') {
    return doc.defaultView.CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => {
    return `\\${character.codePointAt(0).toString(16)} `;
  });
}

function attachMarkClickHandler(doc, mark) {
  mark.addEventListener('click', (event) => {
    event.stopPropagation();
    doc.getElementById('portal-highlight-overlay')?.remove();

    const noteSlug = mark.dataset.noteSlug;
    const text = mark.dataset.highlightText || mark.textContent;
    chrome.runtime
      .sendMessage({ action: 'loadPageNotes', slug })
      .then((resp) => {
        const notes = resp?.notes || [];
        const match = notes.find((note) => note.slug === noteSlug);
        const displayText = match
          ? extensionSurface.formatHighlightExcerpt(match.excerpt)
          : text;
        showHighlightEditOverlay(
          doc,
          mark,
          displayText,
          noteSlug,
          match?.note || '',
        );
      })
      .catch((error) => {
        if (showSnapshotRuntimeError(error)) return;
        showHighlightEditOverlay(doc, mark, text, noteSlug, '');
      });
  });
}

const OVERLAY_STYLE = `
  ${extensionSurface.shadowCss}
  .overlay {
    width: 300px;
    background: var(--br-bg-base); border: var(--br-floating-border);
    border-radius: 2px; color: var(--br-text-primary);
    font-family: var(--br-font-body); font-size: 12px; line-height: 1.45;
    padding: 8px;
  }
  .br-note-label {
    margin-bottom: 7px; color: var(--br-text-muted); font-size: 10px;
    font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase;
  }
  .br-note-excerpt {
    margin-bottom: 8px; padding: 7px 0 8px;
    border-top: 1px dotted var(--br-border-section);
    border-bottom: 1px dotted var(--br-border-section);
    color: var(--br-text-muted); font-style: italic; line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .br-note-editor { display: flex; align-items: flex-start; gap: 8px; }
  .br-note-body { flex: 1; min-width: 0; }
  .delete-btn {
    flex-shrink: 0; width: 30px; height: 30px; display: flex;
    align-items: center; justify-content: center; background: none;
    border: 1px solid var(--br-border-section); border-radius: 2px;
    cursor: pointer; color: var(--br-text-muted); padding: 0;
  }
  .delete-btn:hover { background: var(--br-bg-surface-active); border-color: var(--br-text-primary); color: var(--br-text-primary); }
  .delete-btn svg { width: 16px; height: 16px; fill: currentColor; }
  textarea {
    width: 100%; min-height: 30px; height: 30px;
    border: 1px solid var(--br-border-section); border-radius: 2px;
    padding: 4px 8px; font-family: inherit; font-size: 12px;
    resize: none; box-sizing: border-box; line-height: 18px; overflow: hidden;
    background: transparent; color: var(--br-text-primary);
  }
  textarea::placeholder { color: var(--br-text-muted); }
  textarea:focus { outline: none; border-color: var(--br-accent-primary); box-shadow: 0 0 0 3px var(--br-accent-soft); }
`;

function showHighlightEditOverlay(doc, mark, text, noteSlug, existingNote) {
  doc.getElementById('portal-highlight-overlay')?.remove();

  const rect = mark.getBoundingClientRect();
  const win = doc.defaultView;
  const host = doc.createElement('div');
  host.id = 'portal-highlight-overlay';
  host.style.cssText =
    'position: absolute; z-index: 2147483647; visibility: hidden;';

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${OVERLAY_STYLE}</style><div class="overlay">${extensionSurface.noteOverlayHtml({ excerpt: text || '', placeholder: tr('extensionAddNoteEsc', 'Add a note... Esc to save.', undefined), includeDelete: true })}</div>`;
  doc.body.appendChild(host);
  extensionSurface.positionNearRect(host, rect, win);

  const textarea = shadow.querySelector('textarea');
  const deleteBtn = shadow.querySelector('.delete-btn');
  textarea.value = existingNote || '';
  textarea.focus();

  let saved = false;
  function saveAndClose() {
    if (saved) return;
    saved = true;
    const note = textarea.value;
    if (note !== existingNote && noteSlug) {
      chrome.runtime
        .sendMessage({ action: 'updateNote', noteSlug, note })
        .catch((error) => {
          showSnapshotRuntimeError(error);
        });
    }
    host.remove();
  }

  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (noteSlug) removeHighlightMarksByNoteSlug(doc, noteSlug);
    else unwrapHighlightMark(mark);
    if (noteSlug)
      chrome.runtime
        .sendMessage({ action: 'deleteNote', noteSlug })
        .catch((error) => {
          showSnapshotRuntimeError(error);
        });
    host.remove();
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') saveAndClose();
  });
  const handleOutsideClick = (event) => {
    if (!host.contains(event.target)) {
      saveAndClose();
      doc.removeEventListener('mousedown', handleOutsideClick);
    }
  };
  setTimeout(() => doc.addEventListener('mousedown', handleOutsideClick), 100);
}
