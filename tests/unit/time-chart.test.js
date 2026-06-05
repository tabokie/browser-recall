// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderTimeChartInto,
  bindChartBarClick,
  applyDateFilter,
} from '../../apps/extension/time-chart.js';

// Helper: create chart DOM structure matching the shared history chart UI.
function createChartDOM() {
  const chartEl = document.createElement('div');
  chartEl.classList.add('time-chart');
  chartEl.innerHTML = `
    <div class="chart-label"></div>
    <div class="chart-bars" id="testBars"></div>
    <div class="chart-tooltip"></div>
  `;
  document.body.appendChild(chartEl);
  const barsEl = chartEl.querySelector('.chart-bars');
  return { chartEl, barsEl };
}

// Helper: build entries for a given date with N entries
function makeEntries(dateStr, count) {
  const ts = new Date(dateStr + 'T12:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    url: `https://example.com/${dateStr}/${i}`,
    title: `Page ${i}`,
    timestamp: ts + i * 1000,
  }));
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

describe('renderTimeChartInto', () => {
  let chartEl, barsEl;

  beforeEach(() => {
    document.body.innerHTML = '';
    ({ chartEl, barsEl } = createChartDOM());
  });

  it('renders real data bars (baseline)', () => {
    const entries = [
      ...makeEntries('2026-03-01', 5),
      ...makeEntries('2026-03-03', 10),
    ];
    renderTimeChartInto(chartEl, barsEl, entries, 'Test');

    expect(chartEl.classList.contains('visible')).toBe(true);

    const groups = barsEl.querySelectorAll('.chart-bar-group.has-data');
    expect(groups.length).toBe(2); // only 2 dates have data

    // No estimated class
    const estimated = barsEl.querySelectorAll('.chart-bar-group.estimated');
    expect(estimated.length).toBe(0);
  });

  it('renders bars from durable visit dates before latest timestamps', () => {
    renderTimeChartInto(
      chartEl,
      barsEl,
      [
        {
          url: 'https://example.com/revisited',
          title: 'Revisited',
          visitDates: [20260301, '2026-03-03'],
          timestamps: [new Date('2026-03-10T12:00:00Z').getTime()],
        },
      ],
      'Test',
    );

    expect(
      barsEl.querySelector('[data-date="2026-03-01"] .chart-bar'),
    ).not.toBeNull();
    expect(
      barsEl.querySelector('[data-date="2026-03-03"] .chart-bar'),
    ).not.toBeNull();
    expect(
      barsEl.querySelector('[data-date="2026-03-10"] .chart-bar'),
    ).toBeNull();
  });

  it('renders estimated bars uniformly with real bars', () => {
    const entries = makeEntries('2026-03-10', 5);
    const estimatedByDay = new Map([
      ['2026-03-01', 8],
      ['2026-03-05', 3],
    ]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);

    expect(chartEl.classList.contains('visible')).toBe(true);

    // All three dates should have has-data bars, no estimated distinction
    const hasData = barsEl.querySelectorAll('.chart-bar-group.has-data');
    expect(hasData.length).toBe(3);

    // No estimated class on any bar
    const estimated = barsEl.querySelectorAll('.chart-bar-group.estimated');
    expect(estimated.length).toBe(0);
  });

  it('date range spans both real and estimated dates', () => {
    // Real data only on March 28-31, estimated data back to January
    const entries = makeEntries('2026-03-28', 3);
    const estimatedByDay = new Map([
      ['2026-01-15', 10],
      ['2026-02-20', 5],
    ]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);

    // Range should start from Jan 1 (expanded to month boundary of earliest date)
    // and go to March 28
    const allGroups = barsEl.querySelectorAll('.chart-bar-group');
    const dates = Array.from(allGroups).map((g) => g.dataset.date);

    // First date should be 2026-01-01 (month boundary of earliest estimated date)
    expect(dates[0]).toBe('2026-01-01');
    // Last date should be today (chart always extends to current date)
    const today = localDateKey();
    expect(dates[dates.length - 1]).toBe(today);
    // Should span from Jan 1 to today
    const todayParts = today.split('-').map(Number);
    const expectedDays =
      Math.round(
        (new Date(todayParts[0], todayParts[1] - 1, todayParts[2]) -
          new Date(2026, 0, 1)) /
          86400000,
      ) + 1;
    expect(dates.length).toBe(expectedDays);
  });

  it('maxScore considers both real and estimated values', () => {
    // Real data: 2 visits, estimated: 20 visits
    // With estimated included, the real bar should be much shorter
    const entries = makeEntries('2026-03-10', 2);
    const estimatedByDay = new Map([['2026-03-05', 20]]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);

    const bars = barsEl.querySelectorAll(
      '.chart-bar-group.has-data .chart-bar',
    );
    const heights = [...bars].map((b) => parseInt(b.style.height));
    // The estimated (20) bar should be taller than the real (2) bar
    expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights));
  });

  it('real data takes precedence over estimated for same date', () => {
    const entries = makeEntries('2026-03-05', 7);
    const estimatedByDay = new Map([
      ['2026-03-05', 3], // same date as real data — real wins
      ['2026-03-01', 5], // only estimated
    ]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);

    // Both dates should be has-data, no estimated distinction
    const hasData = barsEl.querySelectorAll('.chart-bar-group.has-data');
    expect(hasData.length).toBe(2);
    // Mar 5 bar height should reflect real count (7), not estimated (3)
    const mar5 = barsEl.querySelector('[data-date="2026-03-05"] .chart-bar');
    const mar1 = barsEl.querySelector('[data-date="2026-03-01"] .chart-bar');
    expect(parseInt(mar5.style.height)).toBeGreaterThan(
      parseInt(mar1.style.height),
    );
  });

  it('renders chart with only estimated data (no real entries)', () => {
    const estimatedByDay = new Map([
      ['2026-03-01', 10],
      ['2026-03-15', 5],
    ]);

    renderTimeChartInto(chartEl, barsEl, [], 'Test', estimatedByDay);

    expect(chartEl.classList.contains('visible')).toBe(true);

    // All data bars rendered uniformly (no estimated class)
    const hasData = barsEl.querySelectorAll('.chart-bar-group.has-data');
    expect(hasData.length).toBe(2);
  });

  it('hides chart when no real data and no estimates', () => {
    renderTimeChartInto(chartEl, barsEl, [], 'Test', new Map());
    expect(chartEl.classList.contains('visible')).toBe(false);
  });

  it('hides chart when no real data and estimates is undefined', () => {
    renderTimeChartInto(chartEl, barsEl, [], 'Test', undefined);
    expect(chartEl.classList.contains('visible')).toBe(false);
  });
});

describe('bindChartBarClick with estimated bars', () => {
  let chartEl, barsEl, resultsContainer;

  beforeEach(() => {
    document.body.innerHTML = '';
    ({ chartEl, barsEl } = createChartDOM());
    resultsContainer = document.createElement('div');
    resultsContainer.id = 'results';
    document.body.appendChild(resultsContainer);
  });

  it('click on any bar toggles active state', () => {
    const entries = makeEntries('2026-03-10', 5);
    const estimatedByDay = new Map([['2026-03-05', 8]]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);
    bindChartBarClick(chartEl, resultsContainer);

    // Click on estimated-origin bar — should become active
    const mar5Bar = barsEl.querySelector('[data-date="2026-03-05"] .chart-bar');
    mar5Bar.click();
    expect(
      mar5Bar.closest('.chart-bar-group').classList.contains('active'),
    ).toBe(true);

    // Click on real bar — should also become active
    const mar10Bar = barsEl.querySelector(
      '[data-date="2026-03-10"] .chart-bar',
    );
    mar10Bar.click();
    expect(
      mar10Bar.closest('.chart-bar-group').classList.contains('active'),
    ).toBe(true);
  });

  it('restores active date selections after rerender', () => {
    const entries = makeEntries('2026-03-10', 5);

    chartEl._activeDates = new Set(['2026-03-10']);
    renderTimeChartInto(chartEl, barsEl, entries, 'Test');

    const mar10Group = barsEl.querySelector('[data-date="2026-03-10"]');
    expect(mar10Group.classList.contains('active')).toBe(true);
  });

  it('waits for demand loading before applying the date filter', async () => {
    const entries = makeEntries('2026-03-10', 5);
    const estimatedByDay = new Map([['2026-03-05', 8]]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);
    chartEl._onDateSelect = async () => {
      await Promise.resolve();
      resultsContainer.innerHTML = `
        <div class="result-item"><div class="result-row" data-dates="2026-03-05"></div></div>
        <div class="result-item"><div class="result-row" data-dates="2026-03-10"></div></div>
      `;
    };
    bindChartBarClick(chartEl, resultsContainer);

    const mar5Bar = barsEl.querySelector('[data-date="2026-03-05"] .chart-bar');
    mar5Bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const items = resultsContainer.querySelectorAll('.result-item');
    expect(items[0].style.display).toBe('');
    expect(items[1].style.display).toBe('none');
  });

  it('filters virtual-scrolled items by local chart date', () => {
    const selectedDate = '2026-03-05';
    const localTimestamp = new Date(2026, 2, 5, 0, 30).getTime();
    const utcDate = new Date(localTimestamp).toISOString().slice(0, 10);
    if (utcDate === selectedDate) return;

    renderTimeChartInto(
      chartEl,
      barsEl,
      [{ url: 'https://example.com/local', timestamp: localTimestamp }],
      'Test',
    );
    const group = barsEl.querySelector(`[data-date="${selectedDate}"]`);
    expect(group).not.toBeNull();
    group.classList.add('active');

    let filterFn = null;
    resultsContainer._virtualScroller = {
      applyFilter(fn) {
        filterFn = fn;
      },
    };

    applyDateFilter(chartEl, resultsContainer);

    expect(filterFn).toBeTypeOf('function');
    expect(
      filterFn({
        url: 'https://example.com/local',
        timestamps: [localTimestamp],
      }),
    ).toBe(true);
  });

  it('filters virtual-scrolled items by durable visit dates before latest timestamps', () => {
    const selectedDate = '2026-03-05';

    renderTimeChartInto(
      chartEl,
      barsEl,
      [
        {
          url: 'https://example.com/revisited',
          visitDates: [20260305],
          timestamps: [new Date('2026-03-10T12:00:00Z').getTime()],
        },
      ],
      'Test',
    );
    const group = barsEl.querySelector(`[data-date="${selectedDate}"]`);
    expect(group).not.toBeNull();
    group.classList.add('active');

    let filterFn = null;
    resultsContainer._virtualScroller = {
      applyFilter(fn) {
        filterFn = fn;
      },
    };

    applyDateFilter(chartEl, resultsContainer);

    expect(filterFn).toBeTypeOf('function');
    expect(
      filterFn({
        url: 'https://example.com/revisited',
        visitDates: [20260305],
        timestamps: [new Date('2026-03-10T12:00:00Z').getTime()],
      }),
    ).toBe(true);
    expect(
      filterFn({
        url: 'https://example.com/latest-only',
        visitDates: [20260310],
        timestamps: [new Date('2026-03-05T12:00:00Z').getTime()],
      }),
    ).toBe(false);
  });
});
