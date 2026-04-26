import { logDebug } from './logger.js';
import { findTextRange } from './highlight-helpers.js';
import { getSchemePalette } from './color-scheme-map.js';

const { colorScheme: _cs } = await chrome.storage.session.get(['colorScheme']);
const palette = getSchemePalette(_cs);

const params = new URLSearchParams(location.search);
const slug = params.get('slug');
const ts = params.get('ts');

if (!slug || !ts) {
  document.body.textContent = 'Missing snapshot parameters.';
  throw new Error('Missing slug or ts');
}

// Fetch snapshot HTML content through the background daemon RPC.
const htmlResp = await chrome.runtime.sendMessage({
  action: 'getSnapshotHtml',
  slug,
  timestamp: parseInt(ts),
});
if (!htmlResp?.success) {
  document.body.textContent = 'Snapshot not found.';
  throw new Error(htmlResp?.error || 'getSnapshotHtml failed');
}

const html = htmlResp.html;

const frame = document.getElementById('frame');
frame.srcdoc = html;

// Set tab title from snapshot content
const parser = new DOMParser();
const parsed = parser.parseFromString(html, 'text/html');
const title = parsed.querySelector('title')?.textContent;
if (title) document.title = title;

// After iframe loads, apply highlights and wire up interactivity
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

    // New highlights: text selection inside the iframe
    doc.addEventListener('mouseup', () => {
      const selection = doc.getSelection();
      const selectedText = selection?.toString().trim();
      if (
        !selectedText ||
        selectedText.length === 0 ||
        selection.rangeCount === 0
      )
        return;
      // Ignore if selection is inside an existing highlight
      const anchor = selection.anchorNode;
      if (
        anchor &&
        (anchor.nodeType === 3 ? anchor.parentElement : anchor)?.closest?.(
          'mark',
        )
      )
        return;

      const range = selection.getRangeAt(0);
      chrome.runtime
        .sendMessage({
          action: 'createNote',
          pageSlug: slug,
          url: '', // resolved from page entity by background
          excerpt: selectedText,
          note: '',
          cssPath: null,
        })
        .then((resp) => {
          if (!resp?.success) return;
          const noteSlug = resp.noteSlug;
          const mark = wrapRangeWithMark(doc, range, selectedText);
          if (mark && noteSlug) {
            mark.dataset.noteSlug = noteSlug;
            attachMarkClickHandler(doc, mark);
            showHighlightEditOverlay(doc, mark, selectedText, noteSlug, '');
          }
          selection.removeAllRanges();
        });
    });
  } catch (e) {
    logDebug('[snapshot-viewer] highlight injection failed:', e);
  }
});

// ─── Highlight helpers (operate on iframe document) ──────────────────

// Find text across nodes and wrap in <mark>. Returns the mark element or undefined.
function highlightInDoc(doc, text, noteSlug) {
  const range = findTextRange(doc.body, text, doc);
  if (!range) return;
  return wrapRangeWithMark(doc, range, text, noteSlug);
}

function wrapRangeWithMark(doc, range, text, noteSlug) {
  const mark = doc.createElement('mark');
  mark.style.cssText =
    'background: #fff3b0; border-bottom: 2px solid #f0c000; cursor: pointer;';
  mark.dataset.highlightText = text;
  if (noteSlug) mark.dataset.noteSlug = noteSlug;

  if (range.startContainer === range.endContainer) {
    try {
      range.surroundContents(mark);
      return mark;
    } catch {}
  }
  try {
    const fragment = range.extractContents();
    mark.appendChild(fragment);
    range.insertNode(mark);
    return mark;
  } catch {}
}

function unwrapHighlightMark(mark) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize();
}

// ─── Click handler + overlay (mirrors content.js) ────────────────────

function attachMarkClickHandler(doc, mark) {
  mark.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = doc.getElementById('portal-highlight-overlay');
    if (existing) existing.remove();

    const noteSlug = mark.dataset.noteSlug;
    const text = mark.dataset.highlightText || mark.textContent;

    if (!noteSlug) {
      showHighlightEditOverlay(doc, mark, text, null, '');
      return;
    }

    chrome.runtime
      .sendMessage({ action: 'loadPageNotes', slug })
      .then((resp) => {
        if (resp?.success === false) return;
        const notes = resp?.notes || [];
        const match = notes.find((n) => n.slug === noteSlug);
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
      .catch(() => {
        showHighlightEditOverlay(doc, mark, text, noteSlug, '');
      });
  });
}

// Overlay styles + HTML — same as content.js showHighlightEditOverlay
const OVERLAY_STYLE = `
  .overlay {
    display: flex; align-items: flex-start; gap: 8px; width: 280px;
    background: ${palette.bgBase}; border: 1px solid ${palette.borderSubtle};
    border-radius: 10px; box-shadow: 0 1px 2px rgba(${palette.shadowColor},0.04), 0 4px 12px rgba(${palette.shadowColor},0.08);
    font-family: 'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 8px;
  }
  .delete-btn {
    flex-shrink: 0; width: 28px; height: 28px; display: flex;
    align-items: center; justify-content: center; background: none;
    border: 1px solid ${palette.borderSubtle}; border-radius: 6px;
    cursor: pointer; color: ${palette.textMuted}; padding: 0;
  }
  .delete-btn:hover { background: rgba(184, 80, 64, 0.1); border-color: #B85040; color: #B85040; }
  .delete-btn svg { width: 16px; height: 16px; fill: currentColor; }
  textarea {
    width: 100%; min-height: 28px; height: 28px;
    border: 1px solid ${palette.borderSubtle}; border-radius: 6px;
    padding: 4px 8px; font-family: inherit; font-size: 12px;
    resize: none; box-sizing: border-box; line-height: 18px; overflow: hidden;
  }
  textarea:focus { outline: none; border-color: ${palette.accent}; }
`;

const OVERLAY_HTML = `
  <div class="overlay">
    <button class="delete-btn" title="Delete note">
      <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
    </button>
    <div style="flex:1;min-width:0">
      <textarea placeholder="Add a note... Esc to save."></textarea>
    </div>
  </div>
`;

function showHighlightEditOverlay(doc, mark, text, noteSlug, existingNote) {
  const existing = doc.getElementById('portal-highlight-overlay');
  if (existing) existing.remove();

  const rect = mark.getBoundingClientRect();
  const win = doc.defaultView;

  const host = doc.createElement('div');
  host.id = 'portal-highlight-overlay';
  host.style.cssText = 'position: absolute; z-index: 2147483647;';
  host.style.left = rect.left + win.scrollX + 'px';
  host.style.top = rect.bottom + win.scrollY + 4 + 'px';

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${OVERLAY_STYLE}</style>${OVERLAY_HTML}`;

  doc.body.appendChild(host);

  const textarea = shadow.querySelector('textarea');
  const deleteBtn = shadow.querySelector('.delete-btn');

  textarea.value = existingNote;

  function autoResize() {
    textarea.style.height = '28px';
    if (textarea.scrollHeight > 28)
      textarea.style.height = textarea.scrollHeight + 'px';
  }
  if (existingNote) autoResize();

  textarea.focus();
  textarea.addEventListener('input', () => {
    autoResize();
  });

  let saved = false;
  function saveAndClose() {
    if (saved) return;
    saved = true;
    const note = textarea.value;
    if (note !== existingNote && noteSlug) {
      chrome.runtime
        .sendMessage({
          action: 'updateNote',
          noteSlug,
          note,
        })
        .then((resp) => {
          if (resp?.noteSlug) mark.dataset.noteSlug = resp.noteSlug;
        })
        .catch(() => {});
    }
    host.remove();
  }

  deleteBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    unwrapHighlightMark(mark);
    if (noteSlug)
      chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug });
    host.remove();
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') saveAndClose();
  });

  const handleOutsideClick = (e) => {
    if (!host.contains(e.target)) {
      saveAndClose();
      doc.removeEventListener('mousedown', handleOutsideClick);
    }
  };
  setTimeout(() => doc.addEventListener('mousedown', handleOutsideClick), 100);
}
