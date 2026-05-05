// Time chart — rendering, tooltips, bar click filtering, and highlight sync
import { dateKeyFromTimestamp } from './utils.js';

function aggregateVisitsByDay(entries) {
  const byDay = new Map();
  for (const i of entries) {
    const dayKey = dateKeyFromTimestamp(i.timestamp);
    const prev = byDay.get(dayKey) || 0;
    byDay.set(dayKey, prev + 1); // count visits per day
  }
  // Sort by date
  const sorted = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return sorted; // [[dateStr, count], ...]
}

export function renderTimeChartInto(
  chartEl,
  barsEl,
  entries,
  label,
  estimatedByDay,
) {
  if (label !== undefined) {
    const labelEl = chartEl.querySelector('.chart-label');
    if (labelEl) labelEl.textContent = label;
  }

  const data = aggregateVisitsByDay(entries || []);
  const scoreMap = new Map(data);
  const hasEstimates = estimatedByDay && estimatedByDay.size > 0;

  if (data.length === 0 && !hasEstimates) {
    chartEl.classList.remove('visible');
    return;
  }

  // Collect all dates with data (real or estimated)
  const allDataDates = [...scoreMap.keys()];
  if (hasEstimates) {
    for (const date of estimatedByDay.keys()) {
      if (!scoreMap.has(date)) allDataDates.push(date);
    }
  }
  allDataDates.sort();

  if (allDataDates.length === 0) {
    chartEl.classList.remove('visible');
    return;
  }

  const maxScore = Math.max(
    ...data.map((d) => d[1]),
    ...(hasEstimates ? [...estimatedByDay.values()] : []),
    0.1,
  );
  const chartHeight = 39;

  // Expand range: 1st of earliest month → today (all local time)
  const todayKey = dateKeyFromTimestamp(Date.now());
  const firstKey = allDataDates[0];
  const lastKey =
    allDataDates[allDataDates.length - 1] > todayKey
      ? allDataDates[allDataDates.length - 1]
      : todayKey;
  const firstParts = firstKey.split('-').map(Number);
  const rangeStart = new Date(firstParts[0], firstParts[1] - 1, 1); // 1st of earliest local month
  const lastParts = lastKey.split('-').map(Number);
  const lastDate = new Date(lastParts[0], lastParts[1] - 1, lastParts[2]);

  const days = [];
  const months = []; // { label, dayIndex }
  let prevMonth = null;
  for (
    let d = new Date(rangeStart);
    d <= lastDate;
    d.setDate(d.getDate() + 1)
  ) {
    const dateStr = dateKeyFromTimestamp(d.getTime());
    const month = dateStr.slice(0, 7);
    if (month !== prevMonth) {
      months.push({ label: month, dayIndex: days.length });
      prevMonth = month;
    }
    days.push(dateStr);
  }

  // Bars row
  const daySlotPx = 11; // 10px bar + 1px gap
  const barsHtml = days
    .map((dateStr) => {
      const score = scoreMap.get(dateStr);
      const estScore = hasEstimates ? estimatedByDay.get(dateStr) : undefined;
      const effectiveScore = score ?? estScore;
      if (effectiveScore != null) {
        // sqrt scaling + 5px floor: low-count bars stay clickable while preserving relative proportions
        const barH =
          Math.round(Math.sqrt(effectiveScore / maxScore) * chartHeight) + 5;
        return `<div class="chart-bar-group has-data" data-date="${dateStr}"><div class="chart-bar" style="height:${barH}px"></div></div>`;
      }
      return `<div class="chart-bar-group" data-date="${dateStr}"></div>`;
    })
    .join('');

  // Axis row
  const totalBarWidth = days.length * daySlotPx - 1;
  const axisHtml = months
    .map(
      (m) =>
        `<span class="chart-month" style="left:${m.dayIndex * daySlotPx}px">${m.label}</span>`,
    )
    .join('');

  // Compute min-width: max(bar total, rightmost label end)
  // Label ~45px wide; last label starts at its dayIndex * daySlotPx
  const lastLabel = months[months.length - 1];
  const labelEnd = lastLabel ? lastLabel.dayIndex * daySlotPx + 45 : 0;
  const contentWidth = Math.max(totalBarWidth, labelEnd);

  barsEl.innerHTML = `<div class="chart-content" style="min-width:${contentWidth}px">
    <div class="chart-bars-row">${barsHtml}</div>
    <div class="chart-axis">${axisHtml}</div>
  </div>`;

  chartEl.classList.add('visible');
  restoreChartActiveDates(chartEl);

  // Scroll to the right (most recent bars) after render
  requestAnimationFrame(() => {
    barsEl.scrollLeft = barsEl.scrollWidth;
  });
}

export function renderTimeChart(entries, estimatedByDay) {
  renderTimeChartInto(
    document.getElementById('timeChart'),
    document.getElementById('chartBars'),
    entries,
    'Visits over time',
    estimatedByDay,
  );
  bindChartBarClick(
    document.getElementById('timeChart'),
    document.getElementById('results'),
  );
}

// Chart tooltip handler (shared for both charts)
function bindChartTooltip(chartEl) {
  const barsEl = chartEl.querySelector('.chart-bars');
  const tooltip = chartEl.querySelector('.chart-tooltip');
  barsEl.addEventListener('mouseover', (e) => {
    const group = e.target.closest('.chart-bar-group.has-data');
    if (!group) {
      tooltip.style.display = 'none';
      return;
    }
    tooltip.textContent = group.dataset.date;
    tooltip.style.display = 'block';
    const rect = group.getBoundingClientRect();
    const chartRect = chartEl.getBoundingClientRect();
    tooltip.style.left =
      rect.left -
      chartRect.left +
      rect.width / 2 -
      tooltip.offsetWidth / 2 +
      'px';
    tooltip.style.top = rect.top - chartRect.top - 22 + 'px';
  });
  barsEl.addEventListener('mouseout', () => {
    tooltip.style.display = 'none';
  });
}

// Chart ↔ Results mapping: chartBarsId → resultsContainerId
const chartResultsPairs = [
  ['chartBars', 'results'],
  ['relatedChartBars', 'relatedResults'],
];

function collectActiveDates(chartEl) {
  const activeDates = new Set();
  chartEl
    .querySelectorAll('.chart-bar-group.active')
    .forEach((g) => activeDates.add(g.dataset.date));
  return activeDates;
}

function restoreChartActiveDates(chartEl) {
  const activeDates = chartEl._activeDates;
  if (!(activeDates instanceof Set)) return;
  chartEl.querySelectorAll('.chart-bar-group').forEach((group) => {
    group.classList.toggle('active', activeDates.has(group.dataset.date));
  });
}

export function syncChartHighlights() {
  for (const [barsId, containerId] of chartResultsPairs) {
    const barsEl = document.getElementById(barsId);
    const container = document.getElementById(containerId);
    if (!barsEl || !container) continue;

    // Collect dates from selected rows
    const selectedDates = new Set();
    container.querySelectorAll('.result-row.selected').forEach((row) => {
      const d = row.dataset.dates;
      if (d) d.split(',').forEach((date) => selectedDates.add(date));
    });

    // Toggle highlighted class on chart bars
    barsEl.querySelectorAll('.chart-bar-group').forEach((group) => {
      const bar = group.querySelector('.chart-bar');
      if (bar)
        bar.classList.toggle(
          'highlighted',
          selectedDates.has(group.dataset.date),
        );
    });
  }
}

export function applyDateFilter(chartEl, resultsContainer) {
  restoreChartActiveDates(chartEl);
  const activeDates = collectActiveDates(chartEl);
  const hasFilter = activeDates.size > 0;

  // For virtual-scrolled containers, filter at the data level
  const vs = resultsContainer._virtualScroller;
  if (vs) {
    if (!hasFilter) {
      vs.applyFilter(null);
    } else {
      vs.applyFilter((item) => {
        const ts = item.timestamps || [];
        return ts.some((t) =>
          activeDates.has(new Date(t).toISOString().slice(0, 10)),
        );
      });
    }
    return;
  }

  // Non-virtual containers: hide/show DOM nodes directly
  resultsContainer.querySelectorAll('.result-item').forEach((item) => {
    const row = item.querySelector('.result-row');
    if (!row) return;
    if (!hasFilter) {
      item.style.display = '';
      return;
    }
    const rowDates = row.dataset.dates ? row.dataset.dates.split(',') : [];
    const match = rowDates.some((d) => activeDates.has(d));
    item.style.display = match ? '' : 'none';
  });
}

export function bindChartBarClick(chartEl, resultsContainer) {
  const barsEl = chartEl.querySelector('.chart-bars');
  if (!barsEl || barsEl._chartClickBound) return;
  barsEl._chartClickBound = true;
  barsEl.addEventListener('click', async (e) => {
    const bar = e.target.closest('.chart-bar');
    if (!bar) return;
    const group = bar.closest('.chart-bar-group');
    if (!group) return;
    group.classList.toggle('active');
    const activeDates = collectActiveDates(chartEl);
    chartEl._activeDates = activeDates;
    const selectionToken = Symbol('chart-date-selection');
    chartEl._dateSelectionToken = selectionToken;

    // Notify about selected dates for demand loading before applying the data-level filter.
    if (chartEl._onDateSelect) {
      await chartEl._onDateSelect(new Set(activeDates));
    }
    if (chartEl._dateSelectionToken !== selectionToken) return;
    applyDateFilter(chartEl, resultsContainer);
    syncChartHighlights();
  });
  // Click anywhere in chart that isn't a bar clears all active selections
  if (!chartEl._chartBgClickBound) {
    chartEl._chartBgClickBound = true;
    chartEl.addEventListener('click', async (e) => {
      if (e.target.closest('.chart-bar')) return;
      chartEl
        .querySelectorAll('.chart-bar-group.active')
        .forEach((g) => g.classList.remove('active'));
      chartEl._activeDates = new Set();
      const selectionToken = Symbol('chart-date-selection');
      chartEl._dateSelectionToken = selectionToken;
      if (chartEl._onDateSelect) {
        await chartEl._onDateSelect(new Set());
      }
      if (chartEl._dateSelectionToken !== selectionToken) return;
      applyDateFilter(chartEl, resultsContainer);
      syncChartHighlights();
    });
  }
}

// Initialize chart tooltips — call once at module load
export function initCharts() {
  bindChartTooltip(document.getElementById('timeChart'));
  bindChartTooltip(document.getElementById('relatedChart'));
}
