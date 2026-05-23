// Virtual scroller — self-contained class, no deps beyond DOM APIs

export const VIRTUAL_SCROLLER_BUFFER = 250;
export const VIRTUAL_SCROLLER_LOAD_MORE_THRESHOLD = 50;

class FenwickTree {
  constructor(size = 0) {
    this.reset(size);
  }

  reset(size) {
    this.size = Math.max(0, size);
    this.tree = new Array(this.size + 1).fill(0);
  }

  add(index, delta) {
    for (let i = index + 1; i <= this.size; i += i & -i) {
      this.tree[i] += delta;
    }
  }

  sum(count) {
    let total = 0;
    for (let i = Math.min(Math.max(0, count), this.size); i > 0; i -= i & -i) {
      total += this.tree[i];
    }
    return total;
  }
}

export class VirtualScroller {
  constructor(scrollEl, containerEl, rowHeight = 48) {
    this.scrollEl = scrollEl; // scrollable parent (.main or wrapper)
    this.containerEl = containerEl; // container element (#results)
    this.baseRowHeight = rowHeight;
    this.rowHeight = rowHeight; // estimated collapsed row height in px
    this.buffer = VIRTUAL_SCROLLER_BUFFER; // extra rows above/below viewport
    this.loadMoreThreshold = VIRTUAL_SCROLLER_LOAD_MORE_THRESHOLD;
    this.basePaddingBottom =
      parseInt(getComputedStyle(containerEl).paddingBottom) || 0;
    this.data = [];
    this.renderRow = null;
    this._headerHtml = '';
    this.renderedRange = { start: -1, end: -1 };
    this._expandedIdx = -1; // index of currently expanded row
    this._expandedExtraH = 0; // extra height from expansion
    this._savedNodes = new Map(); // detached stateful DOM nodes (selected rows that scrolled out)
    this._selectAllActive = false; // when true, freshly rendered rows get .selected
    this.onLoadMore = null; // callback when user scrolls near end of data
    this._loadMorePending = false;
    this._appendRenderPending = false;
    this._scrollRenderPending = false;
    this._pendingBottomAnchor = null;
    this._heightByKey = new Map();
    this._estimateHeightByKey = new Map();
    this._indexByKey = new Map();
    this._heightDeltaTree = new FenwickTree(0);
    this._estimateCalibrated = false;
    this._topLockFrames = 0;
    this._scrollHandler = () => {
      if (this._scrollRenderPending) return;
      this._scrollRenderPending = true;
      requestAnimationFrame(() => {
        this._scrollRenderPending = false;
        if (this._topLockFrames > 0) {
          this._topLockFrames -= 1;
          this.scrollEl.scrollTop = 0;
        }
        this._render();
      });
    };
    scrollEl.addEventListener('scroll', this._scrollHandler);
    containerEl._virtualScroller = this;
  }

  setData(items, renderRowFn) {
    this._fullData = items;
    this.data = items;
    this.renderRow = renderRowFn;
    this._filterFn = null;
    this.renderedRange = { start: -1, end: -1 };
    this._expandedIdx = -1;
    this._expandedExtraH = 0;
    this._selectAllActive = false;
    this._loadMorePending = false;
    this._appendRenderPending = false;
    this._scrollRenderPending = false;
    this._pendingBottomAnchor = null;
    this._topLockFrames = 0;
    this.rowHeight = this.baseRowHeight;
    this._resetHeightAccounting({ clearMeasured: true });
    this._estimateCalibrated = false;
    this._savedNodes.clear();
    this._render(true);
  }

  updateData(items, renderRowFn, options = {}) {
    const anchor = options.preserveScroll ? this._captureScrollAnchor() : null;
    // Save nodes with meaningful state (selected/expanded) before destroying
    for (const item of this.containerEl.querySelectorAll('.result-item')) {
      this._saveOrDiscard(item);
    }
    this._fullData = items;
    this.data = items;
    if (renderRowFn) this.renderRow = renderRowFn;
    this._filterFn = null;
    this.renderedRange = { start: -1, end: -1 };
    this._expandedIdx = -1;
    this._expandedExtraH = 0;
    this._loadMorePending = false;
    this._appendRenderPending = false;
    this._scrollRenderPending = false;
    this._pendingBottomAnchor = null;
    this._topLockFrames = 0;
    this.rowHeight = this.baseRowHeight;
    this._resetHeightAccounting({ clearMeasured: true });
    this._estimateCalibrated = false;
    // _savedNodes NOT cleared — _render(true) will restore matching nodes
    this._render(true);
    this._restoreScrollAnchor(anchor);
    // Re-detect expanded state from restored nodes
    this.onExpandToggle();
  }

  updateDataAtTop(items, renderRowFn) {
    this.scrollEl.scrollTop = 0;
    this.updateData(items, renderRowFn);
    this._topLockFrames = 2;
    this.scrollEl.scrollTop = 0;
    const lockTop = () => {
      if (this._topLockFrames <= 0) return;
      this._topLockFrames -= 1;
      this.scrollEl.scrollTop = 0;
      if (this.renderedRange.start !== 0) {
        this.renderedRange = { start: -1, end: -1 };
        this._render(true);
      }
      if (this._topLockFrames > 0) requestAnimationFrame(lockTop);
    };
    requestAnimationFrame(lockTop);
  }

  // Filter displayed data without losing the full dataset.
  // Pass null to clear the filter.
  applyFilter(filterFn) {
    this._filterFn = filterFn;
    this.data = filterFn ? this._fullData.filter(filterFn) : this._fullData;
    this.renderedRange = { start: -1, end: -1 };
    this._expandedIdx = -1;
    this._expandedExtraH = 0;
    this._selectAllActive = false;
    this._loadMorePending = false;
    this._appendRenderPending = false;
    this._scrollRenderPending = false;
    this._pendingBottomAnchor = null;
    this._topLockFrames = 0;
    this.rowHeight = this.baseRowHeight;
    this._resetHeightAccounting({ clearMeasured: true });
    this._estimateCalibrated = false;
    this._savedNodes.clear();
    this._render(true);
  }

  // Re-render currently visible rows (e.g. after in-place data mutation like enrichment).
  refreshVisible() {
    if (!this.renderRow || this.data.length === 0) return;
    this.renderedRange = { start: -1, end: -1 };
    this._render(true);
  }

  // Append new items to the dataset (for demand-loading).
  // Updates padding so the scrollbar reflects the new total height.
  appendData(newItems) {
    this._pendingBottomAnchor =
      this._pendingBottomAnchor || this._captureBottomAnchor();
    this._fullData = this._fullData.concat(newItems);
    this.data = this._filterFn
      ? this._fullData.filter(this._filterFn)
      : this._fullData;
    this._rebuildHeightAccounting();
    // Just update padding — _render on next scroll will pick up new rows
    const paddingBottom =
      this._heightBetween(this.renderedRange.end, this.data.length) +
      this.basePaddingBottom;
    this.containerEl.style.paddingBottom = paddingBottom + 'px';
    this.renderedRange = { start: -1, end: -1 };
    if (!this._appendRenderPending) {
      this._appendRenderPending = true;
      requestAnimationFrame(() => {
        this._appendRenderPending = false;
        this._render(false);
      });
    }
  }

  // Remove items by URL without full reload.
  // Preserves scroll position and selection state of remaining rows.
  removeItems(urls) {
    const urlSet = new Set(urls);
    this._fullData = this._fullData.filter((d) => !urlSet.has(d.url));
    this.data = this._filterFn
      ? this._fullData.filter(this._filterFn)
      : this._fullData;
    for (const url of urls) this._savedNodes.delete(url);
    for (const url of urls) this._heightByKey.delete(url);
    for (const url of urls) this._estimateHeightByKey.delete(url);
    this._rebuildHeightAccounting();
    // Remove matching DOM nodes
    for (const item of [...this.containerEl.querySelectorAll('.result-item')]) {
      const row = item.querySelector('.result-row');
      if (row && urlSet.has(row.dataset.url)) item.remove();
    }
    this._expandedIdx = -1;
    this._expandedExtraH = 0;
    // Trigger non-forced rebuild which saves remaining selected nodes before re-rendering
    this.renderedRange = { start: -1, end: -1 };
    this._render(false);
  }

  onExpandToggle() {
    // After expand/collapse, measure actual height difference
    const openDetail = this.containerEl.querySelector('.result-detail.open');
    if (openDetail) {
      const item = openDetail.closest('.result-item');
      if (item) {
        const row = item.querySelector('.result-row');
        if (row) {
          const url = row.dataset.url;
          const idx = this._indexByKey.get(url) ?? -1;
          const collapsedHeight = this._heightByKey.get(url) ?? this.rowHeight;
          const expandedHeight =
            this._measureItemHeight(item) || item.offsetHeight || 0;
          this._expandedIdx = idx;
          this._expandedExtraH = Math.max(0, expandedHeight - collapsedHeight);
        }
      }
    } else {
      this._expandedIdx = -1;
      this._expandedExtraH = 0;
    }
    this._calibrateRowHeight();
    // Only adjust padding-bottom to account for the height change —
    // do NOT re-render, which would destroy the open detail DOM state.
    const { end } = this.renderedRange;
    if (end >= 0) {
      const base =
        this._heightBetween(end, this.data.length) + this.basePaddingBottom;
      this.containerEl.style.paddingBottom = base + 'px';
    }
  }

  selectAll() {
    this._selectAllActive = true;
    for (const row of this.containerEl.querySelectorAll('.result-row')) {
      row.classList.add('selected');
    }
  }

  clearSelection() {
    this._selectAllActive = false;
    for (const row of this.containerEl.querySelectorAll(
      '.result-row.selected',
    )) {
      row.classList.remove('selected');
    }
    this._savedNodes.clear();
  }

  _resetHeightAccounting({ clearMeasured = false } = {}) {
    if (clearMeasured) {
      this._heightByKey.clear();
      this._estimateHeightByKey.clear();
    }
    this._rebuildHeightAccounting();
  }

  _rebuildHeightAccounting() {
    this._indexByKey.clear();
    this._heightDeltaTree.reset(this.data.length);
    for (let i = 0; i < this.data.length; i++) {
      const key = this._keyForIndex(i);
      this._indexByKey.set(key, i);
      const measuredHeight = this._heightByKey.get(key);
      if (measuredHeight == null) continue;
      const delta = measuredHeight - this.rowHeight;
      if (delta === 0) continue;
      this._heightDeltaTree.add(i, delta);
    }
  }

  _totalHeight() {
    return this._heightBetween(0, this.data.length);
  }

  _keyForIndex(i) {
    const item = this.data[i];
    return item?.url || item?.id || `idx:${i}`;
  }

  _heightForIndex(i) {
    const cached = this._heightByKey.get(this._keyForIndex(i));
    const baseHeight = cached ?? this.rowHeight;
    return baseHeight + (i === this._expandedIdx ? this._expandedExtraH : 0);
  }

  _setMeasuredHeight(index, key, height) {
    const previousHeight = this._heightByKey.get(key);
    if (previousHeight === height) return false;

    this._heightByKey.set(key, height);
    const previousDelta =
      previousHeight == null ? 0 : previousHeight - this.rowHeight;
    const nextDelta = height - this.rowHeight;
    if (previousDelta !== nextDelta) {
      const treeIndex = this._indexByKey.get(key) ?? index;
      if (treeIndex >= 0 && treeIndex < this.data.length) {
        this._heightDeltaTree.add(treeIndex, nextDelta - previousDelta);
      }
    }
    return true;
  }

  _heightDeltaBefore(index) {
    return this._heightDeltaTree.sum(index);
  }

  _heightBetween(start, end) {
    const boundedStart = Math.max(0, Math.min(start, this.data.length));
    const boundedEnd = Math.max(boundedStart, Math.min(end, this.data.length));
    let total =
      (boundedEnd - boundedStart) * this.rowHeight +
      this._heightDeltaBefore(boundedEnd) -
      this._heightDeltaBefore(boundedStart);
    if (this._expandedIdx >= boundedStart && this._expandedIdx < boundedEnd) {
      total += this._expandedExtraH;
    }
    return total;
  }

  _offsetForIndex(index) {
    const boundedIndex = Math.max(0, Math.min(index, this.data.length));
    let offset =
      boundedIndex * this.rowHeight + this._heightDeltaBefore(boundedIndex);
    if (this._expandedIdx >= 0 && this._expandedIdx < boundedIndex) {
      offset += this._expandedExtraH;
    }
    return offset;
  }

  _firstVisibleIndex(adjTop) {
    let lo = 0;
    let hi = this.data.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this._offsetForIndex(mid + 1) <= adjTop) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  _firstIndexAtOrAfterOffset(offset) {
    let lo = 0;
    let hi = this.data.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (this._offsetForIndex(mid) < offset) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  _rangeForViewport(adjTop, viewH) {
    const first = this._firstVisibleIndex(adjTop);
    const start = Math.max(0, first - this.buffer);
    const visibleEnd = Math.max(
      first,
      this._firstIndexAtOrAfterOffset(adjTop + viewH),
    );

    return {
      start,
      end: Math.min(this.data.length, visibleEnd + this.buffer),
      visibleEnd,
    };
  }

  _applyPadding(start, end) {
    this.containerEl.style.paddingTop = this._offsetForIndex(start) + 'px';
    let paddingBottom =
      this._heightBetween(end, this.data.length) + this.basePaddingBottom;
    this.containerEl.style.paddingBottom = paddingBottom + 'px';
  }

  _shouldLoadMore(adjTop, viewH) {
    const thresholdPx = this.loadMoreThreshold * this.rowHeight;
    const remainingScrollPx =
      this.scrollEl.scrollHeight -
      this.scrollEl.scrollTop -
      this.scrollEl.clientHeight;
    if (Number.isFinite(remainingScrollPx)) {
      return remainingScrollPx <= thresholdPx;
    }
    const remainingEstimatedPx = this._totalHeight() - (adjTop + viewH);
    return remainingEstimatedPx <= thresholdPx;
  }

  _maybeLoadMore(force, adjTop, viewH) {
    if (
      force ||
      !this.onLoadMore ||
      this._loadMorePending ||
      !this._shouldLoadMore(adjTop, viewH)
    ) {
      return;
    }
    this._loadMorePending = true;
    Promise.resolve(this.onLoadMore()).finally(() => {
      this._loadMorePending = false;
    });
  }

  _maxScrollTop() {
    const scrollHeight = this.scrollEl.scrollHeight;
    const clientHeight = this.scrollEl.clientHeight;
    if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) {
      return null;
    }
    return Math.max(0, scrollHeight - clientHeight);
  }

  _viewportTopOffset() {
    // Use getBoundingClientRect for correct offset regardless of intermediate
    // positioned ancestors (e.g. .section-results-wrapper with position:relative).
    return Math.max(
      0,
      this.scrollEl.getBoundingClientRect().top -
        this.containerEl.getBoundingClientRect().top,
    );
  }

  _captureBottomAnchor() {
    const maxScrollTop = this._maxScrollTop();
    if (maxScrollTop == null) return null;
    if (maxScrollTop <= 4) return null;
    const bottomOffset = maxScrollTop - this.scrollEl.scrollTop;
    if (bottomOffset > 4) return null;
    return { bottomOffset: Math.max(0, bottomOffset) };
  }

  _restoreBottomAnchor(anchor) {
    if (!anchor) return false;
    const maxScrollTop = this._maxScrollTop();
    if (maxScrollTop == null) return false;
    this.scrollEl.scrollTop = Math.max(0, maxScrollTop - anchor.bottomOffset);
    return true;
  }

  _captureScrollAnchor() {
    if (!this.data || this.data.length === 0) return null;
    const scrollTop = this.scrollEl.scrollTop || 0;
    if (scrollTop <= 0) return null;
    const viewportTop = this._viewportTopOffset();
    const firstVisible = this._firstVisibleIndex(viewportTop);
    const key = this._keyForIndex(firstVisible);
    if (!key) return null;
    return {
      key,
      offsetWithin: viewportTop - this._offsetForIndex(firstVisible),
      fallbackTop: scrollTop,
    };
  }

  _restoreScrollAnchor(anchor) {
    if (!anchor) return false;
    const index = this._indexByKey.get(anchor.key);
    const maxScrollTop = this._maxScrollTop();
    if (maxScrollTop != null && maxScrollTop <= 4 && anchor.fallbackTop > 0) {
      this.scrollEl.scrollTop = anchor.fallbackTop;
      return true;
    }
    if (index == null || index < 0) {
      if (maxScrollTop == null) return false;
      this.scrollEl.scrollTop = Math.min(anchor.fallbackTop, maxScrollTop);
      return true;
    }
    const containerScrollOffset =
      (this.scrollEl.scrollTop || 0) - this._viewportTopOffset();
    const target =
      containerScrollOffset + this._offsetForIndex(index) + anchor.offsetWithin;
    this.scrollEl.scrollTop =
      maxScrollTop == null
        ? Math.max(0, target)
        : Math.min(target, maxScrollTop);
    return true;
  }

  _measureItemHeight(item) {
    const rectHeight =
      item.getBoundingClientRect?.().height || item.offsetHeight || 0;
    if (!rectHeight) return 0;
    const style = getComputedStyle(item);
    const marginTop = parseFloat(style.marginTop) || 0;
    const marginBottom = parseFloat(style.marginBottom) || 0;
    return Math.ceil(rectHeight + marginTop + marginBottom);
  }

  _updateEstimatedRowHeight() {
    if (this._estimateCalibrated) return false;
    const heights = [...this._estimateHeightByKey.values()].filter((height) =>
      Number.isFinite(height),
    );
    if (heights.length === 0) return false;
    const average =
      heights.reduce((sum, height) => sum + height, 0) / heights.length;
    const next = Math.max(1, Math.round(average));
    this._estimateCalibrated = true;
    if (Math.abs(next - this.rowHeight) <= 0.5) return false;
    this.rowHeight = next;
    return true;
  }

  _measureRenderedHeights() {
    if (!this.containerEl.querySelectorAll) return 0;
    const items = [...this.containerEl.querySelectorAll('.result-item')];
    let changed = false;
    for (const item of items) {
      const height = this._measureItemHeight(item);
      if (!height) continue;
      const row = item.querySelector?.('.result-row');
      const key = row?.dataset?.url;
      const hasOpenDetail = Boolean(
        item.querySelector?.('.result-detail.open'),
      );
      if (
        key &&
        !hasOpenDetail &&
        this._setMeasuredHeight(this._indexByKey.get(key) ?? -1, key, height)
      ) {
        changed = true;
      }
      if (key && !hasOpenDetail) {
        this._estimateHeightByKey.set(key, height);
      }
    }
    return changed;
  }

  _calibrateRowHeight() {
    const measuredChanged = this._measureRenderedHeights();
    const estimateChanged = this._updateEstimatedRowHeight();
    if (estimateChanged) this._rebuildHeightAccounting();
    return measuredChanged || estimateChanged;
  }

  // Save a DOM node if it has meaningful state (selected or expanded); otherwise discard it.
  _saveOrDiscard(item) {
    const row = item.querySelector('.result-row');
    if (
      row &&
      (row.classList.contains('selected') ||
        item.querySelector('.result-detail.open'))
    ) {
      this._savedNodes.set(row.dataset.url, item);
    }
    item.remove();
  }

  // Insert a row at data index i. Reuses a saved node if one exists for that URL,
  // otherwise creates fresh HTML via renderRow.
  // insertFn(element | null, html | null) handles DOM placement.
  _insertRow(i, insertFn) {
    const url = this.data[i].url;
    if (this._savedNodes.has(url)) {
      insertFn(this._savedNodes.get(url), null);
      this._savedNodes.delete(url);
    } else {
      insertFn(null, this.renderRow(this.data[i], i));
    }
  }

  _render(force = false) {
    if (!this.renderRow || this.data.length === 0) {
      // Only touch DOM on explicit setData/applyFilter calls (force=true).
      // Scroll-triggered calls (force=false) must not overwrite non-scroller
      // content (e.g. recycle bin rows rendered directly into the container).
      if (force) {
        this.containerEl.style.paddingTop = '0px';
        this.containerEl.style.paddingBottom = '0px';
        if (this.data.length === 0)
          this.containerEl.innerHTML = this._headerHtml;
      }
      return;
    }

    const viewH = this.scrollEl.clientHeight;
    const adjTop = this._viewportTopOffset();

    const { start, end } = this._rangeForViewport(adjTop, viewH);

    if (
      !force &&
      start === this.renderedRange.start &&
      end === this.renderedRange.end
    ) {
      this._maybeLoadMore(force, adjTop, viewH);
      return;
    }

    const bottomAnchor =
      this._pendingBottomAnchor || this._captureBottomAnchor();
    this._pendingBottomAnchor = null;

    const { start: oldStart, end: oldEnd } = this.renderedRange;

    this._applyPadding(start, end);

    if (force || oldStart === -1 || start >= oldEnd || end <= oldStart) {
      // Full rebuild: forced (setData/applyFilter), first render, or non-overlapping scroll jump.
      // On non-forced jumps, save selected nodes before destroying.
      if (!force) {
        for (const item of this.containerEl.querySelectorAll('.result-item')) {
          const row = item.querySelector('.result-row');
          if (
            row &&
            (row.classList.contains('selected') ||
              item.querySelector('.result-detail.open'))
          ) {
            this._savedNodes.set(row.dataset.url, item);
          }
        }
      }

      let html = this._headerHtml;
      for (let i = start; i < end; i++) {
        html += this.renderRow(this.data[i], i);
      }
      this.containerEl.innerHTML = html;

      // Restore any saved nodes that fall within the new range
      if (this._savedNodes.size > 0) {
        for (const item of [
          ...this.containerEl.querySelectorAll('.result-item'),
        ]) {
          const row = item.querySelector('.result-row');
          if (row && this._savedNodes.has(row.dataset.url)) {
            item.replaceWith(this._savedNodes.get(row.dataset.url));
            this._savedNodes.delete(row.dataset.url);
          }
        }
      }
    } else {
      // Incremental update: only touch rows entering/leaving the range.
      const items = this.containerEl.querySelectorAll('.result-item');

      // Remove items that left the top
      const removeTop = Math.max(0, start - oldStart);
      for (let i = 0; i < removeTop && i < items.length; i++) {
        this._saveOrDiscard(items[i]);
      }

      // Remove items that left the bottom
      const removeBottom = Math.max(0, oldEnd - end);
      for (let i = 0; i < removeBottom; i++) {
        const idx = items.length - 1 - i;
        if (idx >= removeTop && items[idx].parentNode) {
          this._saveOrDiscard(items[idx]);
        }
      }

      // Add items entering the top (insert before first remaining .result-item)
      const addTopEnd = Math.min(oldStart, end);
      if (start < addTopEnd) {
        const ref = this.containerEl.querySelector('.result-item');
        for (let i = start; i < addTopEnd; i++) {
          this._insertRow(i, (el, html) => {
            if (el) {
              ref ? ref.before(el) : this.containerEl.appendChild(el);
            } else {
              ref
                ? ref.insertAdjacentHTML('beforebegin', html)
                : this.containerEl.insertAdjacentHTML('beforeend', html);
            }
          });
        }
      }

      // Add items entering the bottom
      const addBotStart = Math.max(oldEnd, start);
      for (let i = addBotStart; i < end; i++) {
        this._insertRow(i, (el, html) => {
          if (el) {
            this.containerEl.appendChild(el);
          } else {
            this.containerEl.insertAdjacentHTML('beforeend', html);
          }
        });
      }
    }

    // Clear expanded state if it scrolled out of range
    if (
      this._expandedIdx >= 0 &&
      (this._expandedIdx < start || this._expandedIdx >= end)
    ) {
      this._expandedIdx = -1;
      this._expandedExtraH = 0;
    }

    this.renderedRange = { start, end };

    // Apply select-all to freshly rendered rows
    if (this._selectAllActive) {
      for (const row of this.containerEl.querySelectorAll(
        '.result-row:not(.selected)',
      )) {
        row.classList.add('selected');
      }
    }

    if (this._calibrateRowHeight()) {
      this._applyPadding(start, end);
    }
    this._restoreBottomAnchor(bottomAnchor);

    // Trigger load-more when approaching the end of data
    this._maybeLoadMore(force, adjTop, viewH);
  }
}
