// Highlight helper functions — shared between content.js (inlined) and tests (imported).
// content.js cannot import modules, so these are duplicated there.

const MARK_STYLE =
  'background: #fff3b0; border-bottom: 2px solid #f0c000; cursor: pointer;';

/**
 * Create a <mark> wrapping a DOM Range.
 * - Single text node: uses surroundContents (clean, preserves DOM).
 * - Cross-inline nodes within same block: uses extractContents + insertNode.
 * Returns the <mark> element, or null on failure.
 */
export function wrapRangeWithMark(range, text, timestamp) {
  const doc =
    range.startContainer?.ownerDocument ||
    range.commonAncestorContainer?.ownerDocument ||
    document;
  const mark = doc.createElement('mark');
  mark.className = 'portal-highlight';
  mark.style.cssText = MARK_STYLE;
  mark.dataset.highlightText = text;
  if (timestamp) mark.dataset.highlightTimestamp = String(timestamp);

  // Fast path: range within a single node
  if (range.startContainer === range.endContainer) {
    try {
      range.surroundContents(mark);
      if (mark.textContent) return mark;
      // Empty mark — undo
      unwrapMark(mark);
      return null;
    } catch (e) {
      /* fall through to extractContents */
    }
  }

  // Cross-node path: extract content, wrap in mark, re-insert
  try {
    const fragment = range.extractContents();
    mark.appendChild(fragment);
    range.insertNode(mark);
    if (mark.textContent) return mark;
    // Empty mark — undo
    unwrapMark(mark);
    return null;
  } catch (e) {
    return null;
  }
}

function unwrapMark(mark) {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize();
}

/**
 * Collect all text nodes under a root, traversing into open shadow DOMs.
 * Skips nodes inside overlay or existing highlights.
 */
function collectTextNodes(root, ownerDoc) {
  const textNodes = [];
  const doc = ownerDoc || document;
  function walk(parent) {
    const walker = doc.createTreeWalker(parent, NodeFilter.SHOW_ALL, {
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
        // For element nodes, check for shadow root to descend into
        return NodeFilter.FILTER_SKIP;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        textNodes.push(node);
      }
    }
    // Also descend into shadow roots
    const elements = parent.querySelectorAll('*');
    for (const el of elements) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }
  walk(root);
  return textNodes;
}

/**
 * Search the full document text (across node boundaries and shadow DOMs)
 * for a substring. Returns a DOM Range spanning the first match, or null.
 */
export function findTextRange(root, text, ownerDoc) {
  if (!text) return null;
  const doc = ownerDoc || document;

  const textNodes = collectTextNodes(root, doc);

  let concat = '';
  const offsets = [];
  for (const tn of textNodes) {
    offsets.push(concat.length);
    concat += tn.textContent;
  }

  const idx = concat.indexOf(text);
  if (idx === -1) return null;
  const endIdx = idx + text.length;

  return rangeFromConcatenatedOffsets(textNodes, offsets, idx, endIdx, doc);
}

function findWhitespaceEquivalentTextRange(root, text, ownerDoc) {
  if (!text) return null;
  const doc = ownerDoc || document;
  const textNodes = collectTextNodes(root, doc);
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
  return rangeFromConcatenatedOffsets(textNodes, offsets, start, end, doc);
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

function rangeFromConcatenatedOffsets(textNodes, offsets, idx, endIdx, doc) {
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

  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/**
 * Highlight a text string in the DOM by finding it and wrapping in <mark>.
 * Works for single-node and cross-inline-node text within the same block.
 * Returns the <mark> element, or null if text not found or spans blocks.
 */
export function highlightTextInPage(root, text) {
  if (!text) return null;

  const range = findTextRange(root, text);
  if (!range) return null;

  return wrapRangeWithMark(range, text);
}

function highlightTextInPageScoped(root, text) {
  const exact = highlightTextInPage(root, text);
  if (exact) return exact;
  const range = findWhitespaceEquivalentTextRange(root, text);
  if (!range) return null;
  return wrapRangeWithMark(range, text);
}

export function highlightSavedExcerptPartsInPage(
  root,
  excerpts,
  cssPaths = [],
) {
  if (!Array.isArray(excerpts) || excerpts.length === 0) return [];
  const doc = root.ownerDocument || document;
  const marks = [];
  for (let index = 0; index < excerpts.length; index += 1) {
    const text = String(excerpts[index] || '');
    if (!text) continue;
    const path = Array.isArray(cssPaths) ? cssPaths[index] : null;
    const scopedRoot =
      typeof path === 'string' && path ? resolveCssPath(doc, path) : root;
    if (!scopedRoot) continue;
    const mark = highlightTextInPageScoped(scopedRoot, text);
    if (mark) {
      mark.dataset.highlightText = excerpts.join('\n');
      marks.push(mark);
    }
  }
  return marks;
}

function resolveCssPath(doc, path) {
  try {
    return doc.querySelector(path);
  } catch {
    return null;
  }
}

// --- Case 3: Cross-block helpers ---

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

export function isBlockElement(el) {
  return el && el.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(el.tagName);
}

/**
 * Find the nearest block-level ancestor of a node.
 * Returns document.body if no block ancestor found.
 */
export function getClosestBlock(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body && !isBlockElement(el)) {
    el = el.parentElement;
  }
  return el || document.body;
}

/**
 * Check if a Range spans multiple block-level elements.
 */
export function isCrossBlock(range) {
  if (range.startContainer === range.endContainer) return false;
  const startBlock = getClosestBlock(range.startContainer);
  const endBlock = getClosestBlock(range.endContainer);
  return startBlock !== endBlock;
}

/**
 * Split a cross-block Range into per-block text chunks.
 * Returns an array of { text: string, block: Element } — one per block.
 * Each text is trimmed; empty chunks are excluded.
 */
export function splitSelectionByBlock(range) {
  const ancestor = range.commonAncestorContainer;

  // Single text node — one chunk
  if (ancestor.nodeType === Node.TEXT_NODE) {
    const text = range.toString().trim();
    return text ? [{ text, block: getClosestBlock(ancestor) }] : [];
  }

  // Collect text nodes within the range
  const textNodes = [];
  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (range.intersectsNode(node)) {
      textNodes.push(node);
    }
  }

  if (textNodes.length === 0) return [];

  // Group text nodes by their closest block ancestor
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

  // Extract text for each group, respecting range start/end boundaries
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
