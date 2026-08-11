// Content script for capturing user intent and attention (scroll depth, time on page)
console.log('Browser Recall content script loaded on:', window.location.href);

const extensionSurface = globalThis.browserRecallExtensionSurface;
const pageIdentity = globalThis.browserRecallPageIdentity;
const highlightLifecycleModule = globalThis.browserRecallHighlightLifecycle;
const markdownExtractorModule = globalThis.browserRecallMarkdownExtractor;

function tr(key, fallback, substitutions) {
  return (
    chrome.i18n?.getMessage?.(
      key,
      substitutions === undefined
        ? undefined
        : Array.isArray(substitutions)
          ? substitutions
          : [substitutions],
    ) || fallback
  );
}

if (
  !pageIdentity?.generateSlugFromUrl ||
  !pageIdentity?.isSameDocumentPageUrl
) {
  throw new Error(
    'Browser Recall page identity helper was not loaded before content.js',
  );
}

if (!highlightLifecycleModule?.create) {
  throw new Error(
    'Browser Recall highlight lifecycle was not loaded before content.js',
  );
}

if (!markdownExtractorModule?.extractMarkdown) {
  throw new Error(
    'Browser Recall Markdown extractor was not loaded before content.js',
  );
}

let contentScriptInitialized = false;

function readRecordingMode(workspace) {
  if (workspace === undefined) return 'default';
  if (
    !workspace ||
    typeof workspace !== 'object' ||
    Array.isArray(workspace) ||
    (workspace.mode !== 'default' && workspace.mode !== 'private')
  ) {
    throw new Error('Stored recording state must have mode default or private');
  }
  return workspace.mode;
}

function ensureContentScriptInitialized() {
  if (contentScriptInitialized) return;
  contentScriptInitialized = true;
  initContentScript();
}

// A page can load while recording is paused and remain open after recording
// resumes. Keep that content-script instance dormant, but initialize its
// receiver on the explicit session transition instead of requiring a reload.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'session' || !changes.workspace) return;
  try {
    if (readRecordingMode(changes.workspace.newValue) === 'default') {
      ensureContentScriptInitialized();
    }
  } catch (error) {
    console.error('[content] Invalid recording state:', error);
  }
});

chrome.storage.session
  .get(['workspace'])
  .then((result) => {
    if (readRecordingMode(result.workspace) === 'private') {
      console.log('[content] Recording paused — all tracking disabled');
      return;
    }
    ensureContentScriptInitialized();
  })
  .catch((error) => {
    console.error('[content] Could not load recording state:', error);
  });

function initContentScript() {
  let currentHistoryId = null;
  let maxScrollDepth = 0;
  let lastActiveTime = Date.now(); // reset on visibility→visible; null after leave report
  let _panelDismissed = false;
  let markupHidden = false;

  // Track scroll depth (throttled via rAF to avoid layout thrash on every scroll event)
  let _scrollRafPending = false;
  window.addEventListener(
    'scroll',
    () => {
      if (_scrollRafPending) return;
      _scrollRafPending = true;
      requestAnimationFrame(() => {
        _scrollRafPending = false;
        const scrollHeight =
          document.documentElement.scrollHeight - window.innerHeight;
        const currentScroll = window.scrollY;
        const depth =
          scrollHeight > 0 ? (currentScroll / scrollHeight) * 100 : 0;
        maxScrollDepth = Math.max(maxScrollDepth, depth);
      });
    },
    { passive: true },
  );

  // Extract the complete live DOM as structured Markdown. Raw HTML is saved
  // separately for replay, but desktop text search reads only this sidecar.
  function extractMarkdown() {
    if (!document.body) return '';
    return markdownExtractorModule.extractMarkdown(document.body, {
      baseUrl: document.baseURI,
    });
  }

  function slugFromUrl(url) {
    return pageIdentity.generateSlugFromUrl(url);
  }

  function getEmbeddedPageSlug() {
    const meta = document.querySelector('meta[name="x-browser-recall-slug"]');
    return meta?.content || null;
  }

  function getEmbeddedPageUrl() {
    const meta = document.querySelector('meta[name="x-browser-recall-url"]');
    return meta?.content || null;
  }

  // Generate identity from the current page URL. Snapshot pages carry an
  // embedded slug so highlights and popup reads resolve the same page entity.
  function getPageIdentity() {
    const embeddedSlug = getEmbeddedPageSlug();
    if (embeddedSlug) {
      return {
        slug: embeddedSlug,
        url: getEmbeddedPageUrl(),
        embedded: true,
      };
    }
    return {
      slug: slugFromUrl(window.location.href),
      url: window.location.href,
      embedded: false,
    };
  }

  function getSlugForCurrentPage() {
    return getPageIdentity().slug;
  }

  // ─── Note overlay factory ────────────────────────────────────────────
  // Highlight lifecycle behavior is supplied by the generated classic-script
  // artifact. This file adapts browser messages and daemon reads to that module.
  const highlightLifecycle = highlightLifecycleModule.create({
    document,
    getCurrentIdentity: getSlugForCurrentPage,
    loadNotes: requestPageNotes,
    onLoadError: showExtensionReloadNotification,
    onMark: attachMarkClickHandler,
    formatExcerpt: extensionSurface.formatHighlightExcerpt,
    reapplyDisabled: () => isPdfPage() || markupHidden,
  });

  function getStructuredSelectionPayload() {
    const prepared = highlightLifecycle.prepareSelection(window.getSelection());
    return {
      selectionText: prepared?.text || '',
      selectionExcerpt: prepared?.excerpt || [],
      selectionCssPath: prepared?.cssPath || [],
    };
  }

  function unwrapGroupedMarks(timestamp) {
    highlightLifecycle.remove({ timestamp });
  }

  function reapplyHighlights(options) {
    return highlightLifecycle.reapply(options);
  }

  function unwrapHighlightMark(mark) {
    highlightLifecycle.remove({ mark });
  }

  function removeHighlightMarksByNoteSlug(noteSlug) {
    highlightLifecycle.remove({ noteSlug });
  }

  // Marks own their click listener because events inside open shadow roots are
  // retargeted to the host before they reach the document adapter.
  function attachMarkClickHandler(mark) {
    mark.addEventListener('click', (event) => {
      event.stopPropagation();
      document.getElementById('browser-recall-highlight-overlay')?.remove();

      const noteSlug = mark.dataset.noteSlug;
      const text = mark.dataset.highlightText || mark.textContent;
      const pageSlug = getSlugForCurrentPage();
      if (!pageSlug) return;

      if (!noteSlug) {
        showHighlightEditOverlay(mark, text, null, '');
        return;
      }

      requestPageNotes(pageSlug)
        .then((notes) => {
          if (!notes) return;
          const match = notes.find((note) => note.slug === noteSlug);
          const displayText = match
            ? extensionSurface.formatHighlightExcerpt(match.excerpt)
            : text;
          showHighlightEditOverlay(
            mark,
            displayText,
            noteSlug,
            match?.note || '',
          );
        })
        .catch((error) => {
          if (showExtensionReloadNotification(error)) return;
          showHighlightEditOverlay(mark, text, noteSlug, '');
        });
    });
  }

  function showHighlightEditOverlay(mark, text, noteSlug, existingNote) {
    const rect = mark.getBoundingClientRect();
    const note = {
      slug: noteSlug || '',
      excerpt: String(text || mark.textContent)
        .split('\n')
        .filter(Boolean),
      note: existingNote,
    };
    extensionSurface.createHighlightEditOverlay({
      doc: document,
      view: window,
      rect,
      note,
      placeholder: tr('extensionAddNote', 'Add a note...'),
      confirmTitle: tr('commonConfirm', 'Confirm'),
      editTitle: tr('extensionEditNote', 'Edit note'),
      deleteTitle: tr('extensionDeleteHighlight', 'Delete highlight'),
      async save(nextNote) {
        if (nextNote === existingNote || !noteSlug) {
          return { noteSlug };
        }
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
          throw new Error(
            response?.error || tr('extensionUpdateFailed', 'Update failed'),
          );
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
          removeHighlightMarksByNoteSlug(noteSlug);
        } else {
          unwrapHighlightMark(mark);
        }
      },
      onError(error) {
        if (!showExtensionReloadNotification(error)) {
          showErrorNotification(
            error?.message || tr('extensionUpdateFailed', 'Update failed'),
          );
        }
      },
    });
  }

  // ─── Page Reporting ───────────────────────────────────────────────────

  // Must match INTERNAL_URL_PREFIXES in utils.js (can't import — content scripts are non-module).
  const internalUrlPrefixes = ['chrome://', 'edge://', 'about:'];

  function reportForUrl(url, delta) {
    if (getEmbeddedPageSlug()) return;
    if (
      internalUrlPrefixes.some((prefix) => url.startsWith(prefix)) ||
      url.startsWith('chrome-extension://')
    )
      return;
    chrome.runtime
      .sendMessage({ action: 'recordPageActivity', url, ...delta })
      .catch((error) => {
        console.debug('[content] passive page activity report failed:', error);
      });
  }

  // Track latest title locally; included in leave_page report.
  let latestTitle = document.title;
  let activePageUrl = window.location.href;

  function onLeavePage(url = activePageUrl) {
    if (lastActiveTime === null) return; // already reported, skip no-op
    const timeOnPage = Math.min(Date.now() - lastActiveTime, 3600000); // cap at 1h
    lastActiveTime = null; // prevent double-counting on subsequent fires
    reportForUrl(url, {
      title: latestTitle,
      scrollDepth: Math.round(maxScrollDepth),
      timeOnPage,
      isLeaving: true,
    });
  }

  function buildInitialVisitDelta(url, referrerUrl) {
    const delta = {
      title: document.title,
      slug: slugFromUrl(url),
      isInitialLoad: true,
    };
    // Capture first N words of page text for rule matching.
    // Must match BODY_WORD_LIMIT in utils.js (can't import — content scripts are non-module).
    const BODY_WORD_LIMIT = 200;
    const bodyText = (document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
    const bodyWords = bodyText.split(' ');
    if (bodyWords.length > 0 && bodyWords[0] !== '') {
      delta.bodyPreview = bodyWords.slice(0, BODY_WORD_LIMIT).join(' ');
    }
    const ref = referrerUrl ?? document.referrer;
    if (ref) delta.referrer = ref;
    return delta;
  }

  function reportInitialVisit(url = window.location.href, referrerUrl) {
    currentHistoryId = url;
    activePageUrl = url;
    latestTitle = document.title;
    reportForUrl(url, buildInitialVisitDelta(url, referrerUrl));
  }

  // Initial visit report
  reportInitialVisit(activePageUrl);

  function handleSameDocumentNavigation(nextUrl = window.location.href) {
    if (nextUrl === activePageUrl) return;
    if (pageIdentity.isSameDocumentPageUrl(activePageUrl, nextUrl)) return;

    const previousUrl = activePageUrl;
    onLeavePage(previousUrl);
    maxScrollDepth = 0;
    lastActiveTime = Date.now();
    reportInitialVisit(nextUrl, previousUrl);
    markupHidden = false;
    reapplyHighlights({ clearExisting: true });
  }

  const spaNavigationBridge = globalThis.__browserRecallSpaNavigationBridge;
  if (spaNavigationBridge?.addListener) {
    spaNavigationBridge.addListener((url) => {
      queueMicrotask(() => handleSameDocumentNavigation(url));
    });
  }

  // Title changes: cache locally so leave_page includes the latest title.
  function observeTitle(el) {
    new MutationObserver(() => {
      latestTitle = document.title;
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }
  const titleEl = document.querySelector('title');
  if (titleEl) {
    observeTitle(titleEl);
  } else if (document.head) {
    // No <title> yet — watch <head> for its addition.
    const headObs = new MutationObserver(() => {
      const added = document.querySelector('title');
      if (added) {
        headObs.disconnect();
        latestTitle = document.title;
        observeTitle(added);
      }
    });
    headObs.observe(document.head, { childList: true });
  }

  // Page leave/return: track foreground time only
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      onLeavePage();
    } else {
      lastActiveTime = Date.now(); // reset foreground timer on return
    }
  });

  document.addEventListener('freeze', () => {
    onLeavePage();
  });

  document.addEventListener('resume', () => {
    lastActiveTime = Date.now(); // reset foreground timer after unfreeze
  });

  // ─── Notification bubble factory ─────────────────────────────────────
  function showNotificationBubble({
    message,
    duration,
    fadeIn,
    fadeHold,
    tone = 'neutral',
  }) {
    const host = document.createElement('div');
    host.setAttribute('role', 'status');
    host.setAttribute('aria-label', message);
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const escapedMessage = extensionSurface.escapeHtml(message);
    shadow.innerHTML = `
    <style>
      ${extensionSurface.shadowCss}
      .bubble {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.92);
        z-index: 2147483647;
        min-width: 180px;
        max-width: min(360px, calc(100vw - 32px));
        background: var(--br-bg-base);
        color: var(--br-text-primary);
        border: var(--br-floating-border);
        border-radius: 2px;
        font-family: var(--br-font-body);
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 0.08em;
        line-height: 1.45;
        padding: 9px 12px;
        pointer-events: none;
        text-align: center;
        text-transform: uppercase;
        opacity: 0;
        animation: fadeInOut ${duration}s ease forwards;
      }
      .bubble.error {
        border-color: var(--br-accent-red);
        color: var(--br-accent-red);
      }
      @keyframes fadeInOut {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
        ${fadeIn}%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        ${fadeHold}%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.96); }
      }
    </style>
    <div class="bubble ${tone}">${escapedMessage}</div>
  `;
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), duration * 1000 + 100);
  }

  let _captureSpinnerHost = null;

  function showCaptureSpinner() {
    hideCaptureSpinner();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
    <style>
      ${extensionSurface.shadowCss}
      .bubble {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.92);
        z-index: 2147483647;
        background: var(--br-bg-base);
        color: var(--br-text-primary);
        border: var(--br-floating-border);
        border-radius: 2px;
        font-family: var(--br-font-body);
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 0.08em;
        line-height: 1.45;
        padding: 9px 12px;
        pointer-events: none;
        display: flex;
        align-items: center;
        gap: 8px;
        text-transform: uppercase;
        opacity: 0;
        animation: fadeIn 0.18s ease forwards;
      }
      @keyframes fadeIn {
        to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--br-border-section);
        border-top-color: var(--br-text-primary);
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
      }
    </style>
    <div class="bubble"><span class="spinner"></span>${extensionSurface.escapeHtml(tr('extensionCapturing', 'Capturing...'))}</div>
  `;
    document.documentElement.appendChild(host);
    _captureSpinnerHost = host;
  }

  function hideCaptureSpinner() {
    if (_captureSpinnerHost) {
      _captureSpinnerHost.remove();
      _captureSpinnerHost = null;
    }
  }

  function showCaptureNotification() {
    showNotificationBubble({
      message: tr('extensionSnapshotCaptured', 'Snapshot captured'),
      duration: 1.6,
      fadeIn: 12,
      fadeHold: 75,
    });
  }

  function showLikeNotification(delta = 1) {
    showNotificationBubble({
      message:
        delta >= 0
          ? tr('extensionLiked', 'Liked')
          : tr('extensionDisliked', 'Disliked'),
      duration: 1.6,
      fadeIn: 12,
      fadeHold: 75,
    });
  }

  function showErrorNotification(message) {
    showNotificationBubble({
      message,
      duration: 2.4,
      fadeIn: 10,
      fadeHold: 80,
      tone: 'error',
    });
  }

  function isExtensionRuntimeFailure(error) {
    return Boolean(
      globalThis.browserRecallWebExtension?.isRuntimeFailure?.(error),
    );
  }

  function showExtensionReloadNotification(error) {
    if (!isExtensionRuntimeFailure(error)) return false;
    showErrorNotification(
      tr(
        'extensionReloaded',
        'Browser Recall extension reloaded. Please reload the page and try again.',
      ),
    );
    return true;
  }

  function showUserActionFailureFromResponse(
    resp,
    fallback,
    requiredStringFields = [],
  ) {
    const valid =
      resp?.success === true &&
      requiredStringFields.every(
        (field) =>
          typeof resp[field] === 'string' && resp[field].trim().length > 0,
      );
    if (valid) return false;
    const message =
      resp?.error || fallback || tr('extensionActionFailed', 'Action failed');
    if (!showExtensionReloadNotification(message)) {
      showErrorNotification(message);
    }
    return true;
  }

  async function requestPageNotes(slug) {
    const response = await chrome.runtime.sendMessage({
      action: 'loadPageNotes',
      slug,
    });
    if (
      showUserActionFailureFromResponse(
        response,
        tr('extensionCouldNotLoadNotes', 'Could not load notes.'),
      )
    ) {
      console.warn('[content] loadPageNotes failed:', response?.error);
      return null;
    }
    if (response?.success !== true || !Array.isArray(response.notes)) {
      showErrorNotification(
        tr('extensionCouldNotLoadNotes', 'Could not load notes.'),
      );
      return null;
    }
    return response.notes;
  }

  // ─── Highlights Panel (for pages where visual marks can't render) ─────

  function showHighlightsPanel(notes, pageSlug, { hint } = {}) {
    const existing = document.getElementById('browser-recall-highlights-panel');
    const excerptNotes = notes;
    if (excerptNotes.length === 0 && !hint) return;

    const host = existing || document.createElement('div');
    if (!existing) {
      host.id = 'browser-recall-highlights-panel';
      host.style.cssText =
        'position: fixed; z-index: 2147483647; top: 16px; right: 16px;';
      document.body.appendChild(host);
    }

    const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    const panelScrollTop = shadow.querySelector('.panel')?.scrollTop || 0;
    shadow.innerHTML = `
    <style>
      ${extensionSurface.shadowCss}
      ${extensionSurface.highlightEntryCss}
      .panel { --br-highlight-side-padding: 12px; width: 300px; max-height: 400px; overflow-y: auto; scrollbar-width: none; background: var(--br-bg-base); border: var(--br-floating-border); border-radius: 2px; color: var(--br-text-primary); font-family: var(--br-font-body); font-size: 12px; line-height: 1.45; }
      .panel::-webkit-scrollbar { display: none; width: 0; height: 0; }
      .panel-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--br-bg-base); border-bottom: 1px solid var(--br-border-section); color: var(--br-text-primary); cursor: move; font-size: 10px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase; user-select: none; }
      .close-btn { width: 22px; height: 22px; background: none; border: none; border-radius: 2px; cursor: pointer; color: var(--br-text-muted); font-size: 16px; line-height: 1; padding: 0; }
      .close-btn:hover { background: var(--br-bg-surface-active); color: var(--br-text-primary); }
      .hint { padding: 8px 12px; border-top: 1px solid var(--br-border-section); font-size: 11px; color: var(--br-text-muted); line-height: 1.4; }
    </style>
    <div class="panel">
      <div class="panel-header">
        <span>${extensionSurface.escapeHtml(tr('extensionHighlightsCount', `Highlights (${excerptNotes.length})`, [excerptNotes.length]))}</span>
        <button class="close-btn" title="${extensionSurface.escapeHtml(tr('commonClose', 'Close'))}">&times;</button>
      </div>
      ${excerptNotes
        .map((note) =>
          extensionSurface.highlightEntryHtml(note, {
            deleteTitle: tr('extensionDeleteHighlight', 'Delete highlight'),
            editTitle: tr('extensionEditNote', 'Edit note'),
          }),
        )
        .join('')}
      ${hint ? `<div class="hint">${extensionSurface.escapeHtml(hint)}</div>` : ''}
    </div>
  `;

    const panel = shadow.querySelector('.panel');
    if (panel) panel.scrollTop = panelScrollTop;

    shadow.querySelector('.close-btn').addEventListener('click', () => {
      _panelDismissed = true;
      teardownPanel();
    });

    shadow.querySelectorAll('.highlight-item').forEach((item) => {
      let noteSlug = item.dataset.noteSlug;
      const note = excerptNotes.find(
        (candidate) => candidate.slug === noteSlug,
      );
      item
        .querySelector('.note-action-btn.delete')
        .addEventListener('click', async (event) => {
          const action = event.currentTarget;
          action.disabled = true;
          try {
            const response = await chrome.runtime.sendMessage({
              action: 'deleteNote',
              noteSlug,
            });
            if (
              showUserActionFailureFromResponse(
                response,
                tr('extensionSomethingWentWrong', 'Something went wrong'),
              )
            ) {
              action.disabled = false;
              return;
            }
          } catch (error) {
            action.disabled = false;
            showExtensionReloadNotification(error);
            return;
          }
          removeHighlightMarksByNoteSlug(noteSlug);
          const noteIndex = notes.findIndex(
            (candidate) => candidate.slug === noteSlug,
          );
          if (noteIndex >= 0) notes.splice(noteIndex, 1);
          item.remove();
          const remaining = shadow.querySelectorAll('.highlight-item').length;
          shadow.querySelector('.panel-header span').textContent = tr(
            'extensionHighlightsCount',
            `Highlights (${remaining})`,
            [remaining],
          );
          if (remaining === 0) teardownPanel();
        });
      item
        .querySelector('.note-action-btn.edit')
        .addEventListener('click', (event) => {
          const action = event.currentTarget;
          if (!action.classList.contains('edit') || !note) return;
          extensionSurface.openHighlightNoteEditor({
            item,
            note,
            placeholder: tr('extensionAddNote', 'Add a note...'),
            confirmTitle: tr('commonConfirm', 'Confirm'),
            editTitle: tr('extensionEditNote', 'Edit note'),
            async save(nextNote) {
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
                throw new Error(
                  response?.error ||
                    tr('extensionUpdateFailed', 'Update failed'),
                );
              }
              return response;
            },
            onSaved(response) {
              const oldSlug = noteSlug;
              noteSlug = response.noteSlug;
              note.slug = response.noteSlug;
              document
                .querySelectorAll(
                  `mark.browser-recall-highlight[data-note-slug="${cssEscape(oldSlug)}"]`,
                )
                .forEach((mark) => {
                  mark.dataset.noteSlug = response.noteSlug;
                });
            },
            onError(error) {
              showErrorNotification(error.message);
            },
          });
        });
    });

    // Drag support
    let isDragging = false,
      dragX = 0,
      dragY = 0;
    const header = shadow.querySelector('.panel-header');
    header.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragX = e.clientX - host.getBoundingClientRect().left;
      dragY = e.clientY - host.getBoundingClientRect().top;
      e.preventDefault();
    });
    const onMouseMove = (e) => {
      if (!isDragging) return;
      host.style.left = e.clientX - dragX + 'px';
      host.style.top = e.clientY - dragY + 'px';
      host.style.right = 'auto';
    };
    const onMouseUp = () => {
      isDragging = false;
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    function teardownPanel() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      host.remove();
    }
  }

  function isPdfPage() {
    return (
      /\.pdf(\?|#|$)/i.test(new URL(window.location.href).pathname) ||
      !!document.querySelector('embed[type="application/pdf"]')
    );
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Skip Save Page WE messages (use `type` field, handled by savepage/content.js)
    if (!request.action) return false;

    if (request.action === 'extractMarkdown') {
      // Extract markdown for snapshot (HTML comes from Save Page WE flow)
      const markdown = extractMarkdown();
      sendResponse({ success: true, markdown });
    } else if (request.action === 'getPageIdentity') {
      sendResponse({ success: true, ...getPageIdentity() });
    } else if (request.action === 'getStructuredSelectionText') {
      try {
        const payload = getStructuredSelectionPayload();
        sendResponse({
          success: true,
          ...payload,
        });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || String(error),
        });
      }
    } else if (request.action === 'highlightSelection') {
      // Highlight selected text (triggered by Alt+H)
      const selection = window.getSelection();
      const selectedText = selection.toString().trim();
      console.log(
        `[content] highlightSelection: selectedText="${selectedText.substring(0, 50)}" (${selectedText.length} chars)`,
      );

      if (selectedText.length > 0 && selection.rangeCount > 0) {
        let preparedSelection;
        try {
          preparedSelection = highlightLifecycle.prepareSelection(selection);
        } catch (error) {
          sendResponse({
            success: false,
            error: error?.message || String(error),
          });
        }

        if (preparedSelection) {
          const slug = getSlugForCurrentPage();
          const timestamp = Date.now();
          if (preparedSelection.excerpt.length > 1) {
            console.log(
              '[content] Multi-block selection detected, splitting by block',
            );
          }
          if (!slug) {
            sendResponse({
              success: false,
              error: 'Current page identity is unavailable',
            });
          } else {
            console.log(
              `[content] Saving note: slug=${slug}, text="${preparedSelection.text.substring(0, 50)}"`,
            );
            chrome.runtime
              .sendMessage({
                action: 'createNote',
                pageSlug: slug,
                url: window.location.href,
                excerpt: preparedSelection.excerpt,
                note: '',
                cssPath: preparedSelection.cssPath,
              })
              .then((resp) => {
                if (
                  showUserActionFailureFromResponse(
                    resp,
                    tr('extensionHighlightFailed', 'Highlight failed'),
                    ['noteSlug'],
                  )
                ) {
                  sendResponse({
                    success: false,
                    error:
                      resp?.error ||
                      tr('extensionHighlightFailed', 'Highlight failed'),
                  });
                  return;
                }
                const noteSlug = resp?.noteSlug;
                const marks = preparedSelection.apply({
                  timestamp,
                  noteSlug,
                });
                if (marks.length !== preparedSelection.excerpt.length) {
                  throw new Error(
                    'The selected range could not be wrapped after the note committed',
                  );
                }
                showHighlightEditOverlay(
                  marks[0],
                  preparedSelection.text,
                  noteSlug,
                  '',
                );
                selection.removeAllRanges();
                sendResponse({ success: true });
              })
              .catch((error) => {
                if (!showExtensionReloadNotification(error)) {
                  showErrorNotification(
                    error?.message ||
                      tr('extensionHighlightFailed', 'Highlight failed'),
                  );
                }
                sendResponse({
                  success: false,
                  error: error?.message || String(error),
                });
              });
          }
        }
      } else {
        sendResponse({
          success: false,
          error: 'Select text before creating a highlight',
        });
      }
    } else if (request.action === 'removeHighlightMark') {
      // Remove visual highlight marks — by timestamp for grouped highlights, by text for singles
      if (request.noteSlug) {
        removeHighlightMarksByNoteSlug(request.noteSlug);
      } else if (request.timestamp) {
        unwrapGroupedMarks(request.timestamp);
      } else {
        highlightLifecycle.remove({ text: request.text });
      }
      sendResponse({ success: true });
    } else if (request.action === 'hideHighlightMarkup') {
      document.getElementById('browser-recall-highlight-overlay')?.remove();
      markupHidden = true;
      highlightLifecycle.dispose({ clearExisting: true });
      sendResponse({ success: true });
    } else if (request.action === 'showHighlightMarkup') {
      markupHidden = false;
      reapplyHighlights({ clearExisting: true })
        .then(() => sendResponse({ success: true }))
        .catch((error) => {
          markupHidden = true;
          sendResponse({
            success: false,
            error: error?.message || String(error),
          });
        });
    } else if (request.action === 'getHighlightMarkupState') {
      sendResponse({ success: true, hidden: markupHidden });
    } else if (request.action === 'showHighlightsPanel') {
      if (!Array.isArray(request.notes)) {
        sendResponse({
          success: false,
          error: 'showHighlightsPanel notes must be an array',
        });
        return;
      }
      _panelDismissed = false; // Reset so new highlight shows panel
      showHighlightsPanel(request.notes, request.pageSlug);
      sendResponse({ success: true });
    } else if (request.action === 'isPdfPage') {
      sendResponse({
        isPdf: !!document.querySelector('embed[type="application/pdf"]'),
      });
    } else if (request.action === 'showCaptureSpinner') {
      showCaptureSpinner();
      sendResponse({ success: true });
    } else if (request.action === 'hideCaptureSpinner') {
      hideCaptureSpinner();
      sendResponse({ success: true });
    } else if (request.action === 'showCaptureNotification') {
      showCaptureNotification();
      sendResponse({ success: true });
    } else if (request.action === 'showErrorNotification') {
      showErrorNotification(
        request.message ||
          tr('extensionSomethingWentWrong', 'Something went wrong'),
      );
      sendResponse({ success: true });
    } else if (request.action === 'showLikeNotification') {
      showLikeNotification(request.delta);
      sendResponse({ success: true });
    }

    return true; // Keep channel open for async sendResponse
  });

  // Re-apply highlights on page load, unless this is a PDF viewer page.
  if (!isPdfPage()) {
    reapplyHighlights();
  }

  // On PDF pages, show highlights panel with hint.
  // Delay to let Chrome's PDF viewer finish initializing (it replaces DOM after content script runs).
  try {
    setTimeout(() => {
      if (!isPdfPage()) return;
      const pdfSlug = getSlugForCurrentPage();
      let pdfRetryTimer = null;

      function renderPdfHighlights(notes) {
        showHighlightsPanel(notes, pdfSlug, {
          hint: tr(
            'extensionPdfHighlightHint',
            'Select text and right-click to highlight',
          ),
        });
      }

      function showPdfPanel() {
        chrome.runtime
          .sendMessage({ action: 'loadPageNotes', slug: pdfSlug })
          .then((resp) => {
            if (
              showUserActionFailureFromResponse(
                resp,
                tr(
                  'extensionCouldNotLoadHighlights',
                  'Could not load highlights.',
                ),
              )
            ) {
              return;
            }
            if (!Array.isArray(resp.notes)) {
              throw new Error('loadPageNotes response notes must be an array');
            }
            renderPdfHighlights(resp.notes);
          })
          .catch((error) => {
            if (showExtensionReloadNotification(error)) return;
            showErrorNotification(error.message);
          });
      }
      showPdfPanel();
      // Re-show if PDF viewer destroys the panel (but not if user dismissed it).
      // Debounce to avoid pile-up from rapid mutations.
      const pdfObserver = new MutationObserver(() => {
        if (
          !document.getElementById('browser-recall-highlights-panel') &&
          !_panelDismissed
        ) {
          if (pdfRetryTimer) return;
          pdfRetryTimer = setTimeout(() => {
            pdfRetryTimer = null;
            showPdfPanel();
          }, 500);
        }
      });
      if (document.body) {
        pdfObserver.observe(document.body, { childList: true });
        window.addEventListener('pagehide', () => pdfObserver.disconnect(), {
          once: true,
        });
      }
    }, 1500);
  } catch (error) {
    console.error('[Browser Recall] content initialization failed:', error);
    showErrorNotification(error.message);
  }

  // Before unload, send final attention report
  window.addEventListener('beforeunload', () => {
    onLeavePage();
  });
} // end initContentScript
