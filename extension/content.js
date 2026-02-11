// Content script for capturing user intent and attention
console.log('Portal content script loaded on:', window.location.href);
let currentInteractionId = null;
let attentionData = {
  scrollDepth: 0,
  timeOnPage: 0,
  highlights: [],
  clicks: 0
};

let startTime = Date.now();
let maxScrollDepth = 0;

// Track scroll depth
window.addEventListener('scroll', () => {
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  const currentScroll = window.scrollY;
  const depth = scrollHeight > 0 ? (currentScroll / scrollHeight) * 100 : 0;
  maxScrollDepth = Math.max(maxScrollDepth, depth);
  attentionData.scrollDepth = maxScrollDepth;
});

// Track clicks
document.addEventListener('click', () => {
  attentionData.clicks++;
});

// Track text selection (highlights)
document.addEventListener('mouseup', () => {
  const selection = window.getSelection();
  const selectedText = selection.toString().trim();

  if (selectedText.length > 10) {
    attentionData.highlights.push({
      text: selectedText,
      timestamp: Date.now(),
      context: getSelectionContext(selection)
    });
  }
});

function getSelectionContext(selection) {
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = container.nodeType === 3 ? container.parentElement : container;

    return {
      tagName: element.tagName,
      className: element.className,
      id: element.id
    };
  }
  return null;
}

// Extract user intent from search queries or input fields
function extractIntent() {
  const intents = [];

  // Check URL for search parameters
  const url = new URL(window.location.href);
  const searchParams = ['q', 'query', 'search', 's', 'term'];

  searchParams.forEach(param => {
    const value = url.searchParams.get(param);
    if (value) {
      intents.push({ type: 'search', value });
    }
  });

  // Check for input fields (search boxes)
  const searchInputs = document.querySelectorAll('input[type="search"], input[name*="search"], input[name*="query"]');
  searchInputs.forEach(input => {
    if (input.value) {
      intents.push({ type: 'input', value: input.value });
    }
  });

  return intents;
}

// Resolve relative url() references within CSS text against a base URL
function resolveCSSUrls(cssText, baseUrl) {
  if (!baseUrl) return cssText;
  return cssText.replace(/url\(\s*(['"]?)(.+?)\1\s*\)/gi, (match, quote, url) => {
    if (url.startsWith('data:') || url.startsWith('#') || url.startsWith('blob:')) return match;
    try {
      return `url(${quote}${new URL(url, baseUrl).href}${quote})`;
    } catch (e) {
      return match;
    }
  });
}

// Recursively serialize a CSSStyleSheet, inlining @import rules
function serializeStylesheet(sheet) {
  try {
    const parts = [];
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSImportRule && rule.styleSheet) {
        const imported = serializeStylesheet(rule.styleSheet);
        if (imported !== null) {
          parts.push(imported);
          continue;
        }
      }
      parts.push(rule.cssText);
    }
    return resolveCSSUrls(parts.join('\n'), sheet.href);
  } catch (e) {
    return null;
  }
}

// Fetch a stylesheet's CSS text (for CORS-blocked sheets). Recursively resolves @import.
async function fetchStylesheet(url, seen) {
  if (!seen) seen = new Set();
  if (seen.has(url)) return '';
  seen.add(url);

  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return null;
    let cssText = await response.text();

    // Recursively resolve @import rules
    const imports = [];
    cssText = cssText.replace(/@import\s+(?:url\(\s*(['"]?)(.+?)\1\s*\)|(['"])(.+?)\3)\s*([^;]*);/gi,
      (match, q1, url1, q2, url2, media) => {
        const importUrl = url1 || url2;
        if (importUrl) {
          try {
            const absUrl = new URL(importUrl, url).href;
            imports.push({ absUrl, media: media.trim(), placeholder: match });
          } catch (e) {}
        }
        return match; // Keep as placeholder, replace after fetching
      });

    for (const imp of imports) {
      const importedCSS = await fetchStylesheet(imp.absUrl, seen);
      if (importedCSS !== null) {
        const wrapped = imp.media ? `@media ${imp.media} {\n${importedCSS}\n}` : importedCSS;
        cssText = cssText.replace(imp.placeholder, wrapped);
      }
    }

    return resolveCSSUrls(cssText, url);
  } catch (e) {
    return null;
  }
}

// Extract HTML snapshot of the page (capped at 2MB)
async function extractHTML() {
  const clone = document.documentElement.cloneNode(true);
  const baseURI = document.baseURI;

  // Remove all scripts — the snapshot is a visual archive, not a functional page
  clone.querySelectorAll('script').forEach(el => el.remove());

  // Remove CSP meta tags that block resource loading when opened locally
  clone.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(el => el.remove());

  // Remove noscript tags
  clone.querySelectorAll('noscript').forEach(el => el.remove());

  // Remove elements that are actually hidden (display:none) in the live DOM.
  // These invisible elements can still extend the layout in the snapshot.
  const liveAll = document.querySelectorAll('body *');
  const cloneAll = clone.querySelectorAll('body *');
  // Build a set of indices of hidden elements from the live DOM
  const hiddenIndices = new Set();
  liveAll.forEach((el, i) => {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        hiddenIndices.add(i);
      }
    } catch (e) {}
  });
  // Remove corresponding elements from clone (iterate in reverse to preserve indices)
  const cloneArray = Array.from(cloneAll);
  for (let i = cloneArray.length - 1; i >= 0; i--) {
    if (hiddenIndices.has(i)) {
      cloneArray[i].remove();
    }
  }

  // Remove common ad/tracking elements
  clone.querySelectorAll(
    'ins.adsbygoogle, [id*="google_ads"], [class*="ad-container"], ' +
    'iframe[src*="ads"], iframe[src*="doubleclick"], ' +
    '[data-ad-slot], [data-ad-client]'
  ).forEach(el => el.remove());

  // Inject safety CSS to prevent layout overflow
  const safetyStyle = document.createElement('style');
  safetyStyle.textContent = [
    'html, body { overflow-x: hidden !important; max-width: 100vw !important; }',
    'img, video, canvas, svg, iframe { max-width: 100% !important; height: auto !important; }',
    'pre, code, table { overflow-x: auto !important; max-width: 100% !important; }',
  ].join('\n');
  const head = clone.querySelector('head');
  if (head) {
    head.insertBefore(safetyStyle, head.firstChild);
  }

  // Inline external stylesheets
  // Strategy: try CSSStyleSheet.cssRules first (same-origin), then fetch() (cross-origin)
  const linkElements = Array.from(clone.querySelectorAll('link[rel="stylesheet"]'));
  for (const link of linkElements) {
    const href = link.getAttribute('href');
    if (!href) continue;

    let absoluteHref;
    try { absoluteHref = new URL(href, baseURI).href; } catch (e) { continue; }

    // 1) Try reading from the live document's CSSOM (fast, same-origin only)
    let cssText = null;
    for (const sheet of document.styleSheets) {
      if (sheet.href === absoluteHref) {
        cssText = serializeStylesheet(sheet);
        break;
      }
    }

    // 2) CORS-blocked — fetch the stylesheet directly
    if (cssText === null) {
      cssText = await fetchStylesheet(absoluteHref);
    }

    if (cssText !== null) {
      const style = document.createElement('style');
      style.textContent = cssText;
      const media = link.getAttribute('media');
      if (media) style.setAttribute('media', media);
      link.replaceWith(style);
    } else {
      // Both failed — keep as absolute <link>
      link.setAttribute('href', absoluteHref);
    }
  }

  // Resolve url() in existing inline <style> elements
  clone.querySelectorAll('style').forEach(style => {
    style.textContent = resolveCSSUrls(style.textContent, baseURI);
  });

  // Rewrite remaining relative URLs to absolute
  clone.querySelectorAll('[href]').forEach(el => {
    const val = el.getAttribute('href');
    if (val && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('javascript:')) {
      try { el.setAttribute('href', new URL(val, baseURI).href); } catch (e) {}
    }
  });
  clone.querySelectorAll('[src]').forEach(el => {
    const val = el.getAttribute('src');
    if (val && !val.startsWith('data:') && !val.startsWith('javascript:')) {
      try { el.setAttribute('src', new URL(val, baseURI).href); } catch (e) {}
    }
  });
  clone.querySelectorAll('[action]').forEach(el => {
    const val = el.getAttribute('action');
    if (val) {
      try { el.setAttribute('action', new URL(val, baseURI).href); } catch (e) {}
    }
  });
  clone.querySelectorAll('[style]').forEach(el => {
    const val = el.getAttribute('style');
    if (val && val.includes('url(')) {
      el.setAttribute('style', resolveCSSUrls(val, baseURI));
    }
  });
  clone.querySelectorAll('[srcset]').forEach(el => {
    const val = el.getAttribute('srcset');
    if (val) {
      const resolved = val.split(',').map(entry => {
        const parts = entry.trim().split(/\s+/);
        if (parts[0]) {
          try { parts[0] = new URL(parts[0], baseURI).href; } catch (e) {}
        }
        return parts.join(' ');
      }).join(', ');
      el.setAttribute('srcset', resolved);
    }
  });

  const html = clone.outerHTML;
  const maxSize = 2 * 1024 * 1024;
  if (html.length > maxSize) {
    return html.substring(0, maxSize);
  }
  return html;
}

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
    const base = (parsed.hostname + parsed.pathname)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
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
function showGlobalNoteOverlay(existingNote) {
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

  const slug = getSlugForCurrentPage();

  // Save note on change (debounced)
  let saveTimeout = null;
  textarea.addEventListener('input', () => {
    autoResize();
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ action: 'loadHighlights', slug });
        const highlights = resp?.highlights || [];
        const h = highlights.find(h => h.isGlobalNote);
        if (h) {
          h.note = textarea.value;
          await chrome.runtime.sendMessage({ action: 'saveHighlights', slug, highlights });
        } else {
          await chrome.runtime.sendMessage({
            action: 'saveHighlight',
            slug,
            highlight: { text: '', note: textarea.value, timestamp: Date.now(), isGlobalNote: true }
          });
        }
      } catch (err) {
        console.error('[content] Failed to save page note:', err);
      }
    }, 500);
  });

  function close() {
    // Save immediately on close if there are pending changes
    clearTimeout(saveTimeout);
    const note = textarea.value;
    if (note !== (existingNote || '')) {
      chrome.runtime.sendMessage({ action: 'loadHighlights', slug }).then(resp => {
        const highlights = resp?.highlights || [];
        const h = highlights.find(h => h.isGlobalNote);
        if (h) {
          h.note = note;
          chrome.runtime.sendMessage({ action: 'saveHighlights', slug, highlights });
        } else {
          chrome.runtime.sendMessage({
            action: 'saveHighlight',
            slug,
            highlight: { text: '', note, timestamp: Date.now(), isGlobalNote: true }
          });
        }
      }).catch(() => {});
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
function highlightTextInPage(text) {
  if (!text) return null;
  console.log(`[content] highlightTextInPage: searching for "${text.substring(0, 50)}" (${text.length} chars)`);

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        // Skip nodes inside our overlay
        if (node.parentElement && node.parentElement.closest('#portal-highlight-overlay')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    const idx = node.textContent.indexOf(text);
    if (idx === -1) continue;

    try {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);

      const mark = document.createElement('mark');
      mark.className = 'portal-highlight';
      mark.style.cssText = 'background: #fff3b0; border-bottom: 2px solid #f0c000; cursor: pointer;';
      mark.dataset.highlightText = text;
      range.surroundContents(mark);
      console.log('[content] highlightTextInPage: successfully wrapped text');
      return mark;
    } catch (e) {
      console.log('[content] highlightTextInPage: surroundContents failed:', e.message);
    }
    break;
  }

  console.log('[content] highlightTextInPage: text not found in any single text node');
  return null;
}

// Re-apply saved highlights on page load
async function reapplyHighlights() {
  const slug = getSlugForCurrentPage();
  if (slug === 'untitled') return;

  try {
    const response = await chrome.runtime.sendMessage({ action: 'loadHighlights', slug });
    if (!response || !response.success || !response.highlights) return;

    for (const highlight of response.highlights) {
      if (!highlight.text) continue;

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
      );

      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.indexOf(highlight.text);
        if (idx === -1) continue;

        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + highlight.text.length);

        const mark = document.createElement('mark');
        mark.className = 'portal-highlight';
        mark.style.cssText = 'background: #fff3b0; border-bottom: 2px solid #f0c000; cursor: pointer;';
        mark.dataset.highlightText = highlight.text;
        mark.dataset.highlightTimestamp = highlight.timestamp || '';

        try {
          range.surroundContents(mark);
        } catch (e) {
          // May fail if text spans nodes
        }
        break;
      }
    }
  } catch (e) {
    // Extension context may not be ready yet
  }
}

// Show note-edit overlay when an existing highlight is clicked
function initHighlightClickHandler() {
  document.addEventListener('click', (e) => {
    const mark = e.target.closest('mark.portal-highlight');
    if (!mark) return;

    // Remove any existing overlay
    const existingOverlay = document.getElementById('portal-highlight-overlay');
    if (existingOverlay) existingOverlay.remove();

    const text = mark.dataset.highlightText || mark.textContent;
    const timestamp = mark.dataset.highlightTimestamp ? parseInt(mark.dataset.highlightTimestamp) : 0;
    const slug = getSlugForCurrentPage();

    // Load existing note for this highlight, then show overlay
    chrome.runtime.sendMessage({ action: 'loadHighlights', slug }).then(resp => {
      const highlights = resp?.highlights || [];
      const match = highlights.find(h => h.text === text);
      showHighlightEditOverlay(mark, text, timestamp, match?.note || '', slug);
    }).catch(() => {
      showHighlightEditOverlay(mark, text, timestamp, '', slug);
    });
  });
}

function showHighlightEditOverlay(mark, text, timestamp, existingNote, slug) {
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
      <button class="delete-btn" title="Delete highlight">
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

  // Save note on change (debounced)
  let saveTimeout = null;
  textarea.addEventListener('input', () => {
    autoResize();
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const resp = await chrome.runtime.sendMessage({ action: 'loadHighlights', slug });
        const highlights = resp?.highlights || [];
        const h = highlights.find(h => h.text === text);
        if (h) {
          h.note = textarea.value;
          await chrome.runtime.sendMessage({ action: 'saveHighlights', slug, highlights });
        }
      } catch (err) {
        console.error('[content] Failed to save highlight note:', err);
      }
    }, 500);
  });

  // Delete highlight
  deleteBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    unwrapHighlightMark(mark);
    chrome.runtime.sendMessage({ action: 'deleteHighlight', slug, text, timestamp });
    host.remove();
  });

  // Close on Escape
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      host.remove();
    }
  });

  // Close on click outside
  const handleOutsideClick = (e) => {
    if (!host.contains(e.target)) {
      host.remove();
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

initHighlightClickHandler();

// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureInteraction') {
    // Only record metadata (intent + attention). Page content snapshots are
    // captured explicitly via Alt+S or the popup capture button.
    currentInteractionId = request.interactionId;
    attentionData.timeOnPage = Date.now() - startTime;

    const intent = extractIntent();
    console.log('[content] captureInteraction: intent only (no snapshot)');

    chrome.runtime.sendMessage({
      action: 'updateInteraction',
      interactionId: currentInteractionId,
      intent: JSON.stringify(intent),
      attention: attentionData
    });

    sendResponse({ success: true });
  } else if (request.action === 'captureCurrentPage') {
    // Capture page content for snapshot (triggered by Alt+S or popup capture button)
    (async () => {
      const markdown = extractMarkdown();
      const html = await extractHTML();
      sendResponse({ success: true, markdown, html });
    })();
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

      // Immediately save the highlight
      console.log(`[content] Saving highlight immediately: slug=${slug}, text="${selectedText.substring(0, 50)}"`);
      chrome.runtime.sendMessage({
        action: 'saveHighlight',
        slug,
        highlight: { text: selectedText, note: '', timestamp, cssPath }
      });

      // Visually highlight the text and show edit overlay
      const mark = highlightTextInPage(selectedText);
      if (mark) {
        mark.dataset.highlightTimestamp = String(timestamp);
        showHighlightEditOverlay(mark, selectedText, timestamp, '', slug);
      }
      sendResponse({ success: true });
    } else {
      // No selection — open global page note
      console.log('[content] No text selected, opening global note');
      const slug = getSlugForCurrentPage();
      chrome.runtime.sendMessage({ action: 'loadHighlights', slug }).then(resp => {
        const highlights = resp?.highlights || [];
        const globalNote = highlights.find(h => h.isGlobalNote);
        showGlobalNoteOverlay(globalNote?.note || '');
      }).catch(() => {
        showGlobalNoteOverlay('');
      });
      sendResponse({ success: true });
    }
  } else if (request.action === 'removeHighlightMark') {
    // Remove a visual highlight mark by matching text
    const marks = document.querySelectorAll('mark.portal-highlight');
    for (const mark of marks) {
      const markText = mark.dataset.highlightText || mark.textContent;
      if (markText === request.text) {
        unwrapHighlightMark(mark);
        break;
      }
    }
    sendResponse({ success: true });
  }

  return true; // Keep channel open for async sendResponse
});

// Re-apply highlights on page load
reapplyHighlights();

// Before unload, send final attention data
window.addEventListener('beforeunload', () => {
  if (currentInteractionId) {
    attentionData.timeOnPage = Date.now() - startTime;

    chrome.runtime.sendMessage({
      action: 'updateInteraction',
      interactionId: currentInteractionId,
      attention: attentionData
    });
  }
});
