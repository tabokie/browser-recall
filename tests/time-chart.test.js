// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderTimeChartInto, bindChartBarClick } from '../extension/time-chart.js';

// Helper: create chart DOM structure matching options.html
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

  it('renders estimated bars with .estimated class', () => {
    const entries = makeEntries('2026-03-10', 5);
    const estimatedByDay = new Map([
      ['2026-03-01', 8],
      ['2026-03-05', 3],
    ]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);

    expect(chartEl.classList.contains('visible')).toBe(true);

    // Should have estimated groups
    const estimatedGroups = barsEl.querySelectorAll('.chart-bar-group.estimated');
    expect(estimatedGroups.length).toBe(2);

    // Estimated bars should have .estimated class on the bar element too
    for (const g of estimatedGroups) {
      expect(g.querySelector('.chart-bar.estimated')).not.toBeNull();
    }

    // Real data bar should NOT have .estimated
    const realGroups = barsEl.querySelectorAll('.chart-bar-group.has-data:not(.estimated)');
    expect(realGroups.length).toBe(1);
    expect(realGroups[0].dataset.date).toBe('2026-03-10');
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
    const dates = Array.from(allGroups).map(g => g.dataset.date);

    // First date should be 2026-01-01 (month boundary of earliest estimated date)
    expect(dates[0]).toBe('2026-01-01');
    // Last date should be 2026-03-28
    expect(dates[dates.length - 1]).toBe('2026-03-28');
    // Should span ~87 days (Jan 1 to Mar 28)
    expect(dates.length).toBe(87);
  });

  it('maxScore considers both real and estimated values', () => {
    // Real data: 2 visits, estimated: 20 visits
    // If maxScore only used real data, the real bar would be full height (44px)
    // With estimated included, the real bar should be much shorter
    const entries = makeEntries('2026-03-10', 2);
    const estimatedByDay = new Map([
      ['2026-03-05', 20],
    ]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);

    const realBar = barsEl.querySelector('.chart-bar-group.has-data:not(.estimated) .chart-bar');
    const estBar = barsEl.querySelector('.chart-bar-group.estimated .chart-bar');

    // Estimated bar should be taller than real bar
    const realHeight = parseInt(realBar.style.height);
    const estHeight = parseInt(estBar.style.height);
    expect(estHeight).toBeGreaterThan(realHeight);
  });

  it('real data takes precedence over estimated for same date', () => {
    const entries = makeEntries('2026-03-05', 7);
    const estimatedByDay = new Map([
      ['2026-03-05', 3], // same date as real data
      ['2026-03-01', 5], // only estimated
    ]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);

    // The 2026-03-05 bar should be real, not estimated
    const mar5 = barsEl.querySelector('[data-date="2026-03-05"]');
    expect(mar5.classList.contains('has-data')).toBe(true);
    expect(mar5.classList.contains('estimated')).toBe(false);
    expect(mar5.dataset.score).toBe('7.0'); // real count, not estimated 3
  });

  it('renders chart with only estimated data (no real entries)', () => {
    const estimatedByDay = new Map([
      ['2026-03-01', 10],
      ['2026-03-15', 5],
    ]);

    renderTimeChartInto(chartEl, barsEl, [], 'Test', estimatedByDay);

    expect(chartEl.classList.contains('visible')).toBe(true);

    // All data bars should be estimated
    const hasData = barsEl.querySelectorAll('.chart-bar-group.has-data');
    const estimated = barsEl.querySelectorAll('.chart-bar-group.estimated');
    expect(hasData.length).toBe(2);
    expect(estimated.length).toBe(2);
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

  it('click on estimated bar does not toggle active state', () => {
    const entries = makeEntries('2026-03-10', 5);
    const estimatedByDay = new Map([['2026-03-05', 8]]);

    renderTimeChartInto(chartEl, barsEl, entries, 'Test', estimatedByDay);
    bindChartBarClick(chartEl, resultsContainer);

    // Click on estimated bar
    const estBar = barsEl.querySelector('.chart-bar-group.estimated .chart-bar');
    estBar.click();

    // Should NOT become active
    const estGroup = barsEl.querySelector('.chart-bar-group.estimated');
    expect(estGroup.classList.contains('active')).toBe(false);

    // Click on real bar — should become active
    const realBar = barsEl.querySelector('.chart-bar-group.has-data:not(.estimated) .chart-bar');
    realBar.click();
    const realGroup = realBar.closest('.chart-bar-group');
    expect(realGroup.classList.contains('active')).toBe(true);
  });
});
