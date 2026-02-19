// Virtual scroller — self-contained class, no deps beyond DOM APIs

export class VirtualScroller {
  constructor(scrollEl, containerEl, rowHeight = 48) {
    this.scrollEl = scrollEl;       // scrollable parent (.main or wrapper)
    this.containerEl = containerEl; // container element (#results)
    this.rowHeight = rowHeight;     // collapsed row height in px
    this.buffer = 20;               // extra rows above/below viewport
    this.basePaddingBottom = parseInt(getComputedStyle(containerEl).paddingBottom) || 0;
    this.data = [];
    this.renderRow = null;
    this._headerHtml = '';
    this.renderedRange = { start: -1, end: -1 };
    this._expandedIdx = -1;         // index of currently expanded row
    this._expandedExtraH = 0;       // extra height from expansion
    this._savedNodes = new Map();   // detached stateful DOM nodes (selected rows that scrolled out)
    this.onLoadMore = null;         // callback when user scrolls near end of data
    this._scrollHandler = () => requestAnimationFrame(() => this._render());
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
    this._savedNodes.clear();
    this._render(true);
  }

  updateData(items, renderRowFn) {
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
    // _savedNodes NOT cleared — _render(true) will restore matching nodes
    this._render(true);
    // Re-detect expanded state from restored nodes
    this.onExpandToggle();
  }

  // Filter displayed data without losing the full dataset.
  // Pass null to clear the filter.
  applyFilter(filterFn) {
    this._filterFn = filterFn;
    this.data = filterFn ? this._fullData.filter(filterFn) : this._fullData;
    this.renderedRange = { start: -1, end: -1 };
    this._expandedIdx = -1;
    this._expandedExtraH = 0;
    this._savedNodes.clear();
    this._render(true);
  }

  // Append new items to the dataset (for demand-loading).
  // Updates padding so the scrollbar reflects the new total height.
  appendData(newItems) {
    this._fullData = this._fullData.concat(newItems);
    this.data = this._filterFn ? this._fullData.filter(this._filterFn) : this._fullData;
    // Just update padding — _render on next scroll will pick up new rows
    const paddingBottom = (this.data.length - this.renderedRange.end) * this.rowHeight + this.basePaddingBottom;
    this.containerEl.style.paddingBottom = paddingBottom + 'px';
  }

  // Remove items by URL without full reload.
  // Preserves scroll position and selection state of remaining rows.
  removeItems(urls) {
    const urlSet = new Set(urls);
    this._fullData = this._fullData.filter(d => !urlSet.has(d.url));
    this.data = this._filterFn ? this._fullData.filter(this._filterFn) : this._fullData;
    for (const url of urls) this._savedNodes.delete(url);
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
        this._expandedExtraH = item.offsetHeight - this.rowHeight;
        const row = item.querySelector('.result-row');
        if (row) {
          const url = row.dataset.url;
          this._expandedIdx = this.data.findIndex(d => d.url === url);
        }
      }
    } else {
      this._expandedIdx = -1;
      this._expandedExtraH = 0;
    }
    // Only adjust padding-bottom to account for the height change —
    // do NOT re-render, which would destroy the open detail DOM state.
    const { end } = this.renderedRange;
    if (end >= 0) {
      const base = (this.data.length - end) * this.rowHeight + this.basePaddingBottom;
      const extraAfter = (this._expandedIdx >= end) ? this._expandedExtraH : 0;
      this.containerEl.style.paddingBottom = (base + extraAfter) + 'px';
    }
  }

  _totalHeight() {
    return this.data.length * this.rowHeight +
      (this._expandedIdx >= 0 ? this._expandedExtraH : 0);
  }

  // Save a DOM node if it has meaningful state (selected or expanded); otherwise discard it.
  _saveOrDiscard(item) {
    const row = item.querySelector('.result-row');
    if (row && (row.classList.contains('selected') || item.querySelector('.result-detail.open'))) {
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
        if (this.data.length === 0) this.containerEl.innerHTML = this._headerHtml;
      }
      return;
    }

    const viewH = this.scrollEl.clientHeight;
    // Use getBoundingClientRect for correct offset regardless of intermediate
    // positioned ancestors (e.g. .section-results-wrapper with position:relative).
    const adjTop = Math.max(0, this.scrollEl.getBoundingClientRect().top - this.containerEl.getBoundingClientRect().top);

    const start = Math.max(0, Math.floor(adjTop / this.rowHeight) - this.buffer);
    const end = Math.min(this.data.length, Math.ceil((adjTop + viewH) / this.rowHeight) + this.buffer);

    if (!force && start === this.renderedRange.start && end === this.renderedRange.end) return;

    // Update padding
    const paddingTop = start * this.rowHeight;
    let paddingBottom = (this.data.length - end) * this.rowHeight + this.basePaddingBottom;
    if (this._expandedIdx >= end) paddingBottom += this._expandedExtraH;
    this.containerEl.style.paddingTop = paddingTop + 'px';
    this.containerEl.style.paddingBottom = paddingBottom + 'px';

    const { start: oldStart, end: oldEnd } = this.renderedRange;

    if (force || oldStart === -1 || start >= oldEnd || end <= oldStart) {
      // Full rebuild: forced (setData/applyFilter), first render, or non-overlapping scroll jump.
      // On non-forced jumps, save selected nodes before destroying.
      if (!force) {
        for (const item of this.containerEl.querySelectorAll('.result-item')) {
          const row = item.querySelector('.result-row');
          if (row && (row.classList.contains('selected') || item.querySelector('.result-detail.open'))) {
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
        for (const item of [...this.containerEl.querySelectorAll('.result-item')]) {
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
            if (el) { ref ? ref.before(el) : this.containerEl.appendChild(el); }
            else { ref ? ref.insertAdjacentHTML('beforebegin', html) : this.containerEl.insertAdjacentHTML('beforeend', html); }
          });
        }
      }

      // Add items entering the bottom
      const addBotStart = Math.max(oldEnd, start);
      for (let i = addBotStart; i < end; i++) {
        this._insertRow(i, (el, html) => {
          if (el) { this.containerEl.appendChild(el); }
          else { this.containerEl.insertAdjacentHTML('beforeend', html); }
        });
      }
    }

    // Clear expanded state if it scrolled out of range
    if (this._expandedIdx >= 0 && (this._expandedIdx < start || this._expandedIdx >= end)) {
      this._expandedIdx = -1;
      this._expandedExtraH = 0;
    }

    this.renderedRange = { start, end };

    // Trigger load-more when approaching the end of data
    if (this.onLoadMore && end >= this.data.length - this.buffer * 2) {
      this.onLoadMore();
    }
  }
}
