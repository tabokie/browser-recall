export function createHighlightLifecycle(options) {
  const {
    document: doc,
    MutationObserver: Observer = doc?.defaultView?.MutationObserver,
    setTimeout: schedule = globalThis.setTimeout.bind(globalThis),
    clearTimeout: cancel = globalThis.clearTimeout.bind(globalThis),
    getCurrentIdentity = null,
    loadNotes = null,
    onLoadError = () => {},
    onMark = () => {},
    formatExcerpt = (parts) => parts.join('\n'),
    getCssPath = () => '',
    reapplyDisabled = () => false,
    retryDelayMs = 150,
    retryWindowMs = 10000,
  } = options || {};

  if (!doc?.createRange || !doc?.createTreeWalker) {
    throw new Error('Highlight lifecycle requires a DOM document');
  }

  const NodeType = doc.defaultView?.Node || globalThis.Node;
  const NodeFilterType = doc.defaultView?.NodeFilter || globalThis.NodeFilter;
  const markSelector = 'mark.browser-recall-highlight';
  const excludedSelector =
    '#browser-recall-highlight-overlay, #browser-recall-highlights-panel, mark.browser-recall-highlight';
  const excludedHostIds = new Set([
    'browser-recall-highlight-overlay',
    'browser-recall-highlights-panel',
  ]);
  const blockTags = new Set([
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

  let observer = null;
  let retryTimer = null;
  let deadlineTimer = null;
  let runId = 0;
  let watchedIdentity = null;
  let watchedNotes = [];

  function cssEscape(value) {
    if (doc.defaultView?.CSS?.escape) return doc.defaultView.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => {
      return `\\${character.codePointAt(0).toString(16)} `;
    });
  }

  function allMarks(selector = markSelector) {
    const marks = [...doc.querySelectorAll(selector)];
    doc.querySelectorAll('*').forEach((element) => {
      if (excludedHostIds.has(element.id)) return;
      if (element.shadowRoot) {
        marks.push(...element.shadowRoot.querySelectorAll(selector));
      }
    });
    return marks;
  }

  function unwrapMark(mark) {
    const parent = mark?.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  function collectTextNodes(root) {
    const textNodes = [];
    function walk(parent) {
      if (!parent || excludedHostIds.has(parent.host?.id)) return;
      const walker = doc.createTreeWalker(parent, NodeFilterType.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement?.closest(excludedSelector)
            ? NodeFilterType.FILTER_REJECT
            : NodeFilterType.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);
      parent.querySelectorAll?.('*').forEach((element) => {
        if (!excludedHostIds.has(element.id) && element.shadowRoot) {
          walk(element.shadowRoot);
        }
      });
    }
    walk(root);
    return textNodes;
  }

  function buildTextIndex(root) {
    const textNodes = collectTextNodes(root);
    const offsets = [];
    let text = '';
    for (const textNode of textNodes) {
      offsets.push(text.length);
      text += textNode.textContent;
    }
    return { text, textNodes, offsets };
  }

  function rangeFromOffsets(textNodes, offsets, startIndex, endIndex) {
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    for (let index = 0; index < textNodes.length; index += 1) {
      const nodeStart = offsets[index];
      const nodeEnd = nodeStart + textNodes[index].textContent.length;
      if (!startNode && nodeEnd > startIndex) {
        startNode = textNodes[index];
        startOffset = startIndex - nodeStart;
      }
      if (nodeEnd >= endIndex) {
        endNode = textNodes[index];
        endOffset = endIndex - nodeStart;
        break;
      }
    }
    if (!startNode || !endNode) return null;
    const range = doc.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function normalizedTextWithMap(text) {
    let normalized = '';
    const map = [];
    let inWhitespace = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (/\s/.test(character)) {
        if (!inWhitespace) {
          map.push(index);
          normalized += ' ';
          inWhitespace = true;
        }
        continue;
      }
      map.push(index);
      normalized += character;
      inWhitespace = false;
    }
    map.push(text.length);
    let start = 0;
    let end = normalized.length;
    while (start < end && normalized[start] === ' ') start += 1;
    while (end > start && normalized[end - 1] === ' ') end -= 1;
    return {
      text: normalized.slice(start, end),
      map: map.slice(start, end + 1),
    };
  }

  function findTextRange(root, text, { whitespaceEquivalent = false } = {}) {
    if (!root || !text) return null;
    const index = buildTextIndex(root);
    if (!whitespaceEquivalent) {
      const start = index.text.indexOf(text);
      return start < 0
        ? null
        : rangeFromOffsets(
            index.textNodes,
            index.offsets,
            start,
            start + text.length,
          );
    }
    const haystack = normalizedTextWithMap(index.text);
    const needle = normalizedTextWithMap(text).text;
    if (!needle) return null;
    const normalizedStart = haystack.text.indexOf(needle);
    if (normalizedStart < 0) return null;
    const start = haystack.map[normalizedStart];
    const end = haystack.map[normalizedStart + needle.length];
    if (start == null || end == null || end <= start) return null;
    return rangeFromOffsets(index.textNodes, index.offsets, start, end);
  }

  function markRange(range, text, { timestamp, noteSlug } = {}) {
    if (!range || !text) return null;
    const mark = doc.createElement('mark');
    mark.className = 'browser-recall-highlight';
    mark.style.cssText =
      'background: #fff3b0; border-bottom: 2px solid #f0c000; cursor: pointer;';
    mark.dataset.highlightText = text;
    if (timestamp) mark.dataset.highlightTimestamp = String(timestamp);
    if (noteSlug) mark.dataset.noteSlug = noteSlug;

    if (range.startContainer === range.endContainer) {
      try {
        range.surroundContents(mark);
        if (mark.textContent) {
          onMark(mark);
          return mark;
        }
        unwrapMark(mark);
        return null;
      } catch {
        // Continue with extract/insert for ranges that split inline elements.
      }
    }

    try {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
      if (!mark.textContent) {
        unwrapMark(mark);
        return null;
      }
      onMark(mark);
      return mark;
    } catch {
      return null;
    }
  }

  function markText(
    text,
    { root = doc.body, globalFallback = false, timestamp, noteSlug } = {},
  ) {
    if (!text) return null;
    const exact = findTextRange(root, text);
    const equivalent = exact
      ? null
      : findTextRange(root, text, { whitespaceEquivalent: true });
    const range = exact || equivalent;
    if (range) return markRange(range, text, { timestamp, noteSlug });
    if (globalFallback && root !== doc.body) {
      return markText(text, { root: doc.body, timestamp, noteSlug });
    }
    return null;
  }

  function resolvePath(path, root) {
    if (!path) return root;
    try {
      return doc.querySelector(path);
    } catch {
      return null;
    }
  }

  function excerptParts(note) {
    if (!Array.isArray(note?.excerpt)) return [];
    return note.excerpt.map((part) => String(part || '')).filter(Boolean);
  }

  function markSavedNote(note, root = doc.body) {
    const excerpts = excerptParts(note);
    if (excerpts.length === 0) return [];
    const paths = Array.isArray(note.cssPath)
      ? note.cssPath.map((path) => String(path || ''))
      : [];
    const marks = [];
    for (let index = 0; index < excerpts.length; index += 1) {
      const scopedRoot = resolvePath(paths[index] || '', root);
      if (!scopedRoot) continue;
      const mark = markText(excerpts[index], {
        root: scopedRoot,
        noteSlug: note.slug,
      });
      if (!mark) continue;
      mark.dataset.highlightText = formatExcerpt(note.excerpt);
      marks.push(mark);
    }
    return marks;
  }

  function countMarksForNote(noteSlug) {
    if (!noteSlug) return 0;
    return allMarks(`${markSelector}[data-note-slug="${cssEscape(noteSlug)}"]`)
      .length;
  }

  function applySavedNotes(notes, root = doc.body) {
    const pending = [];
    for (const note of Array.isArray(notes) ? notes : []) {
      const expectedCount = excerptParts(note).length;
      if (expectedCount === 0) continue;
      if (note.slug && countMarksForNote(note.slug) >= expectedCount) continue;
      markSavedNote(note, root);
      if (note.slug && countMarksForNote(note.slug) < expectedCount) {
        pending.push(note);
      }
    }
    return pending;
  }

  function closestBlock(node) {
    let element =
      node?.nodeType === NodeType.TEXT_NODE ? node.parentElement : node;
    while (
      element &&
      element !== doc.body &&
      !(
        element.nodeType === NodeType.ELEMENT_NODE &&
        blockTags.has(element.tagName)
      )
    ) {
      element = element.parentElement;
    }
    return element || doc.body;
  }

  function selectionChunks(range) {
    if (!range) return [];
    const ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType === NodeType.TEXT_NODE) {
      const text = range.toString().trim();
      return text ? [{ text, block: closestBlock(ancestor) }] : [];
    }
    const textNodes = [];
    const walker = doc.createTreeWalker(ancestor, NodeFilterType.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node)) textNodes.push(node);
    }
    const groups = [];
    for (const textNode of textNodes) {
      const block = closestBlock(textNode);
      const previous = groups.at(-1);
      if (previous?.block === block) previous.nodes.push(textNode);
      else groups.push({ block, nodes: [textNode] });
    }
    return groups.flatMap(({ block, nodes }) => {
      let text = '';
      for (const textNode of nodes) {
        const start = textNode === range.startContainer ? range.startOffset : 0;
        const end =
          textNode === range.endContainer
            ? range.endOffset
            : textNode.textContent.length;
        text += textNode.textContent.substring(start, end);
      }
      const trimmed = text.trim();
      return trimmed ? [{ text: trimmed, block }] : [];
    });
  }

  function selectionPayload(selection) {
    if (!selection || selection.rangeCount === 0) {
      return { selectionText: '', selectionExcerpt: [], selectionCssPath: [] };
    }
    const range = selection.getRangeAt(0);
    if (range.collapsed) {
      return { selectionText: '', selectionExcerpt: [], selectionCssPath: [] };
    }
    const fallbackText = selection.toString().trim();
    const chunks = selectionChunks(range);
    if (chunks.length <= 1) {
      const block = closestBlock(range.startContainer);
      return {
        selectionText: fallbackText,
        selectionExcerpt: fallbackText ? [fallbackText] : [],
        selectionCssPath: [block ? getCssPath(block) : ''],
      };
    }
    const excerpts = chunks.map((chunk) => chunk.text);
    return {
      selectionText: excerpts.join('\n').trim(),
      selectionExcerpt: excerpts,
      selectionCssPath: chunks.map((chunk) => getCssPath(chunk.block)),
    };
  }

  function describeSelection(selection) {
    const payload = selectionPayload(selection);
    const range = selection?.rangeCount > 0 ? selection.getRangeAt(0) : null;
    return {
      ...payload,
      chunks: range && !range.collapsed ? selectionChunks(range) : [],
    };
  }

  function stopRetry() {
    observer?.disconnect();
    observer = null;
    if (retryTimer) cancel(retryTimer);
    if (deadlineTimer) cancel(deadlineTimer);
    retryTimer = null;
    deadlineTimer = null;
    watchedIdentity = null;
    watchedNotes = [];
  }

  function isCurrent(expectedRunId, identity) {
    return (
      runId === expectedRunId &&
      (!getCurrentIdentity || getCurrentIdentity() === identity)
    );
  }

  function watchNotes(notes, expectedRunId, identity) {
    stopRetry();
    if (!notes.length || !doc.body || !Observer) return;
    if (!isCurrent(expectedRunId, identity)) return;
    watchedIdentity = identity;
    watchedNotes = [...notes];

    function runRetry() {
      retryTimer = null;
      if (!isCurrent(expectedRunId, watchedIdentity)) {
        stopRetry();
        return;
      }
      applySavedNotes(watchedNotes);
    }

    function scheduleRetry() {
      if (retryTimer || watchedNotes.length === 0) return;
      retryTimer = schedule(runRetry, retryDelayMs);
    }

    observer = new Observer(scheduleRetry);
    observer.observe(doc.body, { childList: true, subtree: true });
    deadlineTimer = schedule(stopRetry, retryWindowMs);
    scheduleRetry();
  }

  async function reapply({ clearExisting = false } = {}) {
    const expectedRunId = runId + 1;
    runId = expectedRunId;
    stopRetry();
    if (clearExisting) clearMarks();
    if (reapplyDisabled()) return;
    if (!getCurrentIdentity || !loadNotes) {
      throw new Error('Highlight reapply requires identity and note loaders');
    }
    const identity = getCurrentIdentity();
    if (!identity) return;
    try {
      const notes = await loadNotes(identity);
      if (!Array.isArray(notes) || !isCurrent(expectedRunId, identity)) return;
      const highlightableNotes = notes.filter(
        (note) => excerptParts(note).length > 0,
      );
      applySavedNotes(highlightableNotes);
      watchNotes(highlightableNotes, expectedRunId, identity);
    } catch (error) {
      if (isCurrent(expectedRunId, identity)) onLoadError(error);
    }
  }

  function clearMarks() {
    allMarks().forEach(unwrapMark);
  }

  function removeByNoteSlug(noteSlug) {
    if (!noteSlug) return;
    watchedNotes = watchedNotes.filter((note) => note.slug !== noteSlug);
    if (watchedNotes.length === 0) stopRetry();
    allMarks(
      `${markSelector}[data-note-slug="${cssEscape(noteSlug)}"]`,
    ).forEach(unwrapMark);
  }

  function removeGrouped(timestamp) {
    if (!timestamp) return;
    const value = String(timestamp);
    allMarks().forEach((mark) => {
      if (mark.dataset.highlightTimestamp === value) unwrapMark(mark);
    });
  }

  function replaceNoteSlug(previousSlug, nextSlug) {
    if (!previousSlug || !nextSlug || previousSlug === nextSlug) return;
    watchedNotes = watchedNotes.map((note) =>
      note.slug === previousSlug ? { ...note, slug: nextSlug } : note,
    );
    allMarks(
      `${markSelector}[data-note-slug="${cssEscape(previousSlug)}"]`,
    ).forEach((mark) => {
      mark.dataset.noteSlug = nextSlug;
    });
  }

  function removeFirstByText(text) {
    const mark = allMarks().find(
      (candidate) =>
        (candidate.dataset.highlightText || candidate.textContent) === text,
    );
    if (mark) unwrapMark(mark);
  }

  function dispose({ clearExisting = false } = {}) {
    runId += 1;
    stopRetry();
    if (clearExisting) clearMarks();
  }

  function remove({ all = false, mark, noteSlug, timestamp, text } = {}) {
    if (all) clearMarks();
    else if (mark) unwrapMark(mark);
    else if (noteSlug) removeByNoteSlug(noteSlug);
    else if (timestamp) removeGrouped(timestamp);
    else if (text) removeFirstByText(text);
  }

  return Object.freeze({
    applySaved: applySavedNotes,
    createMark: markRange,
    describeSelection,
    dispose,
    findAndMark: markText,
    reapply,
    remove,
    replaceNote: replaceNoteSlug,
  });
}

export function createHighlightLifecycleGlobalScript() {
  return `// Generated from packages/core/highlight-lifecycle.js by scripts/stage-app-assets.mjs.
(function installBrowserRecallHighlightLifecycle() {
  const createHighlightLifecycle = ${createHighlightLifecycle.toString()};
  globalThis.browserRecallHighlightLifecycle = Object.freeze({
    create: createHighlightLifecycle,
  });
})();
`;
}
