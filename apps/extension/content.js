// Content script for capturing user intent and attention (scroll depth, time on page)
console.log('Browser Recall content script loaded on:', window.location.href);

const SCHEME_PALETTES = {
  amber: {
    accent: '#D07030',
    bgBase: '#FFF8F0',
    borderSubtle: 'rgba(180,160,140,0.15)',
    borderSection: 'rgba(180,160,140,0.1)',
    shadowColor: '53,40,32',
    textPrimary: '#352820',
    textSecondary: '#5E4D3E',
    textMuted: '#8E7D6D',
    excerptBg: '#fff8dc',
    excerptBorder: '#f0c040',
  },
  mono: {
    accent: '#1A1A1A',
    bgBase: '#FFFFFF',
    borderSubtle: 'rgba(0,0,0,0.08)',
    borderSection: 'rgba(0,0,0,0.06)',
    shadowColor: '0,0,0',
    textPrimary: '#1A1A1A',
    textSecondary: '#555555',
    textMuted: '#999999',
    excerptBg: '#F8F8F8',
    excerptBorder: '#1A1A1A',
  },
  rose: {
    accent: '#D84070',
    bgBase: '#FFECE8',
    borderSubtle: 'rgba(180,138,140,0.18)',
    borderSection: 'rgba(180,138,140,0.12)',
    shadowColor: '58,30,34',
    textPrimary: '#3C1C20',
    textSecondary: '#64303A',
    textMuted: '#905862',
    excerptBg: '#FAE0DC',
    excerptBorder: '#E86898',
  },
};
let palette = SCHEME_PALETTES.amber;

// Recording paused: skip all content script functionality.
chrome.storage.session.get(['workspace', 'colorScheme'], (result) => {
  const recordingState = result.workspace;
  if (result.colorScheme && SCHEME_PALETTES[result.colorScheme])
    palette = SCHEME_PALETTES[result.colorScheme];
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
    try {
      const parsed = new URL(url);
      let domain = parsed.hostname.toLowerCase();
      if (domain.startsWith('www.')) domain = domain.slice(4);
      const lastDot = domain.lastIndexOf('.');
      if (lastDot > 0) domain = domain.slice(0, lastDot);
      const base = (domain + parsed.pathname)
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 30)
        .replace(/-+$/, '');
      let hash = 0;
      for (let i = 0; i < url.length; i++) {
        hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
      }
      return `${base}-${Math.abs(hash).toString(36)}`.substring(0, 80);
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
        selector += '#' + el.id;
        parts.unshift(selector);
        break;
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

  // ─── Note overlay factory ────────────────────────────────────────────
  function createNoteOverlay({
    positionStyle,
    extraCss,
    beforeTextareaHtml,
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
      .overlay {
        width: 280px;
        background: ${palette.bgBase};
        border: 1px solid ${palette.borderSubtle};
        border-radius: 10px;
        box-shadow: 0 1px 2px rgba(${palette.shadowColor},0.04), 0 4px 12px rgba(${palette.shadowColor},0.08);
        font-family: 'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        padding: 8px;
      }
      textarea {
        width: 100%;
        min-height: 28px;
        height: 28px;
        border: 1px solid ${palette.borderSubtle};
        border-radius: 6px;
        padding: 4px 8px;
        font-family: inherit;
        font-size: 12px;
        resize: none;
        box-sizing: border-box;
        line-height: 18px;
        overflow: hidden;
      }
      textarea:focus { outline: none; border-color: ${palette.accent}; }
      ${extraCss || ''}
    </style>
    <div class="overlay">
      ${beforeTextareaHtml || ''}
      <textarea placeholder="${placeholder}"></textarea>
    </div>
  `;

    document.body.appendChild(host);

    const textarea = shadow.querySelector('textarea');
    textarea.value = existingNote || '';

    function autoResize() {
      textarea.style.height = '0';
      textarea.style.height = Math.max(28, textarea.scrollHeight) + 'px';
    }
    if (existingNote) autoResize();

    textarea.focus();
    textarea.addEventListener('input', autoResize);

    let closed = false;
    async function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('mousedown', handleOutsideClick);
      await onClose(textarea.value);
      host.remove();
    }
    function dismiss() {
      if (closed) return;
      closed = true;
      document.removeEventListener('mousedown', handleOutsideClick);
      host.remove();
    }

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    const handleOutsideClick = (e) => {
      if (!host.contains(e.target)) close();
    };
    setTimeout(
      () => document.addEventListener('mousedown', handleOutsideClick),
      100,
    );

    return { host, shadow, textarea, close, dismiss };
  }

  // Show overlay for global page note (no text selection required)
  function showGlobalNoteOverlay(existingNote, existingNoteSlug, pageSlug) {
    createNoteOverlay({
      positionStyle:
        'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);',
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
                if (resp?.noteSlug) existingNoteSlug = resp.noteSlug;
              })
              .catch(() => {});
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
              .catch(() => {});
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

  // Highlight text scoped to a block element, falling back to global search
  function highlightTextInBlock(block, text) {
    if (!text) return null;
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
          if (resp?.success === false) {
            console.warn('[content] loadPageNotes failed:', resp.error);
            return;
          }
          const notes = resp?.notes || [];
          const match = notes.find((n) => n.slug === noteSlug);
          const displayText = match
            ? Array.isArray(match.excerpt)
              ? match.excerpt.join(' ')
              : match.excerpt
            : text;
          showHighlightEditOverlay(
            mark,
            displayText,
            noteSlug,
            match?.note || '',
            pageSlug,
          );
        })
        .catch(() => {
          showHighlightEditOverlay(mark, text, noteSlug, '', pageSlug);
        });
    });
  }

  // Re-apply saved notes on page load
  async function reapplyHighlights() {
    const slug = getSlugForCurrentPage();
    if (!slug) return;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'loadPageNotes',
        slug,
      });
      if (!response || !response.success || !response.notes) return;

      for (const note of response.notes) {
        if (note.excerpt === null) continue; // Skip global page notes
        // Normalize to array for Case 3 grouped highlights
        const quotes = Array.isArray(note.excerpt)
          ? note.excerpt
          : [note.excerpt];
        for (const text of quotes) {
          const mark = highlightTextInPage(text);
          if (mark && note.slug) {
            mark.dataset.noteSlug = note.slug;
          }
        }
      }
    } catch (e) {
      // Extension context may not be ready yet
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
    const { shadow, dismiss } = createNoteOverlay({
      positionStyle: `position: absolute; left: ${rect.left + window.scrollX}px; top: ${rect.bottom + window.scrollY + 4}px;`,
      extraCss: `.overlay { display: flex; align-items: flex-start; gap: 8px; }
      .delete-btn { flex-shrink:0; width:28px; height:28px; display:flex; align-items:center; justify-content:center; background:none; border:1px solid ${palette.borderSubtle}; border-radius:6px; cursor:pointer; color:${palette.textMuted}; padding:0; }
      .delete-btn:hover { background:rgba(184,80,64,0.1); border-color:#B85040; color:#B85040; }
      .delete-btn svg { width:16px; height:16px; fill:currentColor; }
      textarea { width:auto; flex:1; min-width:0; }`,
      beforeTextareaHtml: `<button class="delete-btn" title="Delete note"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>`,
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
            if (resp?.noteSlug) mark.dataset.noteSlug = resp.noteSlug;
          } catch {}
        }
      },
    });

    shadow.querySelector('.delete-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      unwrapHighlightMark(mark);
      if (noteSlug)
        chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug });
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
      .catch(() => {});
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
    reapplyHighlights();
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
    background,
    duration,
    fadeIn,
    fadeHold,
  }) {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
    <style>
      .bubble {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.92);
        z-index: 2147483647;
        background: ${background};
        color: #fff;
        font: 14px/1.4 'Nunito', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 10px 20px;
        border-radius: 8px;
        pointer-events: none;
        opacity: 0;
        animation: fadeInOut ${duration}s ease forwards;
      }
      @keyframes fadeInOut {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
        ${fadeIn}%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        ${fadeHold}%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.96); }
      }
    </style>
    <div class="bubble">${message}</div>
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
      .bubble {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) scale(0.92);
        z-index: 2147483647;
        background: rgba(0, 0, 0, 0.78);
        color: #fff;
        font: 14px/1.4 'Nunito', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 10px 20px;
        border-radius: 8px;
        pointer-events: none;
        display: flex;
        align-items: center;
        gap: 8px;
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
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: #fff;
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
      background: 'rgba(0, 0, 0, 0.78)',
      duration: 1.6,
      fadeIn: 12,
      fadeHold: 75,
    });
  }

  function showLikeNotification(delta = 1) {
    showNotificationBubble({
      message: delta >= 0 ? '\uD83D\uDC4D Liked' : '\uD83D\uDC4E Disliked',
      background: 'rgba(0, 0, 0, 0.78)',
      duration: 1.6,
      fadeIn: 12,
      fadeHold: 75,
    });
  }

  function showErrorNotification(message) {
    showNotificationBubble({
      message,
      background: 'rgba(180, 30, 30, 0.88)',
      duration: 2.4,
      fadeIn: 10,
      fadeHold: 80,
    });
  }

  // ─── Highlights Panel (for pages where visual marks can't render) ─────

  function showHighlightsPanel(notes, pageSlug, { hint } = {}) {
    const existing = document.getElementById('portal-highlights-panel');
    if (existing) existing.remove();

    const excerptNotes = notes.filter((n) => n.excerpt !== null);
    if (excerptNotes.length === 0 && !hint) return;

    const esc = (s) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const host = document.createElement('div');
    host.id = 'portal-highlights-panel';
    host.style.cssText =
      'position: fixed; z-index: 2147483647; top: 16px; right: 16px;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
    <style>
      .panel { width: 300px; max-height: 400px; overflow-y: auto; background: ${palette.bgBase}; border: 1px solid ${palette.borderSubtle}; border-radius: 10px; box-shadow: 0 1px 2px rgba(${palette.shadowColor},0.04), 0 4px 16px rgba(${palette.shadowColor},0.1); font-family: 'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 13px; }
      .panel-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid ${palette.borderSubtle}; font-weight: 600; font-size: 12px; color: ${palette.textSecondary}; cursor: move; user-select: none; }
      .close-btn { background: none; border: none; cursor: pointer; color: ${palette.textMuted}; font-size: 16px; padding: 0 4px; line-height: 1; }
      .close-btn:hover { color: ${palette.textPrimary}; }
      .highlight-item { padding: 8px 12px; border-bottom: 1px solid ${palette.borderSection}; }
      .highlight-item:last-child { border-bottom: none; }
      .excerpt { font-size: 12px; color: ${palette.textPrimary}; background: ${palette.excerptBg}; padding: 4px 6px; border-radius: 6px; border-left: 3px solid ${palette.excerptBorder}; margin-bottom: 4px; line-height: 1.4; word-break: break-word; }
      .note-row { display: flex; align-items: flex-start; gap: 4px; }
      textarea { flex: 1; min-height: 24px; height: 24px; border: 1px solid ${palette.borderSubtle}; border-radius: 6px; padding: 3px 6px; font-family: inherit; font-size: 11px; resize: none; box-sizing: border-box; line-height: 16px; overflow: hidden; }
      textarea:focus { outline: none; border-color: ${palette.accent}; }
      .delete-btn { flex-shrink: 0; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; background: none; border: 1px solid transparent; border-radius: 6px; cursor: pointer; color: ${palette.textMuted}; padding: 0; }
      .delete-btn:hover { background: rgba(184, 80, 64, 0.1); color: #B85040; border-color: #B85040; }
      .delete-btn svg { width: 14px; height: 14px; fill: currentColor; }
      .hint { padding: 8px 12px; font-size: 11px; color: ${palette.textMuted}; line-height: 1.4; }
    </style>
    <div class="panel">
      <div class="panel-header">
        <span>Highlights${excerptNotes.length ? ' (' + excerptNotes.length + ')' : ''}</span>
        <button class="close-btn" title="Close">&times;</button>
      </div>
      ${excerptNotes
        .map((n) => {
          const text = Array.isArray(n.excerpt)
            ? n.excerpt.join(' ')
            : n.excerpt;
          return `<div class="highlight-item" data-note-slug="${n.slug}">
          <div class="excerpt">${esc(text)}</div>
          <div class="note-row">
            <textarea placeholder="Add a note...">${esc(n.note || '')}</textarea>
            <button class="delete-btn" title="Delete"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
          </div>
        </div>`;
        })
        .join('')}
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
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
            .catch(() => {});
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') ta.blur();
      });
      item.querySelector('.delete-btn').addEventListener('click', () => {
        chrome.runtime
          .sendMessage({ action: 'deleteNote', noteSlug })
          .catch(() => {});
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
        const element =
          container.nodeType === 3 ? container.parentElement : container;
        const cssPath = getCssPath(element);
        const slug = getSlugForCurrentPage();
        if (!slug) {
          sendResponse({ success: false });
          return;
        }
        const timestamp = Date.now();

        if (isCrossBlock(range)) {
          // Case 3: cross-block selection — split into per-block chunks
          console.log(
            `[content] Cross-block selection detected, splitting by block`,
          );
          const chunkInfos = splitSelectionByBlock(range);
          if (chunkInfos.length > 0) {
            const texts = chunkInfos.map((c) => c.text);
            // Store as array if multiple chunks, string if single
            const storedText = texts.length === 1 ? texts[0] : texts;
            chrome.runtime
              .sendMessage({
                action: 'createNote',
                pageSlug: slug,
                url: window.location.href,
                excerpt: storedText,
                note: '',
                cssPath,
              })
              .then((resp) => {
                const noteSlug = resp?.noteSlug;
                // Highlight each chunk scoped to its block element
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
                    texts.join(' '),
                    noteSlug,
                    '',
                    slug,
                  );
                }
              });
          }
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
              excerpt: selectedText,
              note: '',
              cssPath,
            })
            .then((resp) => {
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
            if (resp?.success === false) {
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
          .catch(() => {
            showGlobalNoteOverlay('', null, slug);
          });
        sendResponse({ success: true });
      }
    } else if (request.action === 'removeHighlightMark') {
      // Remove visual highlight marks — by timestamp for grouped highlights, by text for singles
      if (request.timestamp) {
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
            if (resp?.success === false) {
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
          .catch(() => {
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
