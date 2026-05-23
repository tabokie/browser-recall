/**
 * VirtualScroller unit tests.
 *
 * Tests the _render guard that prevents scroll-triggered renders from
 * overwriting non-scroller content (e.g. recycle bin rows) when the
 * scroller's data is empty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VIRTUAL_SCROLLER_BUFFER,
  VIRTUAL_SCROLLER_LOAD_MORE_THRESHOLD,
  VirtualScroller,
} from '../../packages/core/virtual-scroller.js';

// ---------------------------------------------------------------------------
// Minimal DOM mocks — just enough for VirtualScroller
// ---------------------------------------------------------------------------

function mockElement(tag, opts = {}) {
  const el = {
    tagName: tag,
    style: {},
    innerHTML: opts.innerHTML || '',
    scrollTop: opts.scrollTop || 0,
    clientHeight: opts.clientHeight || 600,
    offsetTop: opts.offsetTop || 0,
    _top: opts._top || 0,
    _listeners: {},
    addEventListener(evt, fn) {
      if (!el._listeners[evt]) el._listeners[evt] = [];
      el._listeners[evt].push(fn);
    },
    appendChild() {},
    insertAdjacentHTML(_position, html) {
      el.innerHTML += html;
    },
    getBoundingClientRect() {
      return { top: el._top };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return el;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VirtualScroller', () => {
  let scrollEl, containerEl, vs;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  beforeEach(() => {
    globalThis.getComputedStyle = () => ({ paddingBottom: '0px' });
    globalThis.requestAnimationFrame = (fn) => fn();
    scrollEl = mockElement('div', { clientHeight: 600 });
    containerEl = mockElement('div');
    vs = new VirtualScroller(scrollEl, containerEl, 48);
  });

  afterEach(() => {
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  describe('_render guard when data is empty', () => {
    it('force=true with empty data clears the container', () => {
      containerEl.innerHTML = '<div>old content</div>';
      vs._headerHtml = '<div class="header">H</div>';
      vs.data = [];
      vs._render(true);

      expect(containerEl.innerHTML).toBe('<div class="header">H</div>');
      expect(containerEl.style.paddingTop).toBe('0px');
      expect(containerEl.style.paddingBottom).toBe('0px');
    });

    it('force=false with empty data does NOT touch the container', () => {
      // Simulate recycle bin content written directly into the container
      const recycleBinHtml = '<div class="result-item">Recycle bin row</div>';
      containerEl.innerHTML = recycleBinHtml;
      containerEl.style.paddingTop = '0px';
      containerEl.style.paddingBottom = '0px';

      vs.data = [];
      vs._render(false); // scroll-triggered

      // Content must be preserved
      expect(containerEl.innerHTML).toBe(recycleBinHtml);
    });

    it('scroll events after setData([]) do not wipe container', () => {
      // First, populate with real data
      vs.setData(
        [{ url: 'https://a.com' }, { url: 'https://b.com' }],
        (item) => `<div>${item.url}</div>`,
      );
      expect(containerEl.innerHTML).toContain('https://a.com');

      // Now clear data (simulating recycle bin transition)
      vs.data = [];
      vs.renderedRange = { start: -1, end: -1 };

      // Write non-scroller content
      containerEl.innerHTML = '<div>recycle bin</div>';

      // Simulate scroll event
      const scrollHandler = scrollEl._listeners['scroll'][0];
      scrollHandler();

      // Recycle bin content must survive
      expect(containerEl.innerHTML).toBe('<div>recycle bin</div>');
    });
  });

  describe('expanded detail survives scroll', () => {
    it('scroll-triggered re-render does not destroy expanded detail in rendered range', () => {
      const items = Array.from(
        { length: VIRTUAL_SCROLLER_BUFFER * 2 },
        (_, i) => ({
          id: i,
          url: `https://example.com/${i}`,
        }),
      );
      vs.setData(
        items,
        (item) =>
          `<div class="result-item"><div class="result-row" data-url="${item.url}">${item.id}</div><div class="result-detail"></div></div>`,
      );

      const rangeAfterInit = { ...vs.renderedRange };

      // Simulate expanding item 5 (within rendered range)
      vs._expandedIdx = 5;
      vs._expandedExtraH = 300; // detail adds 300px

      // Mark innerHTML with a sentinel that would be destroyed by re-render
      containerEl.innerHTML += '<!--EXPANDED-->';

      // Scroll down just enough to shift the range by 1 row
      scrollEl.scrollTop = (rangeAfterInit.end - vs.buffer) * vs.rowHeight + 1;
      vs._render(false);

      // The expanded detail must survive — innerHTML should NOT be replaced
      expect(containerEl.innerHTML).toContain('<!--EXPANDED-->');
    });

    it('re-render is allowed once expanded item scrolls out of new range', () => {
      const scrollRows = Math.max(VIRTUAL_SCROLLER_BUFFER * 2, 20);
      const items = Array.from(
        { length: scrollRows + VIRTUAL_SCROLLER_BUFFER + 50 },
        (_, i) => ({
          id: i,
          url: `https://example.com/${i}`,
        }),
      );
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      // Expand item 5
      vs._expandedIdx = 5;
      vs._expandedExtraH = 300;

      // Scroll far down so item 5 is well outside the new rendered range
      scrollEl.scrollTop = scrollRows * vs.rowHeight;
      // Simulate container scrolling up out of view (getBoundingClientRect)
      containerEl._top = -(scrollRows * vs.rowHeight);
      vs._render(false);

      // Item 5 is no longer in view — re-render should proceed normally
      // (the new range won't include item 5)
      expect(vs.renderedRange.start).toBeGreaterThan(5);
      expect(vs._expandedIdx).toBe(-1);
    });
  });

  describe('bottom padding', () => {
    it('no extra padding when all items are rendered (end === data.length)', () => {
      // 10 items all fit in viewport+buffer → end = data.length
      const items = Array.from({ length: 10 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      expect(vs.renderedRange.end).toBe(10);
      // No trailing rows → padding should be 0, not an arbitrary minimum
      expect(containerEl.style.paddingBottom).toBe('0px');
    });

    it('onExpandToggle on last item does not shrink padding', () => {
      const items = Array.from({ length: 10 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      const paddingBefore = containerEl.style.paddingBottom;

      // Simulate expanding the last item
      vs._expandedIdx = 9;
      vs._expandedExtraH = 300;
      vs.onExpandToggle();

      // Padding should not decrease
      expect(parseInt(containerEl.style.paddingBottom)).toBeGreaterThanOrEqual(
        parseInt(paddingBefore),
      );
    });

    it('onExpandToggle restores padding after collapse', () => {
      const items = Array.from({ length: 10 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      const paddingBefore = containerEl.style.paddingBottom;

      // Expand
      vs._expandedIdx = 5;
      vs._expandedExtraH = 300;
      vs.onExpandToggle();

      // Collapse
      vs._expandedIdx = -1;
      vs._expandedExtraH = 0;
      vs.onExpandToggle();

      expect(containerEl.style.paddingBottom).toBe(paddingBefore);
    });

    it('computes expansion extra height from the measured collapsed row height', () => {
      const url = 'https://example.com/measured-row';
      vs.setData([{ id: 1, url }], (item) => `<div>${item.id}</div>`);
      vs._setMeasuredHeight(0, url, 72);

      const item = {
        offsetHeight: 120,
        getBoundingClientRect: () => ({ height: 120 }),
        closest: () => item,
        querySelector: (selector) => {
          if (selector === '.result-row') return { dataset: { url } };
          if (selector === '.result-detail.open') return {};
          return null;
        },
      };
      const openDetail = { closest: () => item };
      containerEl.querySelector = (selector) =>
        selector === '.result-detail.open' ? openDetail : null;

      vs.onExpandToggle();

      expect(vs._expandedIdx).toBe(0);
      expect(vs._expandedExtraH).toBe(48);
    });
  });

  describe('normal rendering', () => {
    it('setData renders visible rows', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
      vs.setData(items, (item) => `<div class="row">${item.id}</div>`);

      expect(containerEl.innerHTML).toContain('class="row"');
      expect(vs.renderedRange.start).toBeGreaterThanOrEqual(0);
      expect(vs.renderedRange.end).toBeGreaterThan(0);
    });

    it('scroll-triggered render with unchanged range is a no-op', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      const htmlAfterSet = containerEl.innerHTML;
      vs._render(false); // same scroll position → same range

      expect(containerEl.innerHTML).toBe(htmlAfterSet);
    });

    it('does not load more on initial render just because the render buffer is large', () => {
      let calls = 0;
      vs.onLoadMore = () => {
        calls += 1;
      };

      const itemCount = VIRTUAL_SCROLLER_BUFFER * 2;
      const items = Array.from({ length: itemCount }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      expect(calls).toBe(0);
    });

    it('does not re-enter load-more while a previous load is pending', async () => {
      expect(vs.loadMoreThreshold).toBe(VIRTUAL_SCROLLER_LOAD_MORE_THRESHOLD);
      const visibleRows = Math.ceil(scrollEl.clientHeight / vs.rowHeight);
      const itemCount =
        VIRTUAL_SCROLLER_LOAD_MORE_THRESHOLD * 4 + visibleRows + 20;
      const triggerRows =
        itemCount - VIRTUAL_SCROLLER_LOAD_MORE_THRESHOLD - visibleRows + 2;
      const items = Array.from({ length: itemCount }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      let resolveLoad;
      let calls = 0;
      vs.onLoadMore = () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      };

      containerEl._top = -((triggerRows - 10) * vs.rowHeight);
      vs._render(false);
      expect(calls).toBe(0);

      containerEl._top = -(triggerRows * vs.rowHeight);
      vs._render(false);
      containerEl._top = -((triggerRows + 1) * vs.rowHeight);
      vs._render(false);

      expect(calls).toBe(1);
      resolveLoad();
      await Promise.resolve();
      await Promise.resolve();

      containerEl._top = -((triggerRows + 2) * vs.rowHeight);
      vs._render(false);

      expect(calls).toBe(2);
    });

    it('calibrates row height upward from rendered result item size', () => {
      const previousQuerySelectorAll = containerEl.querySelectorAll;
      containerEl.querySelectorAll = (selector) => {
        if (selector !== '.result-item') return [];
        return [
          {
            offsetHeight: 64,
            getBoundingClientRect: () => ({ height: 64 }),
            querySelector: (selector) =>
              selector === '.result-row'
                ? { dataset: { url: 'https://example.com/0' } }
                : null,
          },
        ];
      };
      globalThis.getComputedStyle = (element) => {
        if (element?.offsetHeight === 64) {
          return {
            marginTop: '8px',
            marginBottom: '0px',
            paddingBottom: '0px',
          };
        }
        return { paddingBottom: '0px' };
      };

      const items = Array.from({ length: 20 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      expect(vs.rowHeight).toBe(72);
      containerEl.querySelectorAll = previousQuerySelectorAll;
    });

    it('keeps the unseen-row estimate stable after initial calibration', () => {
      let measuredHeight = 64;
      containerEl.querySelectorAll = (selector) => {
        if (selector !== '.result-item') return [];
        return [
          {
            offsetHeight: measuredHeight,
            getBoundingClientRect: () => ({ height: measuredHeight }),
            querySelector: (selector) =>
              selector === '.result-row'
                ? {
                    dataset: { url: `https://example.com/${measuredHeight}` },
                    classList: { contains: () => false },
                  }
                : null,
          },
        ];
      };
      globalThis.getComputedStyle = () => ({
        marginTop: '8px',
        marginBottom: '0px',
        paddingBottom: '0px',
      });

      const items = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);
      expect(vs.rowHeight).toBe(72);

      measuredHeight = 120;
      vs.renderedRange = { start: -1, end: -1 };
      vs._render(false);

      expect(vs.rowHeight).toBe(72);
      expect(vs._heightByKey.get('https://example.com/120')).toBe(128);
    });

    it('resets calibrated row height when data is replaced', () => {
      vs.rowHeight = 72;

      vs.setData(
        [{ id: 1, url: 'https://example.com/1' }],
        (item) => `<div>${item.id}</div>`,
      );

      expect(vs.rowHeight).toBe(vs.baseRowHeight);
    });

    it('schedules a render after appending data', () => {
      let rafCallback = null;
      globalThis.requestAnimationFrame = (fn) => {
        rafCallback = fn;
        return 1;
      };
      const items = Array.from({ length: 20 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);
      const originalRange = { ...vs.renderedRange };

      vs.appendData([{ id: 21, url: 'https://example.com/21' }]);

      expect(vs.renderedRange).toEqual({ start: -1, end: -1 });
      expect(typeof rafCallback).toBe('function');
      rafCallback();
      expect(vs.renderedRange.start).toBe(originalRange.start);
      expect(vs.renderedRange.end).toBeGreaterThan(originalRange.end);
    });

    it('uses cached variable row heights for spacer offsets', () => {
      const items = Array.from({ length: 5 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);
      vs._setMeasuredHeight(0, 'https://example.com/0', 100);
      vs._setMeasuredHeight(1, 'https://example.com/1', 80);

      expect(vs._heightForIndex(0)).toBe(100);
      expect(vs._heightForIndex(1)).toBe(80);
      expect(vs._offsetForIndex(2)).toBe(180);
      expect(vs._rangeForViewport(120, 60).end).toBeGreaterThanOrEqual(2);
    });

    it('does not scan every preceding row to range a large list', () => {
      const itemCount = 50_000;
      const items = Array.from({ length: itemCount }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);
      vs._setMeasuredHeight(10_000, 'https://example.com/10000', 80);
      vs._setMeasuredHeight(40_000, 'https://example.com/40000', 64);

      const originalHeightForIndex = vs._heightForIndex.bind(vs);
      let heightLookups = 0;
      vs._heightForIndex = (index) => {
        heightLookups += 1;
        return originalHeightForIndex(index);
      };

      const range = vs._rangeForViewport(49_000 * vs.rowHeight, 600);

      expect(range.start).toBeGreaterThan(48_000);
      expect(heightLookups).toBeLessThan(100);
    });

    it('does not compensate scrollTop during normal scroll renders', () => {
      let rowTop = 140;
      const row = {
        dataset: { url: 'https://example.com/anchor' },
        classList: { contains: () => false },
        closest: () => ({
          getBoundingClientRect: () => ({ top: rowTop }),
        }),
      };
      const item = {
        parentNode: true,
        remove() {},
        getBoundingClientRect: () => ({ top: 140, bottom: 188, height: 48 }),
        querySelector: (selector) => (selector === '.result-row' ? row : null),
      };
      containerEl.querySelector = (selector) =>
        selector === '.result-item' ? item : null;
      containerEl.querySelectorAll = (selector) => {
        if (selector === '.result-item') return [item];
        if (selector === '.result-row') return [row];
        return [];
      };
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);
      scrollEl.scrollTop = 500;
      containerEl._top = -(60 * vs.rowHeight);
      rowTop = 112;

      vs._render(false);

      expect(scrollEl.scrollTop).toBe(500);
    });

    it('preserves scroll anchors using the viewport-relative container offset', () => {
      const items = Array.from({ length: 20 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs = new VirtualScroller(scrollEl, containerEl, 50);
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      scrollEl._top = 0;
      scrollEl.scrollTop = 500;
      // The results container starts 300px below the scroll content top, so
      // the viewport is 200px into the results, not 500px into them.
      containerEl._top = -200;

      vs.updateData(
        items.filter((item) => item.url !== 'https://example.com/7'),
        (item) => `<div>${item.id}</div>`,
        { preserveScroll: true },
      );

      expect(scrollEl.scrollTop).toBe(500);
    });

    it('preserves scroll when DOM teardown temporarily clamps scrollTop to zero', () => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs = new VirtualScroller(scrollEl, containerEl, 50);
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      scrollEl._top = 0;
      scrollEl.scrollTop = 1800;
      scrollEl.scrollHeight = 2400;
      containerEl._top = -1800;
      containerEl.querySelectorAll = (selector) => {
        if (selector !== '.result-item') return [];
        return [
          {
            querySelector: (rowSelector) =>
              rowSelector === '.result-row'
                ? {
                    dataset: { url: 'https://example.com/36' },
                    classList: { contains: () => false },
                  }
                : null,
            remove() {
              scrollEl.scrollTop = 0;
              scrollEl.scrollHeight = scrollEl.clientHeight;
              containerEl._top = 0;
            },
          },
        ];
      };

      vs.updateData(
        items.filter((item) => item.url !== 'https://example.com/6'),
        (item) => `<div>${item.id}</div>`,
        { preserveScroll: true },
      );

      expect(scrollEl.scrollTop).toBe(1800);
    });

    it('does not let a stale top lock override later preserved refreshes', () => {
      const callbacks = [];
      globalThis.requestAnimationFrame = (fn) => {
        callbacks.push(fn);
        return callbacks.length;
      };
      const drainFrames = () => {
        while (callbacks.length > 0) {
          callbacks.splice(0).forEach((callback) => callback());
        }
      };
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs = new VirtualScroller(scrollEl, containerEl, 50);
      vs.updateDataAtTop(items, (item) => `<div>${item.id}</div>`);
      drainFrames();

      scrollEl.scrollTop = 1800;
      containerEl._top = -1800;
      scrollEl._listeners.scroll[0]();
      drainFrames();
      expect(scrollEl.scrollTop).toBe(1800);

      vs.updateData(
        items.filter((item) => item.url !== 'https://example.com/6'),
        (item) => `<div>${item.id}</div>`,
        { preserveScroll: true },
      );

      expect(scrollEl.scrollTop).toBeGreaterThan(0);
    });

    it('keeps the bottom anchored after appending variable-height rows', () => {
      let rafCallback = null;
      globalThis.requestAnimationFrame = (fn) => {
        rafCallback = fn;
        return 1;
      };
      const items = Array.from({ length: 20 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);
      scrollEl.clientHeight = 600;
      scrollEl.scrollHeight = 1000;
      scrollEl.scrollTop = 400;

      vs.appendData([{ id: 21, url: 'https://example.com/21' }]);
      scrollEl.scrollHeight = 1300;
      rafCallback();

      expect(scrollEl.scrollTop).toBe(700);
    });

    it('coalesces scroll renders to one animation frame', () => {
      const callbacks = [];
      globalThis.requestAnimationFrame = (fn) => {
        callbacks.push(fn);
        return callbacks.length;
      };

      const scrollHandler = scrollEl._listeners['scroll'][0];
      scrollHandler();
      scrollHandler();

      expect(callbacks).toHaveLength(1);
      callbacks[0]();
      scrollHandler();
      expect(callbacks).toHaveLength(2);
    });
  });
});
