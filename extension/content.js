// Content script for capturing user intent and attention (scroll depth, time on page)
console.log('Portal content script loaded on:', window.location.href);

// Private mode: skip all content script functionality
chrome.storage.session.get(['workspace'], (result) => {
  const workspace = result.workspace;
  if (workspace && workspace.mode === 'private') {
    console.log('[content] Private mode — all tracking disabled');
    return;
  }
  initContentScript();
});

function initContentScript() {
let currentInteractionId = null;
let maxScrollDepth = 0;
let startTime = Date.now();
let lastReportTime = Date.now();

// Track scroll depth
window.addEventListener('scroll', () => {
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  const currentScroll = window.scrollY;
  const depth = scrollHeight > 0 ? (currentScroll / scrollHeight) * 100 : 0;
  maxScrollDepth = Math.max(maxScrollDepth, depth);
});

// Extract page content as Markdown
function extractMarkdown() {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NAV', 'HEADER', 'FOOTER', 'NOSCRIPT', 'SVG']);
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
      case 'H1': result += '\n\n# '; processChildren(node); result += '\n\n'; break;
      case 'H2': result += '\n\n## '; processChildren(node); result += '\n\n'; break;
      case 'H3': result += '\n\n### '; processChildren(node); result += '\n\n'; break;
      case 'H4': result += '\n\n#### '; processChildren(node); result += '\n\n'; break;
      case 'H5': result += '\n\n##### '; processChildren(node); result += '\n\n'; break;
      case 'H6': result += '\n\n###### '; processChildren(node); result += '\n\n'; break;

      case 'P': result += '\n\n'; processChildren(node); result += '\n\n'; break;
      case 'BR': result += '\n'; break;
      case 'HR': result += '\n\n---\n\n'; break;

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
          const items = Array.from(parent.children).filter(c => c.tagName === 'LI');
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

// Generate slug from the current page URL (inline version of utils.js generateSlugFromUrl)
function getSlugForCurrentPage() {
  const url = window.location.href;
  try {
    const parsed = new URL(url);
    let domain = parsed.hostname.toLowerCase();
    if (domain.startsWith('www.')) domain = domain.slice(4);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot > 0) domain = domain.slice(0, lastDot);
    const base = (domain + parsed.pathname)
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 30).replace(/-+$/, '');
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
    }
    return `${base}-${Math.abs(hash).toString(36)}`.substring(0, 80);
  } catch (e) {
    return 'untitled';
  }
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
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
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

// Show overlay for global page note (no text selection required)
function showGlobalNoteOverlay(existingNote, existingNoteSlug, pageSlug) {
  const existing = document.getElementById('portal-highlight-overlay');
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = 'portal-highlight-overlay';
  host.style.cssText = 'position: fixed; z-index: 2147483647; top: 50%; left: 50%; transform: translate(-50%, -50%);';

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      .overlay {
        width: 280px;
        background: white;
        border: 1px solid #ddd;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        padding: 8px;
      }
      textarea {
        width: 100%;
        min-height: 28px;
        height: 28px;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 4px 8px;
        font-family: inherit;
        font-size: 12px;
        resize: none;
        box-sizing: border-box;
        line-height: 18px;
        overflow: hidden;
      }
      textarea:focus { outline: none; border-color: #4285f4; }
    </style>
    <div class="overlay">
      <textarea placeholder="Add a page note... Esc to save."></textarea>
    </div>
  `;

  document.body.appendChild(host);

  const textarea = shadow.querySelector('textarea');
  textarea.value = existingNote || '';

  // Auto-resize textarea based on content
  function autoResize() {
    textarea.style.height = '0';
    textarea.style.height = Math.max(28, textarea.scrollHeight) + 'px';
  }
  if (existingNote) autoResize();

  textarea.focus();

  textarea.addEventListener('input', () => { autoResize(); });

  function close() {
    const note = textarea.value;
    if (note !== (existingNote || '')) {
      if (existingNoteSlug) {
        // Update existing note
        chrome.runtime.sendMessage({
          action: 'updateNote',
          noteSlug: existingNoteSlug,
          note
        }).catch(() => {});
      } else {
        // Create new global note (excerpt: null)
        chrome.runtime.sendMessage({
          action: 'createNote',
          pageSlug,
          excerpt: null,
          note,
          cssPath: null
        }).catch(() => {});
      }
    }
    host.remove();
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
    }
  });

  const handleOutsideClick = (e) => {
    if (!host.contains(e.target)) {
      close();
      document.removeEventListener('mousedown', handleOutsideClick);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', handleOutsideClick), 100);
}

// Find text in the page and wrap the first match in a <mark> element.
// Returns the created <mark> element, or null if the text was not found.
// --- Highlight helpers (mirrored in highlight-helpers.js for testing) ---

function wrapRangeWithMark(range, text, timestamp) {
  const mark = document.createElement('mark');
  mark.className = 'portal-highlight';
  mark.style.cssText = 'background: #fff3b0; border-bottom: 2px solid #f0c000; cursor: pointer;';
  mark.dataset.highlightText = text;
  if (timestamp) mark.dataset.highlightTimestamp = String(timestamp);

  if (range.startContainer === range.endContainer) {
    try {
      range.surroundContents(mark);
      if (mark.textContent) return mark;
      unwrapHighlightMark(mark);
      return null;
    } catch (e) { /* fall through */ }
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
          if (node.parentElement && node.parentElement.closest('#portal-highlight-overlay')) return NodeFilter.FILTER_REJECT;
          if (node.parentElement && node.parentElement.closest('mark.portal-highlight')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }
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
  for (const tn of textNodes) { offsets.push(concat.length); concat += tn.textContent; }

  const idx = concat.indexOf(text);
  if (idx === -1) return null;
  const endIdx = idx + text.length;

  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
  for (let i = 0; i < textNodes.length; i++) {
    const nodeStart = offsets[i];
    const nodeEnd = nodeStart + textNodes[i].textContent.length;
    if (!startNode && nodeEnd > idx) { startNode = textNodes[i]; startOffset = idx - nodeStart; }
    if (nodeEnd >= endIdx) { endNode = textNodes[i]; endOffset = endIdx - offsets[i]; break; }
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
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG',
  'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER',
  'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL',
  'TR', 'TH', 'TD', 'SUMMARY'
]);

function isBlockElement(el) {
  return el && el.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(el.tagName);
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
      if (mark) { attachMarkClickHandler(mark); return mark; }
    }
  }
  // Fall back to global search
  return highlightTextInPage(text);
}

// Unwrap all marks sharing a timestamp (for grouped Case 3 highlights)
function unwrapGroupedMarks(timestamp) {
  if (!timestamp) return;
  const tsStr = String(timestamp);
  document.querySelectorAll('mark.portal-highlight').forEach(m => {
    if (m.dataset.highlightTimestamp === tsStr) unwrapHighlightMark(m);
  });
  // Also check shadow DOMs
  document.querySelectorAll('*').forEach(el => {
    if (el.shadowRoot) {
      el.shadowRoot.querySelectorAll('mark.portal-highlight').forEach(m => {
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
    const existingOverlay = document.getElementById('portal-highlight-overlay');
    if (existingOverlay) existingOverlay.remove();

    const noteSlug = mark.dataset.noteSlug;
    const text = mark.dataset.highlightText || mark.textContent;
    const pageSlug = getSlugForCurrentPage();

    if (!noteSlug) {
      showHighlightEditOverlay(mark, text, null, '', pageSlug);
      return;
    }

    chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: pageSlug }).then(resp => {
      if (resp?.success === false) { console.warn('[content] loadPageNotes failed:', resp.error); return; }
      const notes = resp?.notes || [];
      const match = notes.find(n => n.slug === noteSlug);
      const displayText = match ? (Array.isArray(match.excerpt) ? match.excerpt.join(' ') : match.excerpt) : text;
      showHighlightEditOverlay(mark, displayText, noteSlug, match?.note || '', pageSlug);
    }).catch(() => {
      showHighlightEditOverlay(mark, text, noteSlug, '', pageSlug);
    });
  });
}

// Re-apply saved notes on page load
async function reapplyHighlights() {
  const slug = getSlugForCurrentPage();
  if (slug === 'untitled') return;

  try {
    const response = await chrome.runtime.sendMessage({ action: 'loadPageNotes', slug });
    if (!response || !response.success || !response.notes) return;

    for (const note of response.notes) {
      if (note.excerpt === null) continue; // Skip global page notes
      // Normalize to array for Case 3 grouped highlights
      const quotes = Array.isArray(note.excerpt) ? note.excerpt : [note.excerpt];
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

function showHighlightEditOverlay(mark, text, noteSlug, existingNote, pageSlug) {
  const existing = document.getElementById('portal-highlight-overlay');
  if (existing) existing.remove();

  const rect = mark.getBoundingClientRect();

  const host = document.createElement('div');
  host.id = 'portal-highlight-overlay';
  host.style.cssText = 'position: absolute; z-index: 2147483647;';
  host.style.left = (rect.left + window.scrollX) + 'px';
  host.style.top = (rect.bottom + window.scrollY + 4) + 'px';

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      .overlay {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        width: 280px;
        background: white;
        border: 1px solid #ddd;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        padding: 8px;
      }
      .delete-btn {
        flex-shrink: 0;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: none;
        border: 1px solid #ddd;
        border-radius: 4px;
        cursor: pointer;
        color: #888;
        padding: 0;
      }
      .delete-btn:hover {
        background: #fce8e6;
        border-color: #c5221f;
        color: #c5221f;
      }
      .delete-btn svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
      }
      textarea {
        width: 100%;
        min-height: 28px;
        height: 28px;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 4px 8px;
        font-family: inherit;
        font-size: 12px;
        resize: none;
        box-sizing: border-box;
        line-height: 18px;
        overflow: hidden;
      }
      textarea:focus { outline: none; border-color: #4285f4; }
    </style>
    <div class="overlay">
      <button class="delete-btn" title="Delete note">
        <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      </button>
      <div style="flex:1;min-width:0">
        <textarea placeholder="Add a note... Esc to save."></textarea>
      </div>
    </div>
  `;

  document.body.appendChild(host);

  const textarea = shadow.querySelector('textarea');
  const deleteBtn = shadow.querySelector('.delete-btn');

  textarea.value = existingNote;

  // Auto-resize textarea based on content
  function autoResize() {
    textarea.style.height = '28px';
    if (textarea.scrollHeight > 28) {
      textarea.style.height = textarea.scrollHeight + 'px';
    }
  }
  if (existingNote) autoResize();

  textarea.focus();

  textarea.addEventListener('input', () => { autoResize(); });

  function saveAndClose() {
    const note = textarea.value;
    if (note !== existingNote && noteSlug) {
      chrome.runtime.sendMessage({
        action: 'updateNote',
        noteSlug,
        note
      }).catch(() => {});
    }
    host.remove();
  }

  // Delete note
  deleteBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Unwrap mark from DOM
    unwrapHighlightMark(mark);
    if (noteSlug) {
      chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug });
    }
    host.remove();
  });

  // Close on Escape — save and close
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      saveAndClose();
    }
  });

  // Close on click outside — save and close
  const handleOutsideClick = (e) => {
    if (!host.contains(e.target)) {
      saveAndClose();
      document.removeEventListener('mousedown', handleOutsideClick);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', handleOutsideClick), 100);
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
// Unified report(delta) sends partial updates to background's reportPage handler.
// Background trims title, diffs against cache, and logs only changes.

function report(delta) {
  const url = window.location.href;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;
  chrome.runtime.sendMessage({ action: 'reportPage', url, ...delta }).catch(() => {});
}

function reportAttention() {
  const now = Date.now();
  const incrementalTime = now - lastReportTime;
  lastReportTime = now;

  report({
    title: document.title,
    scrollDepth: Math.round(maxScrollDepth),
    timeOnPage: incrementalTime,
    isLeaving: true,
  });
}

// Initial visit report
currentInteractionId = window.location.href;
const initialDelta = {
  title: document.title,
  slug: getSlugForCurrentPage(),
  isInitialLoad: true,
};
const ref = document.referrer;
if (ref) initialDelta.referrer = ref;
report(initialDelta);

// Title changes: report immediately
const titleEl = document.querySelector('title');
if (titleEl) {
  new MutationObserver(() => {
    report({ title: document.title });
  }).observe(titleEl, {
    childList: true, characterData: true, subtree: true
  });
}

// Page leave: visibility hidden / freeze
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    reportAttention();
  }
});

document.addEventListener('freeze', () => {
  reportAttention();
});

// ─── Capture notification bubble ──────────────────────────────────────
function showCaptureNotification() {
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
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 10px 20px;
        border-radius: 8px;
        pointer-events: none;
        opacity: 0;
        animation: fadeInOut 1.6s ease forwards;
      }
      @keyframes fadeInOut {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
        12%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        75%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.96); }
      }
    </style>
    <div class="bubble">Snapshot captured</div>
  `;
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 1700);
}

// ─── Like notification bubble ─────────────────────────────────────────
function showLikeNotification(delta = 1) {
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
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 10px 20px;
        border-radius: 8px;
        pointer-events: none;
        opacity: 0;
        animation: fadeInOut 1.6s ease forwards;
      }
      @keyframes fadeInOut {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
        12%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        75%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.96); }
      }
    </style>
    <div class="bubble">${delta >= 0 ? '\uD83D\uDC4D Liked' : '\uD83D\uDC4E Disliked'}</div>
  `;
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 1700);
}

// ─── Error notification bubble ───────────────────────────────────────
function showErrorNotification(message) {
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
        background: rgba(180, 30, 30, 0.88);
        color: #fff;
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 10px 20px;
        border-radius: 8px;
        pointer-events: none;
        opacity: 0;
        animation: fadeInOut 2.4s ease forwards;
      }
      @keyframes fadeInOut {
        0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
        10%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        80%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.96); }
      }
    </style>
    <div class="bubble">${message}</div>
  `;
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 2500);
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Skip Save Page WE messages (use `type` field, handled by savepage/content.js)
  if (!request.action) return false;

  if (request.action === 'extractMarkdown') {
    // Extract markdown for snapshot (HTML comes from Save Page WE flow)
    const markdown = extractMarkdown();
    sendResponse({ success: true, markdown });
  } else if (request.action === 'highlightSelection') {
    // Highlight selected text or open global note (triggered by Alt+H)
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    console.log(`[content] highlightSelection: selectedText="${selectedText.substring(0, 50)}" (${selectedText.length} chars)`);

    if (selectedText.length > 0 && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const container = range.startContainer;
      const element = container.nodeType === 3 ? container.parentElement : container;
      const cssPath = getCssPath(element);
      const slug = getSlugForCurrentPage();
      const timestamp = Date.now();

      if (isCrossBlock(range)) {
        // Case 3: cross-block selection — split into per-block chunks
        console.log(`[content] Cross-block selection detected, splitting by block`);
        const chunkInfos = splitSelectionByBlock(range);
        if (chunkInfos.length > 0) {
          const texts = chunkInfos.map(c => c.text);
          // Store as array if multiple chunks, string if single
          const storedText = texts.length === 1 ? texts[0] : texts;
          chrome.runtime.sendMessage({
            action: 'createNote',
            pageSlug: slug,
            excerpt: storedText,
            note: '',
            cssPath
          }).then(resp => {
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
              showHighlightEditOverlay(marks[0], texts.join(' '), noteSlug, '', slug);
            }
          });
        }
      } else {
        // Case 1 & 2: same-block selection
        console.log(`[content] Saving note: slug=${slug}, text="${selectedText.substring(0, 50)}"`);
        chrome.runtime.sendMessage({
          action: 'createNote',
          pageSlug: slug,
          excerpt: selectedText,
          note: '',
          cssPath
        }).then(resp => {
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
            showHighlightEditOverlay(mark, selectedText, noteSlug, '', slug);
          }
        });
      }
      sendResponse({ success: true });
    } else {
      // No selection — open global page note
      console.log('[content] No text selected, opening global note');
      const slug = getSlugForCurrentPage();
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug }).then(resp => {
        if (resp?.success === false) { console.warn('[content] loadPageNotes failed:', resp.error); return; }
        const notes = resp?.notes || [];
        const globalNote = notes.find(n => n.excerpt === null);
        showGlobalNoteOverlay(globalNote?.note || '', globalNote?.slug || null, slug);
      }).catch(() => {
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

// Before unload, send final attention report
window.addEventListener('beforeunload', () => {
  reportAttention();
});
} // end initContentScript
