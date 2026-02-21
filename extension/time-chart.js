// Time chart — rendering, tooltips, bar click filtering, and highlight sync

function aggregateVisitsByDay(interactions) {
  const byDay = new Map();
  for (const i of interactions) {
    const dayKey = new Date(i.timestamp).toISOString().slice(0, 10);
    const prev = byDay.get(dayKey) || 0;
    byDay.set(dayKey, prev + 1); // count visits per day
  }
  // Sort by date
  const entries = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return entries; // [[dateStr, count], ...]
}

export function renderTimeChartInto(chartEl, barsEl, interactions, label) {
  if (label !== undefined) {
    const labelEl = chartEl.querySelector('.chart-label');
    if (labelEl) labelEl.textContent = label;
  }

  if (!interactions || interactions.length === 0) {
    chartEl.classList.remove('visible');
    return;
  }

  const data = aggregateVisitsByDay(interactions);
  if (data.length === 0) {
    chartEl.classList.remove('visible');
    return;
  }

  const scoreMap = new Map(data);
  const maxScore = Math.max(...data.map(d => d[1]), 0.1);
  const chartHeight = 44;

  // Expand range: 1st of earliest UTC month → last data day (all UTC)
  const firstDate = new Date(data[0][0] + 'T00:00:00Z');
  const lastDate = new Date(data[data.length - 1][0] + 'T00:00:00Z');
  const rangeStart = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth(), 1));

  const days = [];
  const months = []; // { label, dayIndex }
  let prevMonth = null;
  for (let d = new Date(rangeStart); d <= lastDate; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const month = dateStr.slice(0, 7);
    if (month !== prevMonth) {
      months.push({ label: month, dayIndex: days.length });
      prevMonth = month;
    }
    days.push(dateStr);
  }

  // Bars row
  const daySlotPx = 11; // 10px bar + 1px gap
  const barsHtml = days.map(dateStr => {
    const score = scoreMap.get(dateStr);
    if (score != null) {
      const barH = Math.max(2, Math.round((score / maxScore) * chartHeight));
      return `<div class="chart-bar-group has-data" data-date="${dateStr}" data-score="${score.toFixed(1)}"><div class="chart-bar" style="height:${barH}px"></div></div>`;
    }
    return `<div class="chart-bar-group" data-date="${dateStr}"></div>`;
  }).join('');

  // Axis row
  const totalBarWidth = days.length * daySlotPx - 1;
  const axisHtml = months.map(m =>
    `<span class="chart-month" style="left:${m.dayIndex * daySlotPx}px">${m.label}</span>`
  ).join('');

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
}

export function renderTimeChart(interactions) {
  renderTimeChartInto(
    document.getElementById('timeChart'),
    document.getElementById('chartBars'),
    interactions,
    'Visits over time'
  );
  bindChartBarClick(document.getElementById('timeChart'), document.getElementById('results'));
}

// Chart tooltip handler (shared for both charts)
function bindChartTooltip(chartEl) {
  const barsEl = chartEl.querySelector('.chart-bars');
  const tooltip = chartEl.querySelector('.chart-tooltip');
  barsEl.addEventListener('mouseover', (e) => {
    const group = e.target.closest('.chart-bar-group.has-data');
    if (!group) { tooltip.style.display = 'none'; return; }
    const count = Math.round(parseFloat(group.dataset.score));
    const visits = count === 1 ? 'visit' : 'visits';
    tooltip.textContent = `${group.dataset.date}: ${count} ${visits}`;
    tooltip.style.display = 'block';
    const rect = group.getBoundingClientRect();
    const chartRect = chartEl.getBoundingClientRect();
    tooltip.style.left = (rect.left - chartRect.left + rect.width / 2 - tooltip.offsetWidth / 2) + 'px';
    tooltip.style.top = (rect.top - chartRect.top - 22) + 'px';
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

export function syncChartHighlights() {
  for (const [barsId, containerId] of chartResultsPairs) {
    const barsEl = document.getElementById(barsId);
    const container = document.getElementById(containerId);
    if (!barsEl || !container) continue;

    // Collect dates from selected rows
    const selectedDates = new Set();
    container.querySelectorAll('.result-row.selected').forEach(row => {
      const d = row.dataset.dates;
      if (d) d.split(',').forEach(date => selectedDates.add(date));
    });

    // Toggle highlighted class on chart bars
    barsEl.querySelectorAll('.chart-bar-group').forEach(group => {
      const bar = group.querySelector('.chart-bar');
      if (bar) bar.classList.toggle('highlighted', selectedDates.has(group.dataset.date));
    });
  }
}

export function applyDateFilter(chartEl, resultsContainer) {
  const activeDates = new Set();
  chartEl.querySelectorAll('.chart-bar-group.active').forEach(g => activeDates.add(g.dataset.date));
  const hasFilter = activeDates.size > 0;

  // For virtual-scrolled containers, filter at the data level
  const vs = resultsContainer._virtualScroller;
  if (vs) {
    if (!hasFilter) {
      vs.applyFilter(null);
    } else {
      vs.applyFilter(item => {
        const ts = item.timestamps || [];
        return ts.some(t => activeDates.has(new Date(t).toISOString().slice(0, 10)));
      });
    }
    return;
  }

  // Non-virtual containers: hide/show DOM nodes directly
  resultsContainer.querySelectorAll('.result-item').forEach(item => {
    const row = item.querySelector('.result-row');
    if (!row) return;
    if (!hasFilter) { item.style.display = ''; return; }
    const rowDates = row.dataset.dates ? row.dataset.dates.split(',') : [];
    const match = rowDates.some(d => activeDates.has(d));
    item.style.display = match ? '' : 'none';
  });
}

export function bindChartBarClick(chartEl, resultsContainer) {
  const barsEl = chartEl.querySelector('.chart-bars');
  if (!barsEl || barsEl._chartClickBound) return;
  barsEl._chartClickBound = true;
  barsEl.addEventListener('click', (e) => {
    const bar = e.target.closest('.chart-bar');
    if (!bar) return;
    const group = bar.closest('.chart-bar-group');
    if (group) group.classList.toggle('active');
    applyDateFilter(chartEl, resultsContainer);
    syncChartHighlights();
  });
  // Click anywhere in chart that isn't a bar clears all active selections
  if (!chartEl._chartBgClickBound) {
    chartEl._chartBgClickBound = true;
    chartEl.addEventListener('click', (e) => {
      if (e.target.closest('.chart-bar')) return;
      chartEl.querySelectorAll('.chart-bar-group.active').forEach(g => g.classList.remove('active'));
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
