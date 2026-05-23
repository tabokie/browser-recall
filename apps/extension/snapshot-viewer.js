import { logDebug } from './logger.js';
import { findTextRange } from './highlight-helpers.js';

const extensionSurface = globalThis.browserRecallExtensionSurface;

const params = new URLSearchParams(location.search);
const slug = params.get('slug');
const ts = Number(params.get('ts'));

function showSnapshotRuntimeError(error) {
  if (!globalThis.browserRecallWebExtension?.isRuntimeFailure?.(error)) {
    return false;
  }
  const message =
    'Browser Recall extension reloaded. Please reload the page and try again.';
  let banner = document.getElementById('snapshotRuntimeError');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'snapshotRuntimeError';
    banner.setAttribute('role', 'status');
    banner.style.cssText =
      'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(180,30,30,0.92);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 14px;border-radius:6px;max-width:420px;text-align:center;';
    document.body.appendChild(banner);
  }
  banner.textContent = message;
  return true;
}

if (!slug || !Number.isFinite(ts)) {
  document.body.textContent = 'Missing snapshot parameters.';
  throw new Error('Missing snapshot parameters');
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
  document.body.textContent = 'Snapshot not found.';
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
      const quotes = Array.isArray(note.excerpt)
        ? note.excerpt
        : [note.excerpt];
      for (const text of quotes) {
        const mark = highlightInDoc(doc, text, note.slug);
        if (mark) attachMarkClickHandler(doc, mark);
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
          excerpt: selectedText,
          note: '',
          cssPath: null,
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

function highlightInDoc(doc, text, noteSlug) {
  const range = findTextRange(doc.body, text, doc);
  if (!range) return null;
  return wrapRangeWithMark(doc, range, text, noteSlug);
}

function wrapRangeWithMark(doc, range, text, noteSlug) {
  const mark = doc.createElement('mark');
  mark.style.cssText =
    'background: #fff3b0; border-bottom: 2px solid #f0c000; cursor: pointer;';
  mark.dataset.highlightText = text;
  if (noteSlug) mark.dataset.noteSlug = noteSlug;

  try {
    if (range.startContainer === range.endContainer) {
      range.surroundContents(mark);
    } else {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
    }
    return mark;
  } catch {
    return null;
  }
}

function unwrapHighlightMark(mark) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize();
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
          ? Array.isArray(match.excerpt)
            ? match.excerpt.join(' ')
            : match.excerpt
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
    background: var(--br-bg-base); border: 1px solid var(--br-border-section);
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
  .delete-btn:hover { background: var(--br-accent-red-soft); border-color: var(--br-accent-red); color: var(--br-accent-red); }
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
  shadow.innerHTML = `<style>${OVERLAY_STYLE}</style><div class="overlay">${extensionSurface.noteOverlayHtml({ title: 'Highlight Note', excerpt: text || '', placeholder: 'Add a note... Esc to save.', includeDelete: true })}</div>`;
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
    unwrapHighlightMark(mark);
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
