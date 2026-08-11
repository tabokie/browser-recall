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
    reapplyDisabled = () => false,
    retryDelayMs = 150,
    retryWindowMs = 10000,
  } = options || {};

  if (!doc?.createRange || !doc?.createTreeWalker) {
    throw new Error('Highlight lifecycle requires a DOM document');
  }

  const NodeType = doc.defaultView?.Node || globalThis.Node;
  const NodeFilterType = doc.defaultView?.NodeFilter || globalThis.NodeFilter;
  const textAnchorV1Prefix = 'browser-recall-text-anchor:v1:';
  const textAnchorV2Prefix = 'browser-recall-text-anchor:v2:';
  const markSelector = 'mark.browser-recall-highlight';
  const uiExcludedSelector =
    '#browser-recall-highlight-overlay, #browser-recall-highlights-panel';
  const excludedSelector = `${uiExcludedSelector}, ${markSelector}`;
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

  function selectorPathWithinRoot(element, root) {
    if (!element || element.nodeType !== NodeType.ELEMENT_NODE) {
      throw new Error('Highlight selection scope must be an element');
    }
    if (root === doc && element === doc.body) return 'body';

    const parts = [];
    let current = element;
    while (current && !(root === doc && current === doc.body)) {
      let selector = current.tagName.toLowerCase();
      const idSelector = current.id
        ? `${selector}#${cssEscape(current.id)}`
        : null;
      if (idSelector && root.querySelectorAll(idSelector).length === 1) {
        selector = idSelector;
        parts.unshift(selector);
        current = null;
        break;
      }
      const parent = current.parentElement;
      const siblingContainer = parent || current.getRootNode();
      if (siblingContainer !== root && !parent) {
        throw new Error(
          'Highlight selection scope is outside the document tree',
        );
      }
      const sameTagSiblings = [...siblingContainer.children].filter(
        (candidate) => candidate.tagName === current.tagName,
      );
      if (sameTagSiblings.length > 1) {
        selector += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
      }
      parts.unshift(selector);
      current = parent;
    }
    if (root === doc && current === doc.body) parts.unshift('body');

    const path = parts.join(' > ');
    if (!path || root.querySelector(path) !== element) {
      throw new Error('Could not derive a stable highlight selection scope');
    }
    return path;
  }

  function composedSelectorsForElement(element) {
    const selectors = [];
    let current = element;
    while (current) {
      const root = current.getRootNode();
      selectors.unshift(selectorPathWithinRoot(current, root));
      if (root === doc) return selectors;
      if (!root?.host || root.host.shadowRoot !== root) {
        throw new Error(
          'Highlight selection scope is inside an inaccessible shadow root',
        );
      }
      current = root.host;
    }
    throw new Error('Highlight selection scope is outside the document tree');
  }

  function allMarks(selector = markSelector) {
    const marks = [];
    function collect(root) {
      marks.push(...root.querySelectorAll(selector));
      root.querySelectorAll('*').forEach((element) => {
        if (!excludedHostIds.has(element.id) && element.shadowRoot) {
          collect(element.shadowRoot);
        }
      });
    }
    collect(doc);
    return marks;
  }

  function unwrapMark(mark) {
    const parent = mark?.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  function collectTextNodes(root, { includeOwnedMarks = false } = {}) {
    const textNodes = [];
    const selector = includeOwnedMarks ? uiExcludedSelector : excludedSelector;
    function walk(parent) {
      if (!parent || excludedHostIds.has(parent.host?.id)) return;
      const walker = doc.createTreeWalker(parent, NodeFilterType.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement?.closest(selector)
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

  function buildTextIndex(root, options) {
    const textNodes = collectTextNodes(root, options);
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
    } catch (error) {
      throw new Error('Could not wrap the saved highlight range', {
        cause: error,
      });
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
    return doc.querySelector(path);
  }

  function serializeTextAnchor(selectors, start, end) {
    if (selectors.length === 1) {
      return `${textAnchorV1Prefix}${JSON.stringify({ selector: selectors[0], start, end })}`;
    }
    return `${textAnchorV2Prefix}${JSON.stringify({ selectors, start, end })}`;
  }

  function parseTextAnchor(value) {
    const isV1 = value.startsWith(textAnchorV1Prefix);
    const isV2 = value.startsWith(textAnchorV2Prefix);
    if (!isV1 && !isV2) {
      return { kind: 'legacy-selector', selector: value };
    }

    const prefix = isV1 ? textAnchorV1Prefix : textAnchorV2Prefix;
    const serialized = value.slice(prefix.length);
    let anchor;
    try {
      anchor = JSON.parse(serialized);
    } catch {
      throw new Error('Saved highlight text anchor is malformed');
    }
    if (
      !anchor ||
      typeof anchor !== 'object' ||
      Array.isArray(anchor) ||
      Object.keys(anchor).join(',') !==
        (isV1 ? 'selector,start,end' : 'selectors,start,end') ||
      (isV1
        ? typeof anchor.selector !== 'string' || !anchor.selector
        : !Array.isArray(anchor.selectors) ||
          anchor.selectors.length < 2 ||
          !anchor.selectors.every(
            (selector) => typeof selector === 'string' && selector,
          )) ||
      !Number.isSafeInteger(anchor.start) ||
      anchor.start < 0 ||
      !Number.isSafeInteger(anchor.end) ||
      anchor.end <= anchor.start ||
      JSON.stringify(anchor) !== serialized
    ) {
      throw new Error('Saved highlight text anchor is malformed');
    }
    return {
      kind: 'text-anchor',
      selectors: isV1 ? [anchor.selector] : anchor.selectors,
      start: anchor.start,
      end: anchor.end,
    };
  }

  function resolveTextAnchorScope(anchor) {
    let root = doc;
    for (let index = 0; index < anchor.selectors.length; index += 1) {
      const element = root.querySelector(anchor.selectors[index]);
      if (!element) return null;
      if (index === anchor.selectors.length - 1) return element;
      root = element.shadowRoot;
      if (!root) return null;
    }
    return null;
  }

  function textAnchorRange(root, text, anchor) {
    const index = buildTextIndex(root, { includeOwnedMarks: true });
    if (
      anchor.end > index.text.length ||
      index.text.slice(anchor.start, anchor.end) !== text
    ) {
      return null;
    }
    const range = rangeFromOffsets(
      index.textNodes,
      index.offsets,
      anchor.start,
      anchor.end,
    );
    if (!range || selectionIntersectsExistingMark(range)) return null;
    return range;
  }

  function offsetsForRange(root, range, text) {
    const index = buildTextIndex(root, { includeOwnedMarks: true });
    const startNodeIndex = index.textNodes.indexOf(range.startContainer);
    const endNodeIndex = index.textNodes.indexOf(range.endContainer);
    if (startNodeIndex < 0 || endNodeIndex < 0) {
      throw new Error('Highlight selection is outside its block text index');
    }
    const start = index.offsets[startNodeIndex] + range.startOffset;
    const end = index.offsets[endNodeIndex] + range.endOffset;
    if (end <= start || index.text.slice(start, end) !== text) {
      throw new Error('Highlight selection offsets do not match selected text');
    }
    return { start, end };
  }

  function excerptParts(note) {
    if (!Array.isArray(note?.excerpt) || note.excerpt.length === 0) {
      throw new Error('Saved note excerpt must be a string array');
    }
    if (!note.excerpt.every((part) => typeof part === 'string' && part)) {
      throw new Error('Saved note excerpt must contain non-empty strings');
    }
    return note.excerpt;
  }

  function markSavedNote(note, root = doc.body) {
    const excerpts = excerptParts(note);
    if (
      !Array.isArray(note.cssPath) ||
      note.cssPath.length !== excerpts.length ||
      !note.cssPath.every((path) => typeof path === 'string')
    ) {
      throw new Error(
        'Saved highlight cssPath must be a string array aligned with excerpt',
      );
    }
    const paths = note.cssPath;
    const marks = [];
    for (let index = 0; index < excerpts.length; index += 1) {
      const anchor = parseTextAnchor(paths[index]);
      const scopedRoot =
        anchor.kind === 'text-anchor'
          ? resolveTextAnchorScope(anchor)
          : resolvePath(anchor.selector, root);
      if (!scopedRoot) continue;
      const range =
        anchor.kind === 'text-anchor'
          ? textAnchorRange(scopedRoot, excerpts[index], anchor)
          : null;
      const mark =
        anchor.kind === 'text-anchor'
          ? range &&
            markRange(range, excerpts[index], {
              noteSlug: note.slug,
            })
          : markText(excerpts[index], {
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

  function selectedTextNodes(range) {
    const ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType === NodeType.TEXT_NODE) return [ancestor];
    const textNodes = [];
    const walker = doc.createTreeWalker(ancestor, NodeFilterType.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node)) textNodes.push(node);
    }
    return textNodes;
  }

  function pointWithinSegments(segments, position) {
    let consumed = 0;
    for (const segment of segments) {
      const length = segment.end - segment.start;
      if (position <= consumed + length) {
        return {
          node: segment.node,
          offset: segment.start + position - consumed,
        };
      }
      consumed += length;
    }
    const last = segments.at(-1);
    return last ? { node: last.node, offset: last.end } : null;
  }

  function selectionChunk(range, block, nodes) {
    const segments = nodes.flatMap((node) => {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end =
        node === range.endContainer ? range.endOffset : node.textContent.length;
      return end > start ? [{ node, start, end }] : [];
    });
    const rawText = segments
      .map(({ node, start, end }) => node.textContent.slice(start, end))
      .join('');
    const leadingWhitespace = rawText.length - rawText.trimStart().length;
    const trailingBoundary = rawText.trimEnd().length;
    if (trailingBoundary <= leadingWhitespace) return null;
    const start = pointWithinSegments(segments, leadingWhitespace);
    const end = pointWithinSegments(segments, trailingBoundary);
    if (!start || !end) return null;
    const chunkRange = doc.createRange();
    chunkRange.setStart(start.node, start.offset);
    chunkRange.setEnd(end.node, end.offset);
    return {
      text: rawText.slice(leadingWhitespace, trailingBoundary),
      block,
      range: chunkRange,
    };
  }

  function selectionChunks(range) {
    if (!range) return [];
    const textNodes = selectedTextNodes(range);
    const groups = [];
    for (const textNode of textNodes) {
      const block = closestBlock(textNode);
      const previous = groups.at(-1);
      if (previous?.block === block) previous.nodes.push(textNode);
      else groups.push({ block, nodes: [textNode] });
    }
    return groups.flatMap(({ block, nodes }) => {
      const chunk = selectionChunk(range, block, nodes);
      return chunk ? [chunk] : [];
    });
  }

  function selectionIntersectsExistingMark(range) {
    return allMarks().some((mark) => {
      try {
        return range.intersectsNode(mark);
      } catch {
        return false;
      }
    });
  }

  function prepareSelection(selection) {
    if (!selection || selection.rangeCount === 0) return null;
    const sourceRange = selection.getRangeAt(0);
    if (sourceRange.collapsed || !selection.toString().trim()) return null;
    if (selectionIntersectsExistingMark(sourceRange)) {
      const error = new Error(
        'Selected text is already highlighted by Browser Recall',
      );
      error.code = 'selection_intersects_existing_highlight';
      throw error;
    }

    const chunks = selectionChunks(sourceRange);
    if (chunks.length === 0) {
      throw new Error('Selected text could not be mapped to document text');
    }
    const excerpt = Object.freeze(chunks.map((chunk) => chunk.text));
    const cssPath = Object.freeze(
      chunks.map((chunk) => {
        const selectors = composedSelectorsForElement(chunk.block);
        const { start, end } = offsetsForRange(
          chunk.block,
          chunk.range,
          chunk.text,
        );
        return serializeTextAnchor(selectors, start, end);
      }),
    );
    let applied = false;

    return Object.freeze({
      text: excerpt.join('\n').trim(),
      excerpt,
      cssPath,
      apply({ timestamp, noteSlug } = {}) {
        if (applied) {
          throw new Error('Prepared highlight selection was already applied');
        }
        applied = true;
        const marks = new Array(chunks.length);
        for (let index = chunks.length - 1; index >= 0; index -= 1) {
          marks[index] = markRange(chunks[index].range, chunks[index].text, {
            timestamp,
            noteSlug,
          });
        }
        return marks.filter(Boolean);
      },
    });
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
    dispose,
    prepareSelection,
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
