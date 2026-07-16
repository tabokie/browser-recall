// Content script for capturing user intent and attention (scroll depth, time on page)
console.log('Browser Recall content script loaded on:', window.location.href);

const extensionSurface = globalThis.browserRecallExtensionSurface;
const pageIdentity = globalThis.browserRecallPageIdentity;
const highlightLifecycleModule = globalThis.browserRecallHighlightLifecycle;

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

// Recording paused: skip all content script functionality.
chrome.storage.session.get(['workspace'], (result) => {
  const recordingState = result.workspace;
  if (recordingState && recordingState.mode === 'private') {
    console.log('[content] Recording paused — all tracking disabled');
    return;
  }
  initContentScript();
});

function initContentScript() {
  let currentHistoryId = null;
  let maxScrollDepth = 0;
  let lastActiveTime = Date.now(); // reset on visibility→visible; null after leave report
  let _panelDismissed = false;

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

  // Extract page content as Markdown
  function extractMarkdown() {
    const SKIP_TAGS = new Set([
      'SCRIPT',
      'STYLE',
      'NAV',
      'HEADER',
      'FOOTER',
      'NOSCRIPT',
      'SVG',
    ]);
    const maxLength = 10000;
    let result = '';

    function processNode(node) {
      if (result.length >= maxLength) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (text) {
          result += text;
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName;

      if (SKIP_TAGS.has(tag)) return;
      // Skip hidden elements
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return;

      switch (tag) {
        case 'H1':
          result += '\n\n# ';
          processChildren(node);
          result += '\n\n';
          break;
        case 'H2':
          result += '\n\n## ';
          processChildren(node);
          result += '\n\n';
          break;
        case 'H3':
          result += '\n\n### ';
          processChildren(node);
          result += '\n\n';
          break;
        case 'H4':
          result += '\n\n#### ';
          processChildren(node);
          result += '\n\n';
          break;
        case 'H5':
          result += '\n\n##### ';
          processChildren(node);
          result += '\n\n';
          break;
        case 'H6':
          result += '\n\n###### ';
          processChildren(node);
          result += '\n\n';
          break;

        case 'P':
          result += '\n\n';
          processChildren(node);
          result += '\n\n';
          break;
        case 'BR':
          result += '\n';
          break;
        case 'HR':
          result += '\n\n---\n\n';
          break;

        case 'A': {
          const href = node.getAttribute('href');
          result += '[';
          processChildren(node);
          result += `](${href || ''})`;
          break;
        }

        case 'STRONG':
        case 'B':
          result += '**';
          processChildren(node);
          result += '**';
          break;

        case 'EM':
        case 'I':
          result += '*';
          processChildren(node);
          result += '*';
          break;

        case 'CODE':
          if (node.parentElement && node.parentElement.tagName === 'PRE') {
            // Handled by PRE case
            processChildren(node);
          } else {
            result += '`';
            processChildren(node);
            result += '`';
          }
          break;

        case 'PRE':
          result += '\n\n```\n';
          processChildren(node);
          result += '\n```\n\n';
          break;

        case 'BLOCKQUOTE':
          result += '\n\n> ';
          processChildren(node);
          result += '\n\n';
          break;

        case 'UL':
        case 'OL':
          result += '\n';
          processChildren(node);
          result += '\n';
          break;

        case 'LI': {
          const parent = node.parentElement;
          if (parent && parent.tagName === 'OL') {
            const items = Array.from(parent.children).filter(
              (c) => c.tagName === 'LI',
            );
            const index = items.indexOf(node) + 1;
            result += `\n${index}. `;
          } else {
            result += '\n- ';
          }
          processChildren(node);
          break;
        }

        case 'IMG': {
          const alt = node.getAttribute('alt') || '';
          const src = node.getAttribute('src') || '';
          result += `![${alt}](${src})`;
          break;
        }

        case 'DIV':
        case 'SECTION':
        case 'ARTICLE':
        case 'MAIN':
          result += '\n';
          processChildren(node);
          result += '\n';
          break;

        default:
          processChildren(node);
          break;
      }
    }

    function processChildren(node) {
      for (const child of node.childNodes) {
        if (result.length >= maxLength) break;
        processNode(child);
      }
    }

    if (document.body) {
      processNode(document.body);
    }

    // Clean up excessive whitespace
    return result
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .substring(0, maxLength);
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

  // Generate a CSS selector path for an element (for re-applying highlights)
  function getCssPath(el) {
    const parts = [];
    while (el && el !== document.body) {
      let selector = el.tagName.toLowerCase();
      if (el.id) {
        selector += '#' + cssEscape(el.id);
        parts.unshift(selector);
        return parts.join(' > ');
      }
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === el.tagName,
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(el) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(selector);
      el = parent;
    }
    return 'body > ' + parts.join(' > ');
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => {
      return `\\${character.codePointAt(0).toString(16)} `;
    });
  }

  function getCssPathsForChunks(chunks) {
    return chunks.map((chunk) => getCssPath(chunk.block));
  }

  // ─── Note overlay factory ────────────────────────────────────────────
  function createNoteOverlay({
    positionStyle,
    extraCss,
    beforeTextareaHtml,
    bodyHtml,
    placeholder,
    existingNote,
    onClose,
  }) {
    const prev = document.getElementById('browser-recall-highlight-overlay');
    if (prev) prev.remove();

    const host = document.createElement('div');
    host.id = 'browser-recall-highlight-overlay';
    host.style.cssText = positionStyle + ' z-index: 2147483647;';

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
    <style>
      ${extensionSurface.shadowCss}
      .overlay {
        width: 300px;
        background: var(--br-bg-base);
        border: var(--br-floating-border);
        border-radius: 2px;
        color: var(--br-text-primary);
        font-family: var(--br-font-body);
        font-size: 12px;
        line-height: 1.45;
        padding: 8px;
      }
      .br-note-label {
        margin-bottom: 7px;
        color: var(--br-text-muted);
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .br-note-excerpt {
        margin-bottom: 8px;
        padding: 7px 0 8px;
        border-top: 1px dotted var(--br-border-section);
        border-bottom: 1px dotted var(--br-border-section);
        color: var(--br-text-muted);
        font-style: italic;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .br-note-editor {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .br-note-body {
        flex: 1;
        min-width: 0;
      }
      textarea {
        width: 100%;
        min-height: 30px;
        height: 30px;
        border: 1px solid var(--br-border-section);
        border-radius: 2px;
        padding: 5px 8px;
        font-family: inherit;
        font-size: 12px;
        resize: none;
        box-sizing: border-box;
        line-height: 18px;
        overflow: hidden;
        background: transparent;
        color: var(--br-text-primary);
      }
      textarea::placeholder { color: var(--br-text-muted); }
      textarea:focus {
        outline: none;
        border-color: var(--br-accent-primary);
        box-shadow: 0 0 0 3px var(--br-accent-soft);
      }
      ${extraCss || ''}
    </style>
    <div class="overlay">
      ${
        bodyHtml ||
        `
        <div class="br-note-editor">
          ${beforeTextareaHtml || ''}
          <div class="br-note-body">
            <textarea placeholder="${placeholder}"></textarea>
          </div>
        </div>
      `
      }
    </div>
  `;

    document.body.appendChild(host);

    const textarea = shadow.querySelector('textarea');
    textarea.value = existingNote || '';

    function autoResize() {
      textarea.style.height = '0';
      textarea.style.height = Math.max(30, textarea.scrollHeight) + 'px';
    }
    if (existingNote) autoResize();

    textarea.focus();
    textarea.addEventListener('input', autoResize);

    let closed = false;
    async function finish({ save }) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mousedown', handleOutsideClick);
      const note = save ? textarea.value : null;
      if (!save) {
        host.remove();
        return;
      }
      try {
        await onClose(note);
      } catch (error) {
        showExtensionReloadNotification(error);
      } finally {
        host.remove();
      }
    }

    function close() {
      finish({ save: true });
    }

    function dismiss() {
      finish({ save: false });
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    const handleOutsideClick = (e) => {
      if (!host.contains(e.target)) close();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    setTimeout(() => {
      document.addEventListener('mousedown', handleOutsideClick);
    }, 100);

    return { host, shadow, textarea, close, dismiss };
  }

  // Show overlay for global page note (no text selection required)
  function showGlobalNoteOverlay(existingNote, existingNoteSlug, pageSlug) {
    createNoteOverlay({
      positionStyle:
        'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);',
      bodyHtml: extensionSurface.noteOverlayHtml({
        title: tr('extensionPageNote', 'Page Note'),
        placeholder: tr(
          'extensionAddPageNoteEsc',
          'Add a page note... Esc to save.',
        ),
      }),
      placeholder: tr(
        'extensionAddPageNoteEsc',
        'Add a page note... Esc to save.',
      ),
      existingNote,
      async onClose(note) {
        if (note === (existingNote || '')) return;

        try {
          if (existingNoteSlug) {
            const response = await chrome.runtime.sendMessage({
              action: 'updateNote',
              noteSlug: existingNoteSlug,
              note,
            });
            if (
              showUserActionFailureFromResponse(
                response,
                tr('extensionUpdateFailed', 'Update failed'),
                ['noteSlug'],
              )
            ) {
              return;
            }
            if (response?.noteSlug) existingNoteSlug = response.noteSlug;
            return;
          }

          const response = await chrome.runtime.sendMessage({
            action: 'createNote',
            pageSlug,
            url: window.location.href,
            excerpt: null,
            note,
            cssPath: null,
          });
          showUserActionFailureFromResponse(
            response,
            tr('extensionCreateNoteFailed', 'Create note failed'),
            ['noteSlug'],
          );
        } catch (error) {
          showExtensionReloadNotification(error);
        }
      },
    });
  }

  // Highlight lifecycle behavior is supplied by the generated classic-script
  // artifact. This file adapts browser messages and daemon reads to that module.
  const highlightLifecycle = highlightLifecycleModule.create({
    document,
    getCurrentIdentity: getSlugForCurrentPage,
    loadNotes: requestPageNotes,
    onLoadError: showExtensionReloadNotification,
    onMark: attachMarkClickHandler,
    formatExcerpt: extensionSurface.formatHighlightExcerpt,
    getCssPath,
    reapplyDisabled: isPdfPage,
  });

  function getStructuredSelectionPayload() {
    const { chunks: _chunks, ...payload } =
      highlightLifecycle.describeSelection(window.getSelection());
    return payload;
  }

  function wrapRangeWithMark(range, text, timestamp) {
    return highlightLifecycle.createMark(range, text, { timestamp });
  }

  function highlightTextInPage(text) {
    return highlightLifecycle.findAndMark(text);
  }

  function highlightTextInBlock(block, text, options = {}) {
    return highlightLifecycle.findAndMark(text, {
      root: block || document.body,
      globalFallback: options.globalFallback !== false,
    });
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
    const { host, shadow, textarea, dismiss } = createNoteOverlay({
      positionStyle: 'position: absolute; visibility: hidden;',
      extraCss: `
      .delete-btn { flex-shrink:0; width:30px; height:30px; display:flex; align-items:center; justify-content:center; background:none; border:1px solid var(--br-border-section); border-radius:2px; cursor:pointer; color:var(--br-text-muted); padding:0; }
      .delete-btn:hover { background:var(--br-bg-surface-active); border-color:var(--br-text-primary); color:var(--br-text-primary); }
      .delete-btn svg { width:16px; height:16px; fill:currentColor; }`,
      beforeTextareaHtml: extensionSurface.trashButtonHtml(
        tr('commonDelete', 'Delete'),
      ),
      bodyHtml: extensionSurface.noteOverlayHtml({
        excerpt: text || '',
        placeholder: tr('extensionAddNoteEsc', 'Add a note... Esc to save.'),
        includeDelete: true,
        deleteTitle: tr('commonDelete', 'Delete'),
      }),
      placeholder: tr('extensionAddNoteEsc', 'Add a note... Esc to save.'),
      existingNote,
      async onClose(note) {
        if (note === existingNote || !noteSlug) return;
        try {
          const response = await chrome.runtime.sendMessage({
            action: 'updateNote',
            noteSlug,
            note,
          });
          if (
            showUserActionFailureFromResponse(
              response,
              tr('extensionUpdateFailed', 'Update failed'),
              ['noteSlug'],
            )
          ) {
            return;
          }
          if (response?.noteSlug) {
            highlightLifecycle.replaceNote(noteSlug, response.noteSlug);
          }
        } catch (error) {
          showExtensionReloadNotification(error);
        }
      },
    });
    extensionSurface.positionNearRect(host, rect);
    textarea.focus();

    shadow.querySelector('.delete-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      if (noteSlug) removeHighlightMarksByNoteSlug(noteSlug);
      else unwrapHighlightMark(mark);
      if (noteSlug) {
        chrome.runtime
          .sendMessage({ action: 'deleteNote', noteSlug })
          .catch((error) => showExtensionReloadNotification(error));
      }
      dismiss();
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
    const excerptNotes = notes.filter((n) => n.excerpt !== null);
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
      .panel { width: 300px; max-height: 400px; overflow-y: auto; background: var(--br-bg-base); border: var(--br-floating-border); border-radius: 2px; color: var(--br-text-primary); font-family: var(--br-font-body); font-size: 12px; line-height: 1.45; }
      .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--br-border-section); color: var(--br-text-primary); cursor: move; font-size: 10px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase; user-select: none; }
      .close-btn { width: 22px; height: 22px; background: none; border: none; border-radius: 2px; cursor: pointer; color: var(--br-text-muted); font-size: 16px; line-height: 1; padding: 0; }
      .close-btn:hover { background: var(--br-bg-surface-active); color: var(--br-text-primary); }
      .highlight-item { display: grid; grid-template-columns: 18px 1fr; column-gap: 8px; padding: 9px 12px; border-bottom: 1px dotted var(--br-border-section); }
      .highlight-item::before { content: attr(data-note-index); color: var(--br-accent-red); font-weight: 900; }
      .highlight-item:last-child { border-bottom: none; }
      .excerpt { color: var(--br-text-muted); font-style: italic; line-height: 1.45; margin-bottom: 5px; white-space: pre-wrap; word-break: break-word; }
      .note-row { display: flex; align-items: flex-start; gap: 6px; }
      textarea { flex: 1; min-height: 24px; height: 24px; border: 1px solid var(--br-border-section); border-radius: 2px; padding: 3px 6px; background: transparent; color: var(--br-text-primary); font-family: inherit; font-size: 11px; resize: none; box-sizing: border-box; line-height: 16px; overflow: hidden; }
      textarea::placeholder { color: var(--br-text-muted); }
      textarea:focus { outline: none; border-color: var(--br-accent-primary); box-shadow: 0 0 0 3px var(--br-accent-soft); }
      .delete-btn { flex-shrink: 0; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; background: none; border: none; border-radius: 2px; cursor: pointer; color: var(--br-text-muted); padding: 0; }
      .delete-btn:hover { background: var(--br-bg-surface-active); color: var(--br-text-primary); }
      .delete-btn svg { width: 14px; height: 14px; fill: currentColor; }
      .highlight-body { min-width: 0; }
      .hint { padding: 8px 12px; border-top: 1px solid var(--br-border-section); font-size: 11px; color: var(--br-text-muted); line-height: 1.4; }
    </style>
    <div class="panel">
      <div class="panel-header">
        <span>${extensionSurface.escapeHtml(tr('extensionHighlightsCount', `Highlights (${excerptNotes.length})`, [excerptNotes.length]))}</span>
        <button class="close-btn" title="${extensionSurface.escapeHtml(tr('commonClose', 'Close'))}">&times;</button>
      </div>
      ${excerptNotes
        .map((n, index) => {
          const text = extensionSurface.formatHighlightExcerpt(n.excerpt);
          return `<div class="highlight-item" data-note-slug="${n.slug}" data-note-index="${String(index + 1).padStart(2, '0')}">
          <div class="highlight-body">
          <div class="excerpt">${extensionSurface.escapeHtml(text)}</div>
          <div class="note-row">
            <textarea placeholder="${extensionSurface.escapeHtml(tr('extensionAddNote', 'Add a note...'))}">${extensionSurface.escapeHtml(n.note || '')}</textarea>
            <button class="delete-btn" title="${extensionSurface.escapeHtml(tr('commonDelete', 'Delete'))}"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
          </div>
          </div>
        </div>`;
        })
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

    shadow.querySelectorAll('textarea').forEach((ta) => {
      function autoResize() {
        ta.style.height = '24px';
        if (ta.scrollHeight > 24) ta.style.height = ta.scrollHeight + 'px';
      }
      if (ta.value) autoResize();
      ta.addEventListener('input', autoResize);
    });

    shadow.querySelectorAll('.highlight-item').forEach((item) => {
      let noteSlug = item.dataset.noteSlug;
      const ta = item.querySelector('textarea');
      const origValue = ta.value;
      ta.addEventListener('blur', () => {
        if (ta.value !== origValue)
          chrome.runtime
            .sendMessage({ action: 'updateNote', noteSlug, note: ta.value })
            .then((resp) => {
              if (
                showUserActionFailureFromResponse(
                  resp,
                  tr('extensionUpdateFailed', 'Update failed'),
                  ['noteSlug'],
                )
              ) {
                return;
              }
              if (resp?.noteSlug) {
                const oldSlug = noteSlug;
                noteSlug = resp.noteSlug;
                item.dataset.noteSlug = resp.noteSlug;
                // Update matching mark(s) in the page so re-click uses the new slug
                document
                  .querySelectorAll(
                    `mark.browser-recall-highlight[data-note-slug="${oldSlug}"]`,
                  )
                  .forEach((m) => {
                    m.dataset.noteSlug = resp.noteSlug;
                  });
              }
            })
            .catch((error) => {
              showExtensionReloadNotification(error);
            });
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') ta.blur();
      });
      item.querySelector('.delete-btn').addEventListener('click', () => {
        chrome.runtime
          .sendMessage({ action: 'deleteNote', noteSlug })
          .catch((error) => {
            showExtensionReloadNotification(error);
          });
        removeHighlightMarksByNoteSlug(noteSlug);
        item.remove();
        const remaining = shadow.querySelectorAll('.highlight-item').length;
        shadow.querySelector('.panel-header span').textContent = tr(
          'extensionHighlightsCount',
          `Highlights (${remaining})`,
          [remaining],
        );
        if (remaining === 0) teardownPanel();
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
      const payload = getStructuredSelectionPayload();
      sendResponse({
        success: true,
        ...payload,
      });
    } else if (request.action === 'highlightSelection') {
      // Highlight selected text or open global note (triggered by Alt+H)
      const selection = window.getSelection();
      const selectedText = selection.toString().trim();
      console.log(
        `[content] highlightSelection: selectedText="${selectedText.substring(0, 50)}" (${selectedText.length} chars)`,
      );

      if (selectedText.length > 0 && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const selectionDescription =
          highlightLifecycle.describeSelection(selection);
        const cssPath = selectionDescription.selectionCssPath[0] || '';
        const slug = getSlugForCurrentPage();
        if (!slug) {
          sendResponse({ success: false });
          return;
        }
        const timestamp = Date.now();

        const chunkInfos = selectionDescription.chunks;
        if (chunkInfos.length > 1) {
          // Cross-visual-block selection — split into per-block chunks.
          console.log(
            `[content] Multi-block selection detected, splitting by block`,
          );
          const texts = chunkInfos.map((c) => c.text);
          const cssPaths = getCssPathsForChunks(chunkInfos);
          chrome.runtime
            .sendMessage({
              action: 'createNote',
              pageSlug: slug,
              url: window.location.href,
              excerpt: texts,
              note: '',
              cssPath: cssPaths,
            })
            .then((resp) => {
              if (
                showUserActionFailureFromResponse(
                  resp,
                  tr('extensionHighlightFailed', 'Highlight failed'),
                  ['noteSlug'],
                )
              ) {
                return;
              }
              const noteSlug = resp?.noteSlug;
              const marks = [];
              for (const { text, block } of chunkInfos) {
                const m = highlightTextInBlock(block, text);
                if (m && noteSlug) {
                  m.dataset.noteSlug = noteSlug;
                  marks.push(m);
                }
              }
              if (marks.length > 0) {
                showHighlightEditOverlay(
                  marks[0],
                  texts.join('\n'),
                  noteSlug,
                  '',
                );
              }
            })
            .catch((error) => {
              showExtensionReloadNotification(error);
            });
        } else {
          // Case 1 & 2: same-block selection
          console.log(
            `[content] Saving note: slug=${slug}, text="${selectedText.substring(0, 50)}"`,
          );
          chrome.runtime
            .sendMessage({
              action: 'createNote',
              pageSlug: slug,
              url: window.location.href,
              excerpt: [selectedText],
              note: '',
              cssPath: [cssPath],
            })
            .then((resp) => {
              if (
                showUserActionFailureFromResponse(
                  resp,
                  tr('extensionHighlightFailed', 'Highlight failed'),
                  ['noteSlug'],
                )
              ) {
                return;
              }
              const noteSlug = resp?.noteSlug;
              const mark = wrapRangeWithMark(range, selectedText, timestamp);
              if (!mark) {
                throw new Error(
                  'The selected range could not be wrapped after the note committed',
                );
              }
              if (noteSlug) mark.dataset.noteSlug = noteSlug;
              showHighlightEditOverlay(mark, selectedText, noteSlug, '');
            })
            .catch((error) => {
              showExtensionReloadNotification(error);
            });
        }
        sendResponse({ success: true });
      } else {
        // No selection — open global page note
        console.log('[content] No text selected, opening global note');
        const slug = getSlugForCurrentPage();
        if (!slug) {
          sendResponse({ success: false });
          return;
        }
        requestPageNotes(slug)
          .then((notes) => {
            if (!notes) return;
            const globalNote = notes.find((n) => n.excerpt === null);
            showGlobalNoteOverlay(
              globalNote?.note || '',
              globalNote?.slug || null,
              slug,
            );
          })
          .catch((error) => {
            showExtensionReloadNotification(error) ||
              showGlobalNoteOverlay('', null, slug);
          });
        sendResponse({ success: true });
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
