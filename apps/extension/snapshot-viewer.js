import { logDebug } from './logger.js';
import { createHighlightLifecycle } from '../../packages/core/highlight-lifecycle.js';
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

function showSnapshotError(error) {
  if (showSnapshotRuntimeError(error)) return;
  const message =
    typeof error?.message === 'string' && error.message
      ? error.message
      : tr('extensionActionFailed', 'Action failed', undefined);
  let banner = document.getElementById('snapshotRuntimeError');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'snapshotRuntimeError';
    banner.setAttribute('role', 'alert');
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
  logDebug('[snapshot-viewer] operation failed:', message);
}

function restoreSerializedShadowRoots(root) {
  const templates = [
    ...root.querySelectorAll('template[data-savepage-shadowroot]'),
  ];
  for (const template of templates) {
    const host = template.parentElement;
    if (!host || template.parentNode !== host) {
      throw new Error('Saved shadow root is missing its host element');
    }
    if (host.shadowRoot) {
      throw new Error('Saved shadow root host already has a shadow root');
    }
    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.append(template.content);
    template.remove();
    restoreSerializedShadowRoots(shadowRoot);
  }
}

function visitTemplateContentRoots(root, visit, seen = new Set()) {
  if (seen.has(root)) return;
  seen.add(root);
  visit(root);
  for (const template of root.querySelectorAll('template')) {
    visitTemplateContentRoots(template.content, visit, seen);
  }
}

function prepareDeclarativeShadowRoots(root) {
  visitTemplateContentRoots(root, (currentRoot) => {
    for (const template of currentRoot.querySelectorAll(
      'template[data-savepage-shadowroot]',
    )) {
      template.setAttribute('shadowrootmode', 'open');
    }
    for (const nestedFrame of currentRoot.querySelectorAll(
      'iframe[srcdoc],frame[srcdoc]',
    )) {
      const nestedHtml = nestedFrame.getAttribute('srcdoc');
      if (!nestedHtml) continue;
      const nestedDocument = new DOMParser().parseFromString(
        nestedHtml,
        'text/html',
      );
      prepareDeclarativeShadowRoots(nestedDocument);
      nestedFrame.setAttribute(
        'srcdoc',
        `<!doctype html>${nestedDocument.documentElement.outerHTML}`,
      );
    }
  });
}

function visitRenderedRoots(root, visit, seen = new Set()) {
  if (seen.has(root)) return;
  seen.add(root);
  visit(root);
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) {
      visitRenderedRoots(element.shadowRoot, visit, seen);
    }
  }
}

function restoreSerializedShadowRootsInFrameTree(root) {
  // Walk frames from every rendered root: frame trees and shadow trees can
  // nest inside one another, so restoring either hierarchy alone is incomplete.
  restoreSerializedShadowRoots(root);
  visitRenderedRoots(root, (currentRoot) => {
    for (const nestedFrame of currentRoot.querySelectorAll('iframe,frame')) {
      const restoreNestedFrame = () => {
        try {
          const nestedDocument = nestedFrame.contentDocument;
          if (nestedDocument?.documentElement) {
            restoreSerializedShadowRootsInFrameTree(nestedDocument);
          }
        } catch {
          // Sandboxed retained frames restore through declarative shadow DOM.
        }
      };
      restoreNestedFrame();
      nestedFrame.addEventListener('load', restoreNestedFrame, { once: true });
    }
  });
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
  showSnapshotError(error);
  throw error;
}

if (
  htmlResp?.success !== true ||
  typeof htmlResp.html !== 'string' ||
  !htmlResp.html
) {
  document.body.textContent = tr(
    'extensionSnapshotNotFound',
    'Snapshot not found.',
    undefined,
  );
  throw new Error(htmlResp?.error || 'getSnapshotHtml failed');
}
if (
  pageResp?.success !== true ||
  !pageResp.entry ||
  typeof pageResp.entry !== 'object' ||
  typeof pageResp.entry.url !== 'string' ||
  !pageResp.entry.url
) {
  throw new Error(pageResp?.error || 'getPageInfo returned invalid page data');
}

const pageUrl = pageResp.entry.url;
const html = htmlResp.html;
const frame = document.getElementById('frame');

const parsed = new DOMParser().parseFromString(html, 'text/html');
prepareDeclarativeShadowRoots(parsed);
frame.srcdoc = `<!doctype html>${parsed.documentElement.outerHTML}`;
const title = parsed.querySelector('title')?.textContent;
if (title) document.title = title;

frame.addEventListener('load', async () => {
  try {
    const doc = frame.contentDocument;
    if (!doc) {
      throw new Error('Snapshot document is unavailable');
    }
    restoreSerializedShadowRootsInFrameTree(doc);

    const resp = await chrome.runtime.sendMessage({
      action: 'loadPageNotes',
      slug,
    });
    if (resp?.success !== true || !Array.isArray(resp.notes)) {
      throw new Error(resp?.error || 'loadPageNotes returned invalid notes');
    }

    let highlightLifecycle;
    highlightLifecycle = createHighlightLifecycle({
      document: doc,
      formatExcerpt: extensionSurface.formatHighlightExcerpt,
      onMark: (mark) => attachMarkClickHandler(doc, mark, highlightLifecycle),
    });
    highlightLifecycle.applySaved(resp.notes);

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
          if (
            response?.success !== true ||
            typeof response.noteSlug !== 'string' ||
            !response.noteSlug
          ) {
            throw new Error(
              response?.error || 'createNote returned invalid data',
            );
          }
          const noteSlug = response.noteSlug;
          const mark = highlightLifecycle.createMark(range, selectedText, {
            noteSlug,
          });
          if (!mark) {
            throw new Error(
              'Saved highlight could not be applied to the snapshot',
            );
          }
          showHighlightEditOverlay(
            doc,
            mark,
            selectedText,
            noteSlug,
            '',
            highlightLifecycle,
          );
          selection.removeAllRanges();
        })
        .catch(showSnapshotError);
    });
  } catch (error) {
    showSnapshotError(error);
  }
});

function attachMarkClickHandler(doc, mark, highlightLifecycle) {
  mark.addEventListener('click', (event) => {
    event.stopPropagation();
    doc.getElementById('browser-recall-highlight-overlay')?.remove();

    const noteSlug = mark.dataset.noteSlug;
    const text = mark.dataset.highlightText || mark.textContent;
    chrome.runtime
      .sendMessage({ action: 'loadPageNotes', slug })
      .then((resp) => {
        if (resp?.success !== true || !Array.isArray(resp.notes)) {
          throw new Error(resp?.error || 'Could not load page notes');
        }
        const notes = resp.notes;
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
          highlightLifecycle,
        );
      })
      .catch(showSnapshotError);
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

function showHighlightEditOverlay(
  doc,
  mark,
  text,
  noteSlug,
  existingNote,
  highlightLifecycle,
) {
  doc.getElementById('browser-recall-highlight-overlay')?.remove();

  const rect = mark.getBoundingClientRect();
  const win = doc.defaultView;
  const host = doc.createElement('div');
  host.id = 'browser-recall-highlight-overlay';
  host.style.cssText =
    'position: absolute; z-index: 2147483647; visibility: hidden;';

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${OVERLAY_STYLE}</style><div class="overlay">${extensionSurface.noteOverlayHtml({ excerpt: text || '', placeholder: tr('extensionAddNoteEsc', 'Add a note... Esc to save.', undefined), includeDelete: true, deleteTitle: tr('commonDelete', 'Delete', undefined) })}</div>`;
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
        .then((response) => {
          if (
            response?.success !== true ||
            typeof response.noteSlug !== 'string' ||
            !response.noteSlug
          ) {
            throw new Error(
              response?.error || 'updateNote returned invalid data',
            );
          }
          highlightLifecycle.replaceNote(noteSlug, response.noteSlug);
        })
        .catch(showSnapshotError);
    }
    host.remove();
  }

  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    highlightLifecycle.remove(noteSlug ? { noteSlug } : { mark });
    if (noteSlug)
      chrome.runtime
        .sendMessage({ action: 'deleteNote', noteSlug })
        .then((response) => {
          if (response?.success !== true) {
            throw new Error(response?.error || 'deleteNote failed');
          }
        })
        .catch(showSnapshotError);
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
