/**
 * VirtualScroller unit tests.
 *
 * Tests the _render guard that prevents scroll-triggered renders from
 * overwriting non-scroller content (e.g. recycle bin rows) when the
 * scroller's data is empty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualScroller } from '../../packages/core/virtual-scroller.js';

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
      // 100 items, rowHeight=48, viewport=600 → ~13 visible + 20 buffer each side
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
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
      const items = Array.from({ length: 200 }, (_, i) => ({
        id: i,
        url: `https://example.com/${i}`,
      }));
      vs.setData(items, (item) => `<div>${item.id}</div>`);

      // Expand item 5
      vs._expandedIdx = 5;
      vs._expandedExtraH = 300;

      // Scroll far down so item 5 is well outside the new rendered range
      scrollEl.scrollTop = 150 * vs.rowHeight;
      // Simulate container scrolling up out of view (getBoundingClientRect)
      containerEl._top = -(150 * vs.rowHeight);
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
  });
});
