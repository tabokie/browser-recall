// Content script for capturing user intent and attention (scroll depth, time on page)
console.log('Browser Recall content script loaded on:', window.location.href);

const extensionSurface = globalThis.browserRecallExtensionSurface;
const pageIdentity = globalThis.browserRecallPageIdentity;

if (!pageIdentity?.generateSlugFromUrl) {
  throw new Error(
    'Browser Recall page identity helper was not loaded before content.js',
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
  let _highlightReapplyObserver = null;
  let _highlightReapplyRetryTimer = null;
  let _highlightReapplyDeadlineTimer = null;
  let _highlightReapplyRunId = 0;
  let _highlightReapplySlug = null;
  let _highlightReapplyNotesToWatch = [];

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
    try {
      return pageIdentity.generateSlugFromUrl(url);
    } catch (e) {
      return null;
    }
  }

  function isSameDocumentPageUrl(left, right) {
    try {
      const leftUrl = new URL(left);
      const rightUrl = new URL(right);
      return (
        leftUrl.origin === rightUrl.origin &&
        leftUrl.pathname === rightUrl.pathname &&
        leftUrl.search === rightUrl.search
      );
    } catch {
      return left === right;
    }
  }

  function getEmbeddedPageSlug() {
    const meta = document.querySelector('meta[name="x-portal-slug"]');
    return meta?.content || null;
  }

  function getEmbeddedPageUrl() {
    const meta = document.querySelector('meta[name="x-portal-url"]');
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

  function valueParts(value) {
    if (Array.isArray(value)) {
      return value.map((part) => String(part || '')).filter(Boolean);
    }
    return [];
  }

  function cssPathParts(value) {
    if (Array.isArray(value)) {
      return value.map((part) => String(part || ''));
    }
    return [];
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
    const prev = document.getElementById('portal-highlight-overlay');
    if (prev) prev.remove();

    const host = document.createElement('div');
    host.id = 'portal-highlight-overlay';
    host.style.cssText = positionStyle + ' z-index: 2147483647;';

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
    <style>
      ${extensionSurface.shadowCss}
      .overlay {
        width: 300px;
        background: var(--br-bg-base);
        border: 1px solid var(--br-border-section);
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
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mousedown', handleOutsideClick);
      const note = textarea.value;
      host.remove();
      Promise.resolve(onClose(note)).catch((error) => {
        showExtensionReloadNotification(error);
      });
    }
    function dismiss() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mousedown', handleOutsideClick);
      host.remove();
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
        title: 'Page Note',
        placeholder: 'Add a page note... Esc to save.',
      }),
      placeholder: 'Add a page note... Esc to save.',
      existingNote,
      onClose(note) {
        if (note !== (existingNote || '')) {
          if (existingNoteSlug) {
            chrome.runtime
              .sendMessage({
                action: 'updateNote',
                noteSlug: existingNoteSlug,
                note,
              })
              .then((resp) => {
                if (showUserActionFailureFromResponse(resp, 'Update failed')) {
                  return;
                }
                if (resp?.noteSlug) existingNoteSlug = resp.noteSlug;
              })
              .catch((error) => {
                showExtensionReloadNotification(error);
              });
          } else {
            chrome.runtime
              .sendMessage({
                action: 'createNote',
                pageSlug,
                url: window.location.href,
                excerpt: null,
                note,
                cssPath: null,
              })
              .then((resp) => {
                showUserActionFailureFromResponse(resp, 'Create note failed');
              })
              .catch((error) => {
                showExtensionReloadNotification(error);
              });
          }
        }
      },
    });
  }

  // Find text in the page and wrap the first match in a <mark> element.
  // Returns the created <mark> element, or null if the text was not found.
  // --- Highlight helpers (mirrored in highlight-helpers.js for testing) ---

  function wrapRangeWithMark(range, text, timestamp) {
    const mark = document.createElement('mark');
    mark.className = 'portal-highlight';
    mark.style.cssText =
      'background: #fff3b0; border-bottom: 2px solid #f0c000; cursor: pointer;';
    mark.dataset.highlightText = text;
    if (timestamp) mark.dataset.highlightTimestamp = String(timestamp);

    if (range.startContainer === range.endContainer) {
      try {
        range.surroundContents(mark);
        if (mark.textContent) return mark;
        unwrapHighlightMark(mark);
        return null;
      } catch (e) {
        /* fall through */
      }
    }

    try {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
      if (mark.textContent) return mark;
      unwrapHighlightMark(mark);
      return null;
    } catch (e) {
      return null;
    }
  }

  function collectTextNodes(root) {
    const textNodes = [];
    function walk(parent) {
      const walker = document.createTreeWalker(parent, NodeFilter.SHOW_ALL, {
        acceptNode: (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            if (
              node.parentElement &&
              node.parentElement.closest('#portal-highlight-overlay')
            )
              return NodeFilter.FILTER_REJECT;
            if (
              node.parentElement &&
              node.parentElement.closest('mark.portal-highlight')
            )
              return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          textNodes.push(node);
        }
      }
      const elements = parent.querySelectorAll('*');
      for (const el of elements) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    walk(root);
    return textNodes;
  }

  function findTextRange(root, text) {
    if (!text) return null;

    const textNodes = collectTextNodes(root);

    let concat = '';
    const offsets = [];
    for (const tn of textNodes) {
      offsets.push(concat.length);
      concat += tn.textContent;
    }

    const idx = concat.indexOf(text);
    if (idx === -1) return null;
    const endIdx = idx + text.length;

    return rangeFromConcatenatedOffsets(textNodes, offsets, idx, endIdx);
  }

  function findWhitespaceEquivalentTextRange(root, text) {
    if (!text) return null;
    const textNodes = collectTextNodes(root);

    let concat = '';
    const offsets = [];
    for (const tn of textNodes) {
      offsets.push(concat.length);
      concat += tn.textContent;
    }

    const haystack = normalizedTextWithMap(concat);
    const needle = normalizedTextWithMap(text).text;
    if (!needle) return null;
    const normalizedIndex = haystack.text.indexOf(needle);
    if (normalizedIndex === -1) return null;
    const start = haystack.map[normalizedIndex];
    const end = haystack.map[normalizedIndex + needle.length];
    if (start == null || end == null || end <= start) return null;
    return rangeFromConcatenatedOffsets(textNodes, offsets, start, end);
  }

  function normalizedTextWithMap(text) {
    let normalized = '';
    const map = [];
    let inWhitespace = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (/\s/.test(char)) {
        if (!inWhitespace) {
          map.push(index);
          normalized += ' ';
          inWhitespace = true;
        }
        continue;
      }
      map.push(index);
      normalized += char;
      inWhitespace = false;
    }
    map.push(text.length);
    return { text: normalized.trim(), map: trimNormalizedMap(normalized, map) };
  }

  function trimNormalizedMap(normalized, map) {
    let start = 0;
    let end = normalized.length;
    while (start < end && normalized[start] === ' ') start += 1;
    while (end > start && normalized[end - 1] === ' ') end -= 1;
    return map.slice(start, end + 1);
  }

  function rangeFromConcatenatedOffsets(textNodes, offsets, idx, endIdx) {
    let startNode = null,
      startOffset = 0,
      endNode = null,
      endOffset = 0;
    for (let i = 0; i < textNodes.length; i++) {
      const nodeStart = offsets[i];
      const nodeEnd = nodeStart + textNodes[i].textContent.length;
      if (!startNode && nodeEnd > idx) {
        startNode = textNodes[i];
        startOffset = idx - nodeStart;
      }
      if (nodeEnd >= endIdx) {
        endNode = textNodes[i];
        endOffset = endIdx - offsets[i];
        break;
      }
    }
    if (!startNode || !endNode) return null;

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function highlightTextInPage(text) {
    if (!text) return null;

    const range = findTextRange(document.body, text);
    if (!range) return null;

    const mark = wrapRangeWithMark(range, text);
    if (mark) attachMarkClickHandler(mark);
    return mark;
  }

  function highlightTextInScopedRoot(root, text) {
    if (!text) return null;
    const range =
      findTextRange(root, text) ||
      findWhitespaceEquivalentTextRange(root, text);
    if (!range) return null;

    const mark = wrapRangeWithMark(range, text);
    if (mark) attachMarkClickHandler(mark);
    return mark;
  }

  function highlightSavedNoteInPage(note) {
    const excerptParts = Array.isArray(note.excerpt)
      ? valueParts(note.excerpt)
      : [];
    if (excerptParts.length === 0) return [];
    const paths = cssPathParts(note.cssPath);
    const marks = [];
    for (let i = 0; i < excerptParts.length; i++) {
      const text = excerptParts[i];
      const path = paths[i] || '';
      const scopedRoot = path ? resolveCssPath(path) : document.body;
      if (!scopedRoot) continue;
      const mark = highlightTextInScopedRoot(scopedRoot, text);
      if (mark) {
        mark.dataset.highlightText = extensionSurface.formatHighlightExcerpt(
          note.excerpt,
        );
        marks.push(mark);
      }
    }
    return marks;
  }

  function resolveCssPath(path) {
    try {
      return document.querySelector(path);
    } catch {
      return null;
    }
  }

  // --- Case 3: Cross-block helpers (mirrored from highlight-helpers.js) ---

  const BLOCK_TAGS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DD',
    'DETAILS',
    'DIALOG',
    'DIV',
    'DL',
    'DT',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HGROUP',
    'HR',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'UL',
    'TR',
    'TH',
    'TD',
    'SUMMARY',
  ]);

  function isBlockElement(el) {
    return (
      el && el.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(el.tagName)
    );
  }

  function getClosestBlock(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body && !isBlockElement(el)) {
      el = el.parentElement;
    }
    return el || document.body;
  }

  function isCrossBlock(range) {
    if (range.startContainer === range.endContainer) return false;
    const startBlock = getClosestBlock(range.startContainer);
    const endBlock = getClosestBlock(range.endContainer);
    return startBlock !== endBlock;
  }

  function splitSelectionByBlock(range) {
    const ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType === Node.TEXT_NODE) {
      const text = range.toString().trim();
      return text ? [{ text, block: getClosestBlock(ancestor) }] : [];
    }

    const textNodes = [];
    const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node)) {
        textNodes.push(node);
      }
    }
    if (textNodes.length === 0) return [];

    const groups = [];
    let currentBlock = null;
    let currentNodes = [];
    for (const tn of textNodes) {
      const block = getClosestBlock(tn);
      if (block !== currentBlock) {
        if (currentNodes.length > 0) {
          groups.push({ block: currentBlock, nodes: [...currentNodes] });
        }
        currentBlock = block;
        currentNodes = [tn];
      } else {
        currentNodes.push(tn);
      }
    }
    if (currentNodes.length > 0) {
      groups.push({ block: currentBlock, nodes: currentNodes });
    }

    const chunks = [];
    for (const group of groups) {
      let text = '';
      for (const tn of group.nodes) {
        let start = 0;
        let end = tn.textContent.length;
        if (tn === range.startContainer) start = range.startOffset;
        if (tn === range.endContainer) end = range.endOffset;
        text += tn.textContent.substring(start, end);
      }
      const trimmed = text.trim();
      if (trimmed) chunks.push({ text: trimmed, block: group.block });
    }
    return chunks;
  }

  function getStructuredSelectionPayload() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return {
        selectionText: '',
        selectionExcerpt: [],
        selectionCssPath: [],
      };
    }
    const range = selection.getRangeAt(0);
    if (range.collapsed) {
      return {
        selectionText: '',
        selectionExcerpt: [],
        selectionCssPath: [],
      };
    }
    const fallbackText = selection.toString().trim();
    const chunks = splitSelectionByBlock(range);
    if (chunks.length <= 1) {
      const container = range.startContainer;
      const element = getClosestBlock(container);
      return {
        selectionText: fallbackText,
        selectionExcerpt: fallbackText ? [fallbackText] : [],
        selectionCssPath: [element ? getCssPath(element) : ''],
      };
    }
    const texts = chunks.map((chunk) => chunk.text);
    return {
      selectionText: texts.join('\n').trim(),
      selectionExcerpt: texts,
      selectionCssPath: getCssPathsForChunks(chunks),
    };
  }

  // Highlight text scoped to a block element.
  function highlightTextInBlock(block, text, options = {}) {
    if (!text) return null;
    const { globalFallback = true } = options;
    // Try scoped search within the block first
    if (block) {
      const range = findTextRange(block, text);
      if (range) {
        const mark = wrapRangeWithMark(range, text);
        if (mark) {
          attachMarkClickHandler(mark);
          return mark;
        }
      }
    }
    if (!globalFallback) return null;
    // Fall back to global search
    return highlightTextInPage(text);
  }

  // Unwrap all marks sharing a timestamp (for grouped Case 3 highlights)
  function unwrapGroupedMarks(timestamp) {
    if (!timestamp) return;
    const tsStr = String(timestamp);
    document.querySelectorAll('mark.portal-highlight').forEach((m) => {
      if (m.dataset.highlightTimestamp === tsStr) unwrapHighlightMark(m);
    });
    // Also check shadow DOMs
    document.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) {
        el.shadowRoot.querySelectorAll('mark.portal-highlight').forEach((m) => {
          if (m.dataset.highlightTimestamp === tsStr) unwrapHighlightMark(m);
        });
      }
    });
  }

  // Attach click handler directly to a mark (needed for marks inside shadow DOMs
  // where document-level click events retarget to the shadow host).
  function attachMarkClickHandler(mark) {
    mark.addEventListener('click', (e) => {
      e.stopPropagation();
      const existingOverlay = document.getElementById(
        'portal-highlight-overlay',
      );
      if (existingOverlay) existingOverlay.remove();

      const noteSlug = mark.dataset.noteSlug;
      const text = mark.dataset.highlightText || mark.textContent;
      const pageSlug = getSlugForCurrentPage();
      if (!pageSlug) return;

      if (!noteSlug) {
        showHighlightEditOverlay(mark, text, null, '', pageSlug);
        return;
      }

      chrome.runtime
        .sendMessage({ action: 'loadPageNotes', slug: pageSlug })
        .then((resp) => {
          if (
            showUserActionFailureFromResponse(
              resp,
              'Could not load highlight note',
            )
          ) {
            console.warn('[content] loadPageNotes failed:', resp.error);
            return;
          }
          const notes = resp?.notes || [];
          const match = notes.find((n) => n.slug === noteSlug);
          const displayText = match
            ? extensionSurface.formatHighlightExcerpt(match.excerpt)
            : text;
          showHighlightEditOverlay(
            mark,
            displayText,
            noteSlug,
            match?.note || '',
            pageSlug,
          );
        })
        .catch((error) => {
          if (showExtensionReloadNotification(error)) return;
          showHighlightEditOverlay(mark, text, noteSlug, '', pageSlug);
        });
    });
  }

  function countHighlightableExcerptParts(note) {
    return Array.isArray(note?.excerpt) ? valueParts(note.excerpt).length : 0;
  }

  function existingHighlightCountForNote(note) {
    if (!note?.slug) return 0;
    return document.querySelectorAll(
      `mark.portal-highlight[data-note-slug="${cssEscape(note.slug)}"]`,
    ).length;
  }

  function applySavedHighlightNotes(notes) {
    const pending = [];
    for (const note of notes) {
      if (note.excerpt === null) continue;
      const expectedCount = countHighlightableExcerptParts(note);
      if (expectedCount === 0) continue;
      if (existingHighlightCountForNote(note) >= expectedCount) continue;

      const marks = highlightSavedNoteInPage(note);
      for (const mark of marks) {
        if (note.slug) mark.dataset.noteSlug = note.slug;
      }

      if (note.slug && existingHighlightCountForNote(note) < expectedCount) {
        pending.push(note);
      }
    }
    return pending;
  }

  function highlightableNotes(notes) {
    return notes.filter(
      (note) =>
        note.excerpt !== null && countHighlightableExcerptParts(note) > 0,
    );
  }

  function stopHighlightReapplyRetry() {
    if (_highlightReapplyObserver) {
      _highlightReapplyObserver.disconnect();
      _highlightReapplyObserver = null;
    }
    if (_highlightReapplyRetryTimer) {
      clearTimeout(_highlightReapplyRetryTimer);
      _highlightReapplyRetryTimer = null;
    }
    if (_highlightReapplyDeadlineTimer) {
      clearTimeout(_highlightReapplyDeadlineTimer);
      _highlightReapplyDeadlineTimer = null;
    }
    _highlightReapplySlug = null;
    _highlightReapplyNotesToWatch = [];
  }

  function isCurrentHighlightReapply(runId, slug) {
    return _highlightReapplyRunId === runId && getSlugForCurrentPage() === slug;
  }

  function removeWatchedHighlightNote(noteSlug) {
    if (!noteSlug || _highlightReapplyNotesToWatch.length === 0) return;
    _highlightReapplyNotesToWatch = _highlightReapplyNotesToWatch.filter(
      (note) => note.slug !== noteSlug,
    );
    if (_highlightReapplyNotesToWatch.length === 0) {
      stopHighlightReapplyRetry();
    }
  }

  function watchHighlightReapply(notesToWatch, { runId, slug }) {
    stopHighlightReapplyRetry();
    if (!notesToWatch.length || !document.body) return;
    if (!isCurrentHighlightReapply(runId, slug)) return;

    const retryDelayMs = 150;
    const retryWindowMs = 10000;
    _highlightReapplySlug = slug;
    _highlightReapplyNotesToWatch = [...notesToWatch];

    function runRetry() {
      _highlightReapplyRetryTimer = null;
      if (!isCurrentHighlightReapply(runId, _highlightReapplySlug)) {
        stopHighlightReapplyRetry();
        return;
      }
      applySavedHighlightNotes(_highlightReapplyNotesToWatch);
    }

    function scheduleRetry() {
      if (_highlightReapplyRetryTimer) return;
      if (_highlightReapplyNotesToWatch.length === 0) return;
      _highlightReapplyRetryTimer = setTimeout(runRetry, retryDelayMs);
    }

    _highlightReapplyObserver = new MutationObserver(scheduleRetry);
    _highlightReapplyObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    _highlightReapplyDeadlineTimer = setTimeout(
      stopHighlightReapplyRetry,
      retryWindowMs,
    );
    scheduleRetry();
  }

  // Re-apply saved notes on page load
  async function reapplyHighlights({ clearExisting = false } = {}) {
    const runId = _highlightReapplyRunId + 1;
    _highlightReapplyRunId = runId;
    stopHighlightReapplyRetry();
    if (clearExisting) removeAllHighlightMarks();

    const slug = getSlugForCurrentPage();
    if (!slug) return;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'loadPageNotes',
        slug,
      });
      if (!response || !response.success || !response.notes) return;
      if (!isCurrentHighlightReapply(runId, slug)) return;

      const notesToWatch = highlightableNotes(response.notes);
      applySavedHighlightNotes(notesToWatch);
      watchHighlightReapply(notesToWatch, { runId, slug });
    } catch (error) {
      if (!isCurrentHighlightReapply(runId, slug)) return;
      showExtensionReloadNotification(error);
    }
  }

  function showHighlightEditOverlay(
    mark,
    text,
    noteSlug,
    existingNote,
    pageSlug,
  ) {
    const rect = mark.getBoundingClientRect();
    const { host, shadow, textarea, dismiss } = createNoteOverlay({
      positionStyle: 'position: absolute; visibility: hidden;',
      extraCss: `
      .delete-btn { flex-shrink:0; width:30px; height:30px; display:flex; align-items:center; justify-content:center; background:none; border:1px solid var(--br-border-section); border-radius:2px; cursor:pointer; color:var(--br-text-muted); padding:0; }
      .delete-btn:hover { background:var(--br-bg-surface-active); border-color:var(--br-text-primary); color:var(--br-text-primary); }
      .delete-btn svg { width:16px; height:16px; fill:currentColor; }`,
      beforeTextareaHtml: extensionSurface.trashButtonHtml(),
      bodyHtml: extensionSurface.noteOverlayHtml({
        title: 'Highlight Note',
        excerpt: text || '',
        placeholder: 'Add a note... Esc to save.',
        includeDelete: true,
      }),
      placeholder: 'Add a note... Esc to save.',
      existingNote,
      async onClose(note) {
        if (note !== existingNote && noteSlug) {
          try {
            const resp = await chrome.runtime.sendMessage({
              action: 'updateNote',
              noteSlug,
              note,
            });
            if (showUserActionFailureFromResponse(resp, 'Update failed')) {
              return;
            }
            if (resp?.noteSlug) mark.dataset.noteSlug = resp.noteSlug;
          } catch (error) {
            showExtensionReloadNotification(error);
          }
        }
      },
    });
    extensionSurface.positionNearRect(host, rect);
    textarea.focus();

    shadow.querySelector('.delete-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (noteSlug) removeHighlightMarksByNoteSlug(noteSlug);
      else unwrapHighlightMark(mark);
      if (noteSlug)
        chrome.runtime
          .sendMessage({ action: 'deleteNote', noteSlug })
          .catch((error) => {
            showExtensionReloadNotification(error);
          });
      dismiss();
    });
  }

  // Unwrap a <mark> element, restoring the original text node
  function unwrapHighlightMark(mark) {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  }

  function removeAllHighlightMarks() {
    document
      .querySelectorAll('mark.portal-highlight')
      .forEach((mark) => unwrapHighlightMark(mark));
    document.querySelectorAll('*').forEach((el) => {
      if (!el.shadowRoot) return;
      el.shadowRoot
        .querySelectorAll('mark.portal-highlight')
        .forEach((mark) => unwrapHighlightMark(mark));
    });
  }

  function removeHighlightMarksByNoteSlug(noteSlug) {
    removeWatchedHighlightNote(noteSlug);
    const noteSelector = `mark.portal-highlight[data-note-slug="${cssEscape(
      noteSlug,
    )}"]`;
    document
      .querySelectorAll(noteSelector)
      .forEach((mark) => unwrapHighlightMark(mark));
    document.querySelectorAll('*').forEach((el) => {
      if (!el.shadowRoot) return;
      el.shadowRoot
        .querySelectorAll(noteSelector)
        .forEach((mark) => unwrapHighlightMark(mark));
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
    if (isSameDocumentPageUrl(activePageUrl, nextUrl)) return;

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
        border: 1px solid var(--br-border-section);
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
        border: 1px solid var(--br-border-section);
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
    <div class="bubble"><span class="spinner"></span>Capturing…</div>
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
      message: 'Snapshot captured',
      duration: 1.6,
      fadeIn: 12,
      fadeHold: 75,
    });
  }

  function showLikeNotification(delta = 1) {
    showNotificationBubble({
      message: delta >= 0 ? 'Liked' : 'Disliked',
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
      'Browser Recall extension reloaded. Please reload the page and try again.',
    );
    return true;
  }

  function showUserActionFailureFromResponse(resp, fallback) {
    if (resp?.success !== false) return false;
    const message = resp.error || fallback || 'Action failed';
    if (!showExtensionReloadNotification(message)) {
      showErrorNotification(message);
    }
    return true;
  }

  // ─── Highlights Panel (for pages where visual marks can't render) ─────

  function showHighlightsPanel(notes, pageSlug, { hint } = {}) {
    const existing = document.getElementById('portal-highlights-panel');
    if (existing) existing.remove();

    const excerptNotes = notes.filter((n) => n.excerpt !== null);
    if (excerptNotes.length === 0 && !hint) return;

    const host = document.createElement('div');
    host.id = 'portal-highlights-panel';
    host.style.cssText =
      'position: fixed; z-index: 2147483647; top: 16px; right: 16px;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
    <style>
      ${extensionSurface.shadowCss}
      .panel { width: 300px; max-height: 400px; overflow-y: auto; background: var(--br-bg-base); border: 1px solid var(--br-border-section); border-radius: 2px; color: var(--br-text-primary); font-family: var(--br-font-body); font-size: 12px; line-height: 1.45; }
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
        <span>Highlights${excerptNotes.length ? ' (' + excerptNotes.length + ')' : ''}</span>
        <button class="close-btn" title="Close">&times;</button>
      </div>
      ${excerptNotes
        .map((n, index) => {
          const text = extensionSurface.formatHighlightExcerpt(n.excerpt);
          return `<div class="highlight-item" data-note-slug="${n.slug}" data-note-index="${String(index + 1).padStart(2, '0')}">
          <div class="highlight-body">
          <div class="excerpt">${extensionSurface.escapeHtml(text)}</div>
          <div class="note-row">
            <textarea placeholder="Add a note...">${extensionSurface.escapeHtml(n.note || '')}</textarea>
            <button class="delete-btn" title="Delete"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
          </div>
          </div>
        </div>`;
        })
        .join('')}
      ${hint ? `<div class="hint">${extensionSurface.escapeHtml(hint)}</div>` : ''}
    </div>
  `;

    document.body.appendChild(host);

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
              if (showUserActionFailureFromResponse(resp, 'Update failed')) {
                return;
              }
              if (resp?.noteSlug) {
                const oldSlug = noteSlug;
                noteSlug = resp.noteSlug;
                item.dataset.noteSlug = resp.noteSlug;
                // Update matching mark(s) in the page so re-click uses the new slug
                document
                  .querySelectorAll(
                    `mark.portal-highlight[data-note-slug="${oldSlug}"]`,
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
        shadow.querySelector('.panel-header span').textContent =
          `Highlights (${remaining})`;
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
        const container = range.startContainer;
        const element = getClosestBlock(container);
        const cssPath = getCssPath(element);
        const slug = getSlugForCurrentPage();
        if (!slug) {
          sendResponse({ success: false });
          return;
        }
        const timestamp = Date.now();

        const chunkInfos = splitSelectionByBlock(range);
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
              if (showUserActionFailureFromResponse(resp, 'Highlight failed')) {
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
                  slug,
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
              if (showUserActionFailureFromResponse(resp, 'Highlight failed')) {
                return;
              }
              const noteSlug = resp?.noteSlug;
              // Try browser's selection range first, fall back to text search
              let mark = wrapRangeWithMark(range, selectedText, timestamp);
              if (mark) {
                if (noteSlug) mark.dataset.noteSlug = noteSlug;
                attachMarkClickHandler(mark);
              } else {
                mark = highlightTextInPage(selectedText);
                if (mark && noteSlug) mark.dataset.noteSlug = noteSlug;
              }
              if (mark) {
                showHighlightEditOverlay(
                  mark,
                  selectedText,
                  noteSlug,
                  '',
                  slug,
                );
              }
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
        chrome.runtime
          .sendMessage({ action: 'loadPageNotes', slug })
          .then((resp) => {
            if (
              showUserActionFailureFromResponse(
                resp,
                'Could not load page note',
              )
            ) {
              console.warn('[content] loadPageNotes failed:', resp.error);
              return;
            }
            const notes = resp?.notes || [];
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
        const marks = document.querySelectorAll('mark.portal-highlight');
        for (const mark of marks) {
          const markText = mark.dataset.highlightText || mark.textContent;
          if (markText === request.text) {
            unwrapHighlightMark(mark);
            break;
          }
        }
      }
      sendResponse({ success: true });
    } else if (request.action === 'showHighlightsPanel') {
      _panelDismissed = false; // Reset so new highlight shows panel
      showHighlightsPanel(request.notes || [], request.pageSlug);
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
      showErrorNotification(request.message || 'Something went wrong');
      sendResponse({ success: true });
    } else if (request.action === 'showLikeNotification') {
      showLikeNotification(request.delta);
      sendResponse({ success: true });
    }

    return true; // Keep channel open for async sendResponse
  });

  // Re-apply highlights on page load
  reapplyHighlights();

  // On PDF pages, show highlights panel with hint.
  // Delay to let Chrome's PDF viewer finish initializing (it replaces DOM after content script runs).
  // Detect via URL (.pdf extension) OR DOM (Chrome injects <embed type="application/pdf">).
  try {
    setTimeout(() => {
      const isPdf =
        /\.pdf(\?|#|$)/i.test(new URL(window.location.href).pathname) ||
        !!document.querySelector('embed[type="application/pdf"]');
      if (!isPdf) return;
      const pdfSlug = getSlugForCurrentPage();
      let pdfRetryTimer = null;
      function showPdfPanel() {
        chrome.runtime
          .sendMessage({ action: 'loadPageNotes', slug: pdfSlug })
          .then((resp) => {
            if (
              showUserActionFailureFromResponse(
                resp,
                'Could not load highlights',
              )
            ) {
              showHighlightsPanel([], pdfSlug, {
                hint: 'Select text and right-click to highlight',
              });
              return;
            }
            const notes = resp?.notes || [];
            showHighlightsPanel(notes, pdfSlug, {
              hint: 'Select text and right-click to highlight',
            });
          })
          .catch((error) => {
            if (showExtensionReloadNotification(error)) return;
            showHighlightsPanel([], pdfSlug, {
              hint: 'Select text and right-click to highlight',
            });
          });
      }
      showPdfPanel();
      // Re-show if PDF viewer destroys the panel (but not if user dismissed it).
      // Debounce to avoid pile-up from rapid mutations.
      const pdfObserver = new MutationObserver(() => {
        if (
          !document.getElementById('portal-highlights-panel') &&
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
  } catch {}

  // Before unload, send final attention report
  window.addEventListener('beforeunload', () => {
    onLeavePage();
  });
} // end initContentScript
