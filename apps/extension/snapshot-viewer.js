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
const viewerTab = await chrome.tabs.getCurrent();
if (!Number.isSafeInteger(viewerTab?.id)) {
  throw new Error('Snapshot viewer tab identity is unavailable');
}

let activateSnapshotSelection = async () => ({
  success: false,
  error: 'Snapshot highlight controls are still loading',
});
let snapshotHighlightLifecycle = null;
let snapshotMarkupHidden = false;

async function loadSnapshotNotes() {
  const response = await chrome.runtime.sendMessage({
    action: 'loadPageNotes',
    slug,
  });
  if (response?.success !== true || !Array.isArray(response.notes)) {
    throw new Error(response?.error || 'loadPageNotes returned invalid notes');
  }
  return response.notes;
}

async function handleSnapshotViewerAction(request) {
  switch (request.action) {
    case 'highlightSelection':
      return activateSnapshotSelection(request);
    case 'getHighlightMarkupState':
      return { success: true, hidden: snapshotMarkupHidden };
    case 'hideHighlightMarkup':
      if (!snapshotHighlightLifecycle) {
        return {
          success: false,
          error: 'Snapshot highlight controls are still loading',
        };
      }
      frame.contentDocument
        ?.getElementById('browser-recall-highlight-overlay')
        ?.remove();
      snapshotHighlightLifecycle.dispose({ clearExisting: true });
      snapshotMarkupHidden = true;
      return { success: true };
    case 'showHighlightMarkup': {
      if (!snapshotHighlightLifecycle) {
        return {
          success: false,
          error: 'Snapshot highlight controls are still loading',
        };
      }
      const notes = await loadSnapshotNotes();
      snapshotHighlightLifecycle.dispose({ clearExisting: true });
      snapshotHighlightLifecycle.applySaved(notes);
      snapshotMarkupHidden = false;
      return { success: true };
    }
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (
    ![
      'highlightSelection',
      'getHighlightMarkupState',
      'hideHighlightMarkup',
      'showHighlightMarkup',
    ].includes(request.action) ||
    request.targetTabId !== viewerTab.id
  ) {
    return false;
  }
  handleSnapshotViewerAction(request)
    .then((response) => {
      if (response?.success !== true) {
        showSnapshotError(
          new Error(response?.error || 'Snapshot highlight action failed'),
        );
      }
      sendResponse(response);
    })
    .catch((error) => {
      showSnapshotError(error);
      sendResponse({ success: false, error: error.message });
    });
  return true;
});

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

    const notes = await loadSnapshotNotes();

    snapshotHighlightLifecycle?.dispose();
    const highlightLifecycle = createHighlightLifecycle({
      document: doc,
      formatExcerpt: extensionSurface.formatHighlightExcerpt,
      onMark: (mark) => attachMarkClickHandler(doc, mark, highlightLifecycle),
    });
    snapshotHighlightLifecycle = highlightLifecycle;
    if (!snapshotMarkupHidden) highlightLifecycle.applySaved(notes);

    activateSnapshotSelection = async (request) => {
      const selection = doc.getSelection();
      const selectedText = selection?.toString().trim();
      if (!selectedText || selection.rangeCount === 0) {
        return {
          success: false,
          error: 'Select text before creating a highlight',
        };
      }
      if (
        typeof request.selectionText === 'string' &&
        request.selectionText.trim() !== selectedText
      ) {
        return {
          success: false,
          error: 'The selected text changed before it could be highlighted',
        };
      }

      const preparedSelection = highlightLifecycle.prepareSelection(selection);
      if (!preparedSelection) {
        return {
          success: false,
          error: 'Select text before creating a highlight',
        };
      }
      const response = await chrome.runtime.sendMessage({
        action: 'createNote',
        pageSlug: slug,
        url: pageUrl,
        excerpt: preparedSelection.excerpt,
        note: '',
        cssPath: preparedSelection.cssPath,
      });
      if (
        response?.success !== true ||
        typeof response.noteSlug !== 'string' ||
        !response.noteSlug
      ) {
        throw new Error(response?.error || 'createNote returned invalid data');
      }

      const noteSlug = response.noteSlug;
      const marks = preparedSelection.apply({ noteSlug });

      if (marks.length !== preparedSelection.excerpt.length) {
        throw new Error(
          'The selected range could not be wrapped after the note committed',
        );
      }
      showHighlightEditOverlay(
        doc,
        marks[0],
        preparedSelection.excerpt.join('\n'),
        noteSlug,
        '',
        highlightLifecycle,
      );
      selection.removeAllRanges();
      return { success: true };
    };
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
          throw new Error(resp?.error || 'Could not load notes');
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

function showHighlightEditOverlay(
  doc,
  mark,
  text,
  noteSlug,
  existingNote,
  highlightLifecycle,
) {
  const rect = mark.getBoundingClientRect();
  const note = {
    slug: noteSlug || '',
    excerpt: String(text || mark.textContent)
      .split('\n')
      .filter(Boolean),
    note: existingNote,
  };
  extensionSurface.createHighlightEditOverlay({
    doc,
    view: doc.defaultView,
    rect,
    note,
    placeholder: tr('extensionAddNote', 'Add a note...', undefined),
    confirmTitle: tr('commonConfirm', 'Confirm', undefined),
    editTitle: tr('extensionEditNote', 'Edit note', undefined),
    deleteTitle: tr('extensionDeleteHighlight', 'Delete highlight', undefined),
    async save(nextNote) {
      if (nextNote === existingNote || !noteSlug) return { noteSlug };
      const response = await chrome.runtime.sendMessage({
        action: 'updateNote',
        noteSlug,
        note: nextNote,
      });
      if (
        response?.success !== true ||
        typeof response.noteSlug !== 'string' ||
        !response.noteSlug
      ) {
        throw new Error(response?.error || 'updateNote returned invalid data');
      }
      return response;
    },
    onSaved(response) {
      if (response?.noteSlug && response.noteSlug !== noteSlug) {
        highlightLifecycle.replaceNote(noteSlug, response.noteSlug);
      }
    },
    async onDelete() {
      if (noteSlug) {
        const response = await chrome.runtime.sendMessage({
          action: 'deleteNote',
          noteSlug,
        });
        if (response?.success !== true) {
          throw new Error(response?.error || 'deleteNote failed');
        }
        highlightLifecycle.remove({ noteSlug });
      } else {
        highlightLifecycle.remove({ mark });
      }
    },
    onError: showSnapshotError,
  });
}
