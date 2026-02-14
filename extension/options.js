// Options page for Portal extension
// Bookmark-manager style UI with sidebar navigation, search, and settings modal
import { FileSystemStorage } from './filesystem-storage.js';
import init, { Interaction, SearchEngine } from './pkg/portal_extension.js';
import { mergeBufferIntoInteractions, buildInteractionsForEngine } from './search-helpers.js';
import { generateSlugFromUrl } from './utils.js';

const fsStorage = new FileSystemStorage();

// --- State ---
let currentSortState = { column: null, direction: null };
let pinnedSortState = { column: null, direction: null };
let relatedSortState = { column: null, direction: null };
let currentExtraColumns = [];
let pinnedExtraColumns = [];
let relatedExtraColumns = [];
let wasmInitialized = false;
let cachedData = null; // { interactions, contentMap }
let activeView = { type: 'category', value: 'all' }; // or { type: 'search', query: '...' } or { type: 'collection', query: '...', id: '...' } or { type: 'explore', query: '...', filter: '...' }
let allCollectionPins = {}; // collectionId -> [{ url, title, pinnedAt }]
let recycleBin = []; // [{ url, title, deletedAt }] — global recycle bin
let permanentDeletes = []; // [url, ...] — permanently deleted URLs
let lastClickedRow = null; // for shift-click range select
let marqueeActive = false; // suppress click during marquee drag
let gatewayDomainsCache = {}; // { [origin]: { rootUrl, childUrls, fetched } }
let pendingPin = null; // { query, qbTree? } — set during pin naming mode
let pinnedFilterCtx = null; // cached context for related recalculation on date filter

// --- Query builder state ---
let qbNodeIdCounter = 0;
let qbRoot = null;        // tree root (null = empty)
let qbMode = 'normal';    // 'normal' | 'professional'
let cachedAllHighlights = null; // slug → highlights[], lazy-loaded
let qbDebounceTimer = null;
let savedExploreQbRoot = null;  // saved global explore QB state when viewing a collection
let savedExploreQbMode = null;

const KEYWORD_FIELDS = ['title', 'url', 'captures', 'highlights', 'notes'];
const KEYWORD_FIELD_LABELS = { title: 'Title', url: 'URL', captures: 'Captures', highlights: 'Highlights', notes: 'Notes' };

function normalizeFieldToArray(field) {
  if (!field || field === 'any') return [...KEYWORD_FIELDS];
  if (Array.isArray(field)) return field;
  return [field];
}

// Range filter field configs: fallback min/max/step, format for labels
const RANGE_CONFIGS = {
  lastVisit:  { min: 0, max: 365, step: 1, format: v => v === 0 ? 'today' : v + 'd ago', isDaysAgo: true },
  firstVisit: { min: 0, max: 365, step: 1, format: v => v === 0 ? 'today' : v + 'd ago', isDaysAgo: true },
  visitCount: { min: 1, max: 100, step: 1, format: v => String(v) },
  timeOnPage: { min: 0, max: 600, step: 5, format: v => v >= 60 ? Math.floor(v/60) + 'm' + (v%60 ? v%60 + 's' : '') : v + 's' },
  scrollDepth:{ min: 0, max: 100, step: 1, format: v => v + '%' },
  clicks:     { min: 0, max: 100, step: 1, format: v => String(v) },
};
let cachedFieldRanges = null; // { field: { min, max } } — computed from data

// Compute actual data ranges for each range field (lightweight scan)
function computeFieldRanges(interactions) {
  const byUrl = new Map();
  for (const i of interactions) {
    if (!byUrl.has(i.url)) byUrl.set(i.url, []);
    byUrl.get(i.url).push(i);
  }
  const ranges = {};
  for (const key of Object.keys(RANGE_CONFIGS)) {
    ranges[key] = { min: Infinity, max: -Infinity };
  }
  for (const [, group] of byUrl) {
    const timestamps = group.map(i => i.timestamp);
    const lastVisit = (Date.now() - Math.max(...timestamps)) / 86400000;
    const firstVisit = (Date.now() - Math.min(...timestamps)) / 86400000;
    const visitCount = group.length;
    const latest = group.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    const att = parseAttention(latest);
    const vals = {
      lastVisit, firstVisit, visitCount,
      timeOnPage: att?.timeOnPage || 0,
      scrollDepth: att?.scrollDepth || 0,
      clicks: att?.clicks || 0,
    };
    for (const [key, v] of Object.entries(vals)) {
      if (v < ranges[key].min) ranges[key].min = v;
      if (v > ranges[key].max) ranges[key].max = v;
    }
  }
  // Round and ensure min < max
  for (const [field, r] of Object.entries(ranges)) {
    const step = RANGE_CONFIGS[field].step;
    r.min = Math.floor(r.min / step) * step;
    r.max = Math.ceil(r.max / step) * step;
    if (r.min >= r.max) r.max = r.min + step;
  }
  return ranges;
}

function getFieldRanges() {
  if (cachedFieldRanges) return cachedFieldRanges;
  if (!cachedData) return null;
  cachedFieldRanges = computeFieldRanges(cachedData.interactions);
  return cachedFieldRanges;
}

// Get effective min/max for a range field: data-driven if available, else static fallback
function getRangeConfig(field) {
  const cfg = RANGE_CONFIGS[field];
  const dataRanges = getFieldRanges();
  const dr = dataRanges?.[field];
  return {
    ...cfg,
    min: dr ? dr.min : cfg.min,
    max: dr ? dr.max : cfg.max,
  };
}

// Node constructors
function qbCreatePredicate(predicateType, config = {}) {
  return { id: ++qbNodeIdCounter, type: 'predicate', predicateType, ...config };
}
function qbCreateOperator(op, children) {
  return { id: ++qbNodeIdCounter, type: 'operator', op, children };
}
function qbCreatePlaceholder() {
  return { id: ++qbNodeIdCounter, type: 'predicate', predicateType: 'keyword', field: [...KEYWORD_FIELDS], value: '' };
}

// --- WASM ---
async function initWasm() {
  if (!wasmInitialized) {
    try {
      await init();
      wasmInitialized = true;
    } catch (error) {
      console.error('WASM init failed:', error);
    }
  }
}

// --- Data loading ---
async function loadData() {
  let allInteractions = [];
  let contentMap = {};

  try {
    const response = await chrome.runtime.sendMessage({ action: 'loadInteractions' });
    if (response && response.success) {
      allInteractions = response.interactions || [];
    }
  } catch (error) {
    console.log('Filesystem not available:', error.message);
  }

  try {
    const contentResponse = await chrome.runtime.sendMessage({ action: 'loadAllContent' });
    if (contentResponse && contentResponse.success) {
      contentMap = contentResponse.contentMap || {};
    }
  } catch (error) {
    console.log('Could not load content:', error.message);
  }

  const result = await chrome.storage.local.get(['writeBuffer']);
  const buffer = result.writeBuffer || [];
  if (buffer.length > 0) {
    ({ interactions: allInteractions, contentMap } =
      mergeBufferIntoInteractions(allInteractions, buffer, contentMap));
  }

  cachedData = { interactions: allInteractions, contentMap };
  return cachedData;
}

// --- Collection pins (filesystem) ---
async function loadAllCollectionPins() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'loadCollectionPins' });
    if (response && response.success) {
      allCollectionPins = response.pins || {};
    }
  } catch (error) {
    console.log('Could not load collection pins:', error.message);
  }
  return allCollectionPins;
}

async function saveAllCollectionPins() {
  try {
    await chrome.runtime.sendMessage({ action: 'saveCollectionPins', pins: allCollectionPins });
  } catch (error) {
    console.log('Could not save collection pins:', error.message);
  }
}

function isResultPinned(collectionId, url) {
  const pins = allCollectionPins[collectionId] || [];
  return pins.some(p => p.url === url);
}

async function toggleResultPin(collectionId, url, title) {
  if (!allCollectionPins[collectionId]) allCollectionPins[collectionId] = [];
  const pins = allCollectionPins[collectionId];
  const idx = pins.findIndex(p => p.url === url);
  if (idx !== -1) {
    pins.splice(idx, 1);
  } else {
    pins.push({ url, title, pinnedAt: Date.now() });
  }
  await saveAllCollectionPins();
}

// --- Recycle bin ---
// Global recycle bin: { url, title, deletedAt }
// Permanent deletes: URLs that are gone forever

async function loadRecycleBin() {
  const result = await chrome.storage.local.get(['recycleBin', 'permanentDeletes']);
  recycleBin = result.recycleBin || [];
  permanentDeletes = result.permanentDeletes || [];
  return recycleBin;
}

async function saveRecycleBin() {
  await chrome.storage.local.set({ recycleBin, permanentDeletes });
  updateRecycleSidebarCount();
}

function isRecycled(url) {
  return recycleBin.some(item => item.url === url);
}

function isPermanentlyDeleted(url) {
  return permanentDeletes.includes(url);
}

async function recycleItem(url, title) {
  if (isRecycled(url)) return;
  recycleBin.push({ url, title, deletedAt: Date.now() });
  await saveRecycleBin();
}

async function restoreItem(url) {
  recycleBin = recycleBin.filter(item => item.url !== url);
  await saveRecycleBin();
}

async function permanentlyDeleteItem(url) {
  recycleBin = recycleBin.filter(item => item.url !== url);
  if (!permanentDeletes.includes(url)) permanentDeletes.push(url);
  await saveRecycleBin();
}

function updateRecycleSidebarCount() {
  const el = document.getElementById('recycleSidebarCount');
  el.textContent = recycleBin.length > 0 ? recycleBin.length : '';
}

document.getElementById('restoreAllBtn').addEventListener('click', async () => {
  if (recycleBin.length === 0) return;
  recycleBin = [];
  await saveRecycleBin();
  lastClickedRow = null;
  showCategory('recycleBin');
});

document.getElementById('deleteAllBtn').addEventListener('click', async () => {
  if (recycleBin.length === 0) return;
  for (const item of recycleBin) {
    if (!permanentDeletes.includes(item.url)) permanentDeletes.push(item.url);
  }
  recycleBin = [];
  await saveRecycleBin();
  lastClickedRow = null;
  showCategory('recycleBin');
});

// --- Layout switching (collection vs normal) ---
function showCollectionLayout() {
  saveExploreQbState();
  document.getElementById('attentionChart').classList.remove('visible');
  document.getElementById('attentionChartSecondary').classList.remove('visible');
  document.getElementById('resultsWrapper').style.display = 'none';
  document.getElementById('collectionLayout').classList.add('visible');
  document.getElementById('queryBuilder').style.display = 'none';
}

function showNormalLayout() {
  document.getElementById('resultsWrapper').style.display = '';
  document.getElementById('collectionLayout').classList.remove('visible');
  restoreExploreQbState();
}

function saveExploreQbState() {
  if (savedExploreQbRoot === null) {
    savedExploreQbRoot = qbRoot;
    savedExploreQbMode = qbMode;
  }
}

function restoreExploreQbState() {
  if (savedExploreQbRoot !== null) {
    qbRoot = savedExploreQbRoot;
    qbMode = savedExploreQbMode;
    savedExploreQbRoot = null;
    savedExploreQbMode = null;
  }
}

// --- Sort helpers ---
function getSortState(context) {
  if (context === 'pinned') return pinnedSortState;
  if (context === 'related') return relatedSortState;
  return currentSortState;
}

function setSortState(context, state) {
  if (context === 'pinned') pinnedSortState = state;
  else if (context === 'related') relatedSortState = state;
  else currentSortState = state;
}

function getExtraColumns(context) {
  if (context === 'pinned') return pinnedExtraColumns;
  if (context === 'related') return relatedExtraColumns;
  return currentExtraColumns;
}

function setExtraColumns(context, cols) {
  if (context === 'pinned') pinnedExtraColumns = cols;
  else if (context === 'related') relatedExtraColumns = cols;
  else currentExtraColumns = cols;
}

function getAvailableExtras(context) {
  if (context === 'pinned') return ['firstVisit', 'pinTime'];
  return ['firstVisit'];
}

const COLUMN_LABELS = {
  title: 'Title',
  relevance: 'Rel',
  lastVisit: 'Last Visit',
  firstVisit: 'First Visit',
  attention: 'Att',
  pinTime: 'Pin Time'
};

function applySortOrder(items, sortState) {
  if (!sortState || !sortState.column) return items;
  const { column, direction } = sortState;
  const dir = direction === 'asc' ? 1 : -1;

  return [...items].sort((a, b) => {
    let av, bv;
    switch (column) {
      case 'title':
        av = (a.title || '').toLowerCase();
        bv = (b.title || '').toLowerCase();
        return dir * av.localeCompare(bv);
      case 'lastVisit':
        av = Math.max(...(a.timestamps || [a.latestTs || 0]));
        bv = Math.max(...(b.timestamps || [b.latestTs || 0]));
        return dir * (av - bv);
      case 'firstVisit':
        av = Math.min(...(a.timestamps || [a.latestTs || 0]));
        bv = Math.min(...(b.timestamps || [b.latestTs || 0]));
        return dir * (av - bv);
      case 'attention':
        av = a.attScore || 0;
        bv = b.attScore || 0;
        return dir * (av - bv);
      case 'pinTime':
        av = a.pinnedAt || 0;
        bv = b.pinnedAt || 0;
        return dir * (av - bv);
      case 'relevance':
        av = a.relevance || 0;
        bv = b.relevance || 0;
        return dir * (av - bv);
      default:
        return 0;
    }
  });
}

// --- Column headers ---
function columnHeaderHtml(context, opts = {}) {
  const sortState = getSortState(context);
  const extraCols = getExtraColumns(context);
  const { hasDelete = true, hasPin = false, showRelevance = false } = opts;

  function arrow(col) {
    if (sortState.column !== col) return '';
    return sortState.direction === 'desc' ? ' \u25BC' : ' \u25B2';
  }

  function activeClass(col) {
    return sortState.column === col ? ' active-sort' : '';
  }

  let html = `<div class="column-header-row" data-context="${context}">`;
  html += `<div class="col-spacer"></div>`;
  html += `<div class="col-header col-title${activeClass('title')}" data-col="title">${COLUMN_LABELS.title}${arrow('title')}</div>`;

  if (showRelevance) {
    html += `<div class="col-header col-rel${activeClass('relevance')}" data-col="relevance">${COLUMN_LABELS.relevance}${arrow('relevance')}</div>`;
  }

  html += `<div class="col-header col-time${activeClass('lastVisit')}" data-col="lastVisit">${COLUMN_LABELS.lastVisit}${arrow('lastVisit')}</div>`;

  if (extraCols.includes('firstVisit')) {
    html += `<div class="col-header col-time${activeClass('firstVisit')}" data-col="firstVisit">${COLUMN_LABELS.firstVisit}${arrow('firstVisit')}</div>`;
  }

  html += `<div class="col-header col-att${activeClass('attention')}" data-col="attention">${COLUMN_LABELS.attention}${arrow('attention')}</div>`;

  if (extraCols.includes('pinTime')) {
    html += `<div class="col-header col-time${activeClass('pinTime')}" data-col="pinTime">${COLUMN_LABELS.pinTime}${arrow('pinTime')}</div>`;
  }

  const availableExtras = getAvailableExtras(context);
  if (availableExtras.length > 0) {
    html += `<button class="col-add-btn" data-context="${context}" title="Add columns">+</button>`;
  }

  if (hasDelete) html += `<div class="col-action-spacer"></div>`;
  if (hasPin) html += `<div class="col-action-spacer"></div>`;

  html += `</div>`;
  return html;
}

function bindColumnHeaderClicks(container) {
  container.querySelectorAll('.col-header').forEach(header => {
    header.addEventListener('click', () => {
      const col = header.dataset.col;
      const context = header.closest('.column-header-row').dataset.context;
      const sortState = getSortState(context);

      let newState;
      if (sortState.column === col) {
        if (sortState.direction === 'desc') {
          newState = { column: col, direction: 'asc' };
        } else {
          newState = { column: null, direction: null };
        }
      } else {
        newState = { column: col, direction: 'desc' };
      }

      setSortState(context, newState);
      refreshCurrentView();
    });
  });

  container.querySelectorAll('.col-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const context = btn.dataset.context;
      showColumnPopover(btn, context);
    });
  });
}

let activePopover = null;

function showColumnPopover(anchorBtn, context) {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }

  const availableExtras = getAvailableExtras(context);
  const currentExtras = getExtraColumns(context);

  const popover = document.createElement('div');
  popover.className = 'col-popover';

  for (const col of availableExtras) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = currentExtras.includes(col);
    checkbox.dataset.col = col;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(' ' + COLUMN_LABELS[col]));
    popover.appendChild(label);

    checkbox.addEventListener('change', () => {
      const extras = getExtraColumns(context);
      if (checkbox.checked) {
        if (!extras.includes(col)) extras.push(col);
      } else {
        const idx = extras.indexOf(col);
        if (idx !== -1) extras.splice(idx, 1);
        const st = getSortState(context);
        if (st.column === col) {
          setSortState(context, { column: null, direction: null });
        }
      }
      setExtraColumns(context, extras);
      popover.remove();
      activePopover = null;
      refreshCurrentView();
    });
  }

  const rect = anchorBtn.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.top = (rect.bottom + 4) + 'px';
  popover.style.right = (window.innerWidth - rect.right) + 'px';

  document.body.appendChild(popover);
  activePopover = popover;

  const closeHandler = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorBtn) {
      popover.remove();
      activePopover = null;
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

function isDeletableView() {
  if (activeView.type === 'category' && activeView.value === 'recycleBin') return false;
  return true;
}

async function handleDelete(url, title) {
  await recycleItem(url, title);
}

function refreshCurrentView() {
  if (activeView.type === 'category') {
    showCategory(activeView.value);
  } else if (activeView.type === 'search' && activeView.query) {
    showSearch(activeView.query);
  } else if (activeView.type === 'collection' && activeView.query) {
    showCollection({ id: activeView.id, query: activeView.query, qbTree: activeView.qbTree, name: activeView.name });
  } else if (activeView.type === 'explore') {
    showExplore();
  }
}

// --- Category filters ---
function filterByCategory(interactions, category) {
  const now = Date.now();
  function isHidden(url) {
    return isPermanentlyDeleted(url) || isRecycled(url);
  }
  switch (category) {
    case 'today': {
      const startOfDay = new Date().setHours(0, 0, 0, 0);
      return interactions.filter(i => i.timestamp >= startOfDay && !isHidden(i.url));
    }
    case 'week': {
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      return interactions.filter(i => i.timestamp >= weekAgo && !isHidden(i.url));
    }
    case 'highlighted':
      return interactions.filter(i => i.attention && i.attention.length > 0 && !isHidden(i.url));
    case 'gateways':
      return interactions.filter(i => isGatewayUrl(i.url) && !isHidden(i.url));
    case 'recycleBin':
      return interactions.filter(i => isRecycled(i.url) && !isPermanentlyDeleted(i.url));
    case 'all':
    default:
      return interactions.filter(i => !isPermanentlyDeleted(i.url) && !isRecycled(i.url));
  }
}

async function loadGatewayDomains() {
  const result = await chrome.storage.local.get(['gatewayDomains']);
  gatewayDomainsCache = result.gatewayDomains || {};
}

function isGatewayUrl(url) {
  try {
    const parsed = new URL(url);
    // Domain registry: root URL with 2+ children
    const entry = gatewayDomainsCache[parsed.origin];
    if (entry && entry.rootUrl === url && entry.childUrls && entry.childUrls.length >= 2) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// --- Attention chart ---
function parseAttention(interaction) {
  if (!interaction.attention) return null;
  try {
    return typeof interaction.attention === 'string'
      ? JSON.parse(interaction.attention)
      : interaction.attention;
  } catch { return null; }
}

function attentionStrength(att) {
  // Composite score: weighted sum of normalized metrics
  let score = 0;
  if (att.timeOnPage) score += Math.min(att.timeOnPage / 60000, 10); // minutes, cap at 10
  if (att.scrollDepth) score += att.scrollDepth / 100 * 2; // 0-2
  if (att.clicks) score += Math.min(att.clicks, 20) / 5; // 0-4
  if (att.highlights && att.highlights.length) score += Math.min(att.highlights.length, 5); // 0-5
  return score;
}

function aggregateAttentionByDay(interactions) {
  const byDay = new Map();
  for (const i of interactions) {
    const att = parseAttention(i);
    const dayKey = new Date(i.timestamp).toISOString().slice(0, 10);
    const prev = byDay.get(dayKey) || 0;
    byDay.set(dayKey, prev + (att ? attentionStrength(att) : 0.1)); // minimal presence even without attention
  }
  // Sort by date
  const entries = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return entries; // [[dateStr, score], ...]
}

function renderAttentionChartInto(chartEl, barsEl, interactions, label) {
  if (label !== undefined) {
    const labelEl = chartEl.querySelector('.chart-label');
    if (labelEl) labelEl.textContent = label;
  }

  if (!interactions || interactions.length === 0) {
    chartEl.classList.remove('visible');
    return;
  }

  const data = aggregateAttentionByDay(interactions);
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

function renderAttentionChart(interactions) {
  document.getElementById('attentionChartSecondary').classList.remove('visible');
  renderAttentionChartInto(
    document.getElementById('attentionChart'),
    document.getElementById('chartBars'),
    interactions,
    'Attention over time'
  );
  bindChartBarClick(document.getElementById('attentionChart'), document.getElementById('results'));

}

// Chart tooltip handler (shared for both charts)
function bindChartTooltip(chartEl) {
  const barsEl = chartEl.querySelector('.chart-bars');
  const tooltip = chartEl.querySelector('.chart-tooltip');
  barsEl.addEventListener('mouseover', (e) => {
    const group = e.target.closest('.chart-bar-group.has-data');
    if (!group) { tooltip.style.display = 'none'; return; }
    tooltip.textContent = `${group.dataset.date}: ${group.dataset.score}`;
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

bindChartTooltip(document.getElementById('attentionChart'));
bindChartTooltip(document.getElementById('attentionChartSecondary'));
bindChartTooltip(document.getElementById('pinnedChart'));
bindChartTooltip(document.getElementById('relatedChart'));

// Chart ↔ Results mapping: chartBarsId → resultsContainerId
const chartResultsPairs = [
  ['chartBars', 'results'],
  ['pinnedChartBars', 'pinnedResults'],
  ['relatedChartBars', 'relatedResults'],
];

function syncChartHighlights() {
  for (const [barsId, containerId] of chartResultsPairs) {
    const barsEl = document.getElementById(barsId);
    const container = document.getElementById(containerId);
    if (!barsEl || !container) continue;

    // Collect dates from selected rows (exclude related results from pinned chart)
    const selectedDates = new Set();
    container.querySelectorAll('.result-row.selected').forEach(row => {
      if (row.closest('.result-item.related-result')) return;
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

function applyDateFilter(chartEl, resultsContainer) {
  const activeDates = new Set();
  chartEl.querySelectorAll('.chart-bar-group.active').forEach(g => activeDates.add(g.dataset.date));
  const hasFilter = activeDates.size > 0;

  resultsContainer.querySelectorAll('.result-item').forEach(item => {
    // Skip related results and gaps — date filter only applies to pinned/primary results
    if (item.classList.contains('related-result')) return;
    const row = item.querySelector('.result-row');
    if (!row) return;
    if (!hasFilter) { item.style.display = ''; return; }
    const rowDates = row.dataset.dates ? row.dataset.dates.split(',') : [];
    const match = rowDates.some(d => activeDates.has(d));
    item.style.display = match ? '' : 'none';
  });

  // Recalculate related results when filtering pinned section
  if (resultsContainer.id === 'pinnedResults') {
    recalculateRelatedResults();
  }
}

function bindChartBarClick(chartEl, resultsContainer) {
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


function renderAttentionChartForResults(results, allInteractions) {
  document.getElementById('attentionChartSecondary').classList.remove('visible');
  if (!results || results.length === 0) {
    document.getElementById('attentionChart').classList.remove('visible');
    return;
  }
  // Map result URLs to source interactions for attention data
  const urlSet = new Set(results.map(r => r.url));
  const matched = allInteractions.filter(i => urlSet.has(i.url));
  renderAttentionChart(matched);
}

function renderCollectionAttentionCharts(pinnedUrls, unpinnedUrls, allInteractions) {
  const pinnedMatched = allInteractions.filter(i => pinnedUrls.has(i.url));
  const unpinnedMatched = allInteractions.filter(i => unpinnedUrls.has(i.url));

  renderAttentionChartInto(
    document.getElementById('attentionChart'),
    document.getElementById('chartBars'),
    pinnedMatched,
    'Pinned pages'
  );
  renderAttentionChartInto(
    document.getElementById('attentionChartSecondary'),
    document.getElementById('chartBarsSecondary'),
    unpinnedMatched,
    'Other results'
  );
}

// --- Display ---
async function showCategory(category) {
  activeView = { type: 'category', value: category };
  updateSidebarActive();
  updateMainTitle(categoryLabel(category));
  document.getElementById('pinSearchBtn').style.display = 'none';
  document.getElementById('queryBuilder').style.display = 'none';
  showNormalLayout();

  if (category === 'gateways') await loadGatewayDomains();

  const data = cachedData || await loadData();
  const filtered = filterByCategory(data.interactions, category);
  if (category === 'recycleBin') {
    document.getElementById('attentionChart').classList.remove('visible');
    document.getElementById('attentionChartSecondary').classList.remove('visible');
    if (recycleBin.length > 0) {
      document.getElementById('restoreAllBtn').style.display = '';
      document.getElementById('deleteAllBtn').style.display = '';
    }
    displayRecycleBinRows(filtered);
  } else {
    renderAttentionChart(filtered);
    displayInteractionRows(filtered);
  }
}

async function showSearch(query) {
  if (!query.trim()) {
    showCategory(activeView.type === 'category' ? activeView.value : 'all');
    return;
  }

  activeView = { type: 'search', query };
  updateSidebarActive();
  updateMainTitle(`Search: ${query}`);
  document.getElementById('pinSearchBtn').style.display = 'flex';
  document.getElementById('queryBuilder').style.display = 'none';
  showNormalLayout();

  try {
    await initWasm();
    const data = cachedData || await loadData();

    if (data.interactions.length === 0) {
      displayMessage('No interactions recorded yet. Browse some pages first!');
      return;
    }

    const engine = new SearchEngine();
    buildInteractionsForEngine(Interaction, engine, data.interactions, data.contentMap);
    const results = await engine.search(query, 0);
    renderAttentionChartForResults(results, data.interactions);
    displaySearchResults(results);
  } catch (error) {
    console.error('Search error:', error);
    displayMessage('Error performing search: ' + error.message);
  }
}

// --- Query builder: Enrichment ---
function enrichForQuery(interactions, contentMap, highlightsMap) {
  const byUrl = groupInteractionsByUrl(interactions);
  return [...byUrl.entries()].map(([url, group]) => {
    const latest = group.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    const agg = aggregateAttention(group);
    const timestamps = group.map(i => i.timestamp);
    const slug = latest.slug;
    const content = (slug && contentMap[slug]) || '';
    const highlights = (slug && highlightsMap && highlightsMap[slug]) || [];
    const attParsed = parseAttention(latest);
    return {
      url, title: latest.title, slug, timestamps,
      attScore: agg.score, attDetail: agg.detail,
      content, highlights,
      visitCount: group.length,
      lastVisit: Math.max(...timestamps),
      firstVisit: Math.min(...timestamps),
      timeOnPage: attParsed?.timeOnPage || 0,
      scrollDepth: attParsed?.scrollDepth || 0,
      clicks: attParsed?.clicks || 0,
      intent: latest.intent || '',
    };
  });
}

// --- Seed-based related pages scoring ---
const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','up','about','into','over','after','is','are','was','were','be','been',
  'being','have','has','had','do','does','did','will','would','shall','should',
  'may','might','must','can','could','that','which','who','whom','this','these',
  'those','it','its','my','your','his','her','our','their','what','how','when',
  'where','why','not','no','nor','so','if','then','than','too','very','just',
  'also','now','here','there','all','each','every','both','few','more','most',
  'other','some','such','only','same','new','-','|','/'
]);

function titleWords(text) {
  if (!text) return new Set();
  return new Set(text.toLowerCase().split(/[\s\-_|/:.?!,;()\[\]{}]+/).filter(w => w.length > 1 && !STOP_WORDS.has(w)));
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scoreTemporalProximity(seedTimestamps, candTimestamps) {
  const seeds = seedTimestamps.slice(0, 10);
  const cands = candTimestamps.slice(0, 10);
  let minGap = Infinity;
  for (const s of seeds) for (const c of cands) minGap = Math.min(minGap, Math.abs(s - c));
  const ONE_HOUR = 3600000;
  const DAY = 86400000;
  if (minGap <= ONE_HOUR) return 1;
  if (minGap >= DAY) return 0;
  return 1 - (minGap - ONE_HOUR) / (DAY - ONE_HOUR);
}

function buildGatewayChildIndex(gatewayCache) {
  const index = new Map();
  for (const [origin, entry] of Object.entries(gatewayCache)) {
    if (!entry.childUrls) continue;
    for (const childUrl of entry.childUrls) {
      if (!index.has(childUrl)) index.set(childUrl, new Set());
      index.get(childUrl).add(origin);
    }
  }
  return index;
}

function findRelatedPages(seeds, candidates, gatewayCache) {
  if (seeds.length === 0) return [];
  const gwIndex = buildGatewayChildIndex(gatewayCache);
  const seedData = seeds.map(s => {
    let hostname = '', origin = '';
    try { const u = new URL(s.url); hostname = u.hostname; origin = u.origin; } catch {}
    return {
      hostname, origin,
      titleTokens: titleWords(s.title),
      intentTokens: titleWords(s.intent),
      timestamps: s.timestamps || [],
      gwOrigins: gwIndex.get(s.url) || new Set(),
    };
  });
  return candidates.map(cand => {
    let candHostname = '', candOrigin = '';
    try { const u = new URL(cand.url); candHostname = u.hostname; candOrigin = u.origin; } catch {}
    const candTitle = titleWords(cand.title);
    const candIntent = titleWords(cand.intent);
    const candTs = cand.timestamps || [];
    const candGw = gwIndex.get(cand.url) || new Set();
    let maxScore = 0;
    for (const seed of seedData) {
      let score = 0;
      if (candHostname && seed.hostname === candHostname) {
        score += 0.25;
        if (candOrigin === seed.origin) score += 0.10;
      }
      score += 0.25 * jaccardSimilarity(seed.titleTokens, candTitle);
      if (seed.timestamps.length > 0 && candTs.length > 0)
        score += 0.20 * scoreTemporalProximity(seed.timestamps, candTs);
      score += 0.15 * jaccardSimilarity(seed.intentTokens, candIntent);
      if (candGw.size > 0 && seed.gwOrigins.size > 0) {
        for (const o of candGw) { if (seed.gwOrigins.has(o)) { score += 0.15; break; } }
      }
      maxScore = Math.max(maxScore, score);
    }
    return { ...cand, relatedness: maxScore };
  }).filter(c => c.relatedness > 0).sort((a, b) => b.relatedness - a.relatedness).slice(0, 20);
}

// --- Query builder: Predicate matchers ---
function parseKeywordQuery(value) {
  const m = value.match(/^"(.+)"$/);
  if (m) return { q: m[1], exact: true };
  return { q: value, exact: false };
}

// TODO: Exact match (quoted) should use word-boundary matching instead of plain
// substring. Needs a robust approach that handles Unicode, punctuation-delimited
// words (URLs, hyphenated terms), and multi-word phrases.
function textMatches(text, q, exact) {
  if (!text) return false;
  if (exact) return text.includes(q);
  return text.toLowerCase().includes(q.toLowerCase());
}

function matchKeyword(item, field, value) {
  if (!value) return false;
  const { q, exact } = parseKeywordQuery(value);
  const fields = normalizeFieldToArray(field);
  if (fields.includes('title') && textMatches(item.title, q, exact)) return true;
  if (fields.includes('url') && textMatches(item.url, q, exact)) return true;
  if (fields.includes('captures') && textMatches(item.content, q, exact)) return true;
  if (fields.includes('highlights') && item.highlights.some(h => {
    const texts = Array.isArray(h.text) ? h.text : [h.text || ''];
    return texts.some(t => textMatches(t, q, exact));
  })) return true;
  if (fields.includes('notes') && item.highlights.some(h => textMatches(h.note, q, exact))) return true;
  return false;
}

function matchSmartFilter(item, filterName) {
  if (filterName === 'gateways') return isGatewayUrl(item.url);
  return false;
}

function matchRange(item, field, op, value, value2) {
  const cfg = RANGE_CONFIGS[field];
  let v = item[field] || 0;
  // For timestamp fields, convert to "days ago" to match slider units
  if (cfg?.isDaysAgo) {
    v = (Date.now() - v) / 86400000;
  }
  // Dual slider always uses between semantics
  if (value != null && value2 != null) return v >= value && v <= value2;
  // Legacy single-value fallback
  if (op === 'gt')  return v > value;
  if (op === 'lt')  return v < value;
  return false;
}

// --- Query builder: Tree evaluation ---
function isNodeConfigured(node) {
  if (!node) return false;
  if (node.type === 'operator') return node.children.some(c => isNodeConfigured(c));
  if (!node.predicateType) return false;
  if (node.predicateType === 'keyword') return !!(node.value && node.value.trim());
  return true;
}

function evaluateNode(node, item) {
  if (!isNodeConfigured(node)) return false;
  if (node.type === 'operator') {
    const configured = node.children.filter(c => isNodeConfigured(c));
    if (configured.length === 0) return false;
    if (node.op === 'OR')  return configured.some(c => evaluateNode(c, item));
    if (node.op === 'AND') return configured.every(c => evaluateNode(c, item));
  }
  // Leaf predicate
  let result = false;
  if (node.predicateType === 'keyword')     result = matchKeyword(item, node.field, node.value);
  else if (node.predicateType === 'smartFilter') result = matchSmartFilter(item, node.filter);
  else if (node.predicateType === 'range')       result = matchRange(item, node.field, node.op, node.value, node.value2);
  return node.negated ? !result : result;
}

// --- Query builder: Relevance scoring ---
function keywordRelevance(item, field, value) {
  if (!value) return 0;
  const { q, exact } = parseKeywordQuery(value);
  const fields = normalizeFieldToArray(field);
  let score = 0;
  if (fields.includes('title') && textMatches(item.title, q, exact)) score += 2.0;
  if (fields.includes('url') && textMatches(item.url, q, exact)) score += 1.0;
  if (fields.includes('captures') && textMatches(item.content, q, exact)) score += 1.0;
  if (fields.includes('highlights') && item.highlights.some(h => {
    const texts = Array.isArray(h.text) ? h.text : [h.text || ''];
    return texts.some(t => textMatches(t, q, exact));
  })) score += 1.5;
  if (fields.includes('notes') && item.highlights.some(h => textMatches(h.note, q, exact))) score += 1.5;
  return score;
}

function computeRelevance(node, item) {
  if (!node) return 0;
  if (node.type === 'operator') return node.children.reduce((sum, c) => sum + computeRelevance(c, item), 0);
  if (node.predicateType === 'keyword' && node.value) return keywordRelevance(item, node.field, node.value);
  return 0;
}

// --- Query builder: Tree helpers ---
function treeNeedsHighlights(node) {
  if (!node) return false;
  if (node.type === 'operator') return node.children.some(c => treeNeedsHighlights(c));
  if (node.predicateType === 'keyword') {
    const fields = normalizeFieldToArray(node.field);
    return fields.includes('highlights') || fields.includes('notes');
  }
  return false;
}

function treeHasKeyword(node) {
  if (!node) return false;
  if (node.type === 'operator') return node.children.some(c => treeHasKeyword(c));
  return node.predicateType === 'keyword' && !!node.value;
}

function treeHasConfiguredPredicate(node) {
  if (!node) return false;
  if (node.type === 'operator') return node.children.some(c => treeHasConfiguredPredicate(c));
  if (!node.predicateType) return false;
  if (node.predicateType === 'keyword') return !!(node.value && node.value.trim());
  return true;
}

// --- Query builder: Tree manipulation (n-ary operators) ---
function qbFindNode(root, id) {
  if (!root) return null;
  if (root.id === id) return { node: root, parent: null, childIndex: -1 };
  if (root.type === 'operator') {
    for (let i = 0; i < root.children.length; i++) {
      if (root.children[i].id === id) return { node: root.children[i], parent: root, childIndex: i };
    }
    for (let i = 0; i < root.children.length; i++) {
      const found = qbFindNode(root.children[i], id);
      if (found) return found;
    }
  }
  return null;
}

function qbInsertOnEdge(leafId, op) {
  const placeholder = qbCreatePlaceholder();
  if (!qbRoot || qbRoot.id === leafId) {
    // Root leaf — wrap in requested op
    qbRoot = qbCreateOperator(op, [qbRoot || placeholder, qbCreatePlaceholder()]);
    renderQueryBuilder();
    return;
  }
  const found = qbFindNode(qbRoot, leafId);
  if (!found || !found.parent) return;
  const parent = found.parent;
  if (parent.op === op) {
    // Same op as parent — add sibling next to this leaf
    parent.children.splice(found.childIndex + 1, 0, placeholder);
  } else {
    // Different op — wrap each in its own parent-op group:
    // e.g. "*" inside OR → AND(OR(leaf), OR(placeholder))
    const leafGroup = qbCreateOperator(parent.op, [found.node]);
    const phGroup = qbCreateOperator(parent.op, [placeholder]);
    const wrapper = qbCreateOperator(op, [leafGroup, phGroup]);
    parent.children[found.childIndex] = wrapper;
  }
  renderQueryBuilder();
}

// Add a new placeholder child to an existing operator node
function qbAddChild(nodeId) {
  const found = qbFindNode(qbRoot, nodeId);
  if (!found) return;
  const node = found.node;
  if (node.type !== 'operator') return;
  node.children.push(qbCreatePlaceholder());
  renderQueryBuilder();
}

function qbRemoveLeaf(nodeId) {
  if (!qbRoot) return;
  if (qbRoot.id === nodeId) {
    qbRoot = qbCreatePlaceholder();
    renderQueryBuilder();
    return;
  }
  const found = qbFindNode(qbRoot, nodeId);
  if (!found?.parent) return;
  found.parent.children.splice(found.childIndex, 1);
  // Cascade collapse: single-child → unwrap, empty → remove
  qbRoot = qbCollapseTree(qbRoot);
  if (!qbRoot) qbRoot = qbCreatePlaceholder(); // only at root level
  renderQueryBuilder();
}

// Recursively collapse operators: single-child → unwrap, empty → remove (null)
function qbCollapseTree(node) {
  if (!node || node.type !== 'operator') return node;
  node.children = node.children.map(c => qbCollapseTree(c)).filter(c => c !== null);
  if (node.children.length === 1) return node.children[0];
  if (node.children.length === 0) return null; // signal removal to parent
  return node;
}

// Flatten same-op nesting (e.g. OR(OR(A,B),C) → OR(A,B,C))
function qbFlattenSameOp(node) {
  if (!node || node.type !== 'operator') return node;
  node.children = node.children.map(c => qbFlattenSameOp(c));
  const newChildren = [];
  for (const child of node.children) {
    if (child.type === 'operator' && child.op === node.op) {
      newChildren.push(...child.children);
    } else {
      newChildren.push(child);
    }
  }
  node.children = newChildren;
  return node;
}

// Check if tree can be converted to normal mode (flat OR of predicates only)
function qbCanConvertToNormal(node) {
  if (!node) return true;
  if (node.type === 'predicate') return !node.negated;
  if (node.type === 'operator') {
    if (node.op !== 'OR') return false;
    return node.children.every(c => c.type === 'predicate' && !c.negated);
  }
  return false;
}

function qbUpdateNode(nodeId, updates) {
  const found = qbFindNode(qbRoot, nodeId);
  if (found) Object.assign(found.node, updates);
}

// Mode switching: predicates → flat OR tree, or tree → predicate list
function qbToTree(predicates) {
  if (predicates.length === 0) return qbCreatePlaceholder();
  if (predicates.length === 1) return predicates[0];
  return qbCreateOperator('OR', predicates);
}

function qbFlatten(node) {
  if (!node) return [];
  if (node.type === 'predicate') return [node];
  return node.children.flatMap(c => qbFlatten(c));
}

// --- Query builder: Query execution ---
async function runQuery() {
  const inCollection = activeView.type === 'collection';

  if (!qbRoot || (qbRoot.type === 'predicate' && qbRoot.predicateType === null) || !treeHasConfiguredPredicate(qbRoot)) {
    if (inCollection) {
      saveCollectionQbTree();
      const relatedContainer = document.getElementById('relatedResults');
      relatedContainer.innerHTML = '<div class="no-results">Add filters to start querying</div>';
      document.getElementById('relatedChart').classList.remove('visible');
    } else {
      displayMessage(!qbRoot || (qbRoot.type === 'predicate' && qbRoot.predicateType === null)
        ? 'Add filters to start querying' : 'Configure at least one filter');
    }
    return;
  }

  const data = cachedData || await loadData();

  // Lazy-load highlights if any keyword predicate targets highlights/notes/any
  if (treeNeedsHighlights(qbRoot) && !cachedAllHighlights) {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'loadAllHighlights' });
      cachedAllHighlights = (resp?.success) ? resp.highlightsMap : {};
    } catch { cachedAllHighlights = {}; }
  }
  await loadGatewayDomains();

  const enriched = enrichForQuery(data.interactions, data.contentMap, cachedAllHighlights || {});
  const filtered = enriched.filter(item => !isPermanentlyDeleted(item.url) && !isRecycled(item.url));
  const matched = filtered.filter(item => evaluateNode(qbRoot, item));

  if (inCollection) {
    // Save updated qbTree to collection storage
    saveCollectionQbTree();
    runCollectionExploreQuery(matched, data);
    return;
  }

  if (matched.length === 0) {
    displayMessage('No results match your query');
    return;
  }

  const hasKeywords = treeHasKeyword(qbRoot);
  const results = matched.map(item => ({
    ...item,
    relevance: hasKeywords ? computeRelevance(qbRoot, item) : 0,
    highlights: [], // will lazy-load on expand
  }));

  const effectiveSort = currentSortState.column ? currentSortState
    : hasKeywords ? { column: 'relevance', direction: 'desc' }
    : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(results, effectiveSort);
  const maxAtt = Math.max(...sorted.map(r => r.attScore), 0.1);
  const maxRel = Math.max(...sorted.map(r => r.relevance), 0.001);

  const normalized = sorted.map(r => ({
    ...r,
    relevance: hasKeywords ? r.relevance / maxRel : undefined,
  }));

  const container = document.getElementById('results');
  let html = columnHeaderHtml('global', { hasDelete: true, hasPin: false, showRelevance: hasKeywords });
  html += normalized.map(r =>
    resultRowHtml(r.title, r.url, {
      deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      highlights: r.highlights, timestamps: r.timestamps, context: 'global', relevance: r.relevance
    })
  ).join('');
  container.innerHTML = html;
  bindColumnHeaderClicks(container);
  bindResultClicks(container);

  // Render attention chart for matched results
  const urlSet = new Set(matched.map(r => r.url));
  const matchedInteractions = data.interactions.filter(i => urlSet.has(i.url));
  renderAttentionChart(matchedInteractions);

  // Show pin button since we have valid results
  if (activeView.type === 'explore') {
    document.getElementById('pinSearchBtn').style.display = 'flex';
  }
}

async function saveCollectionQbTree() {
  if (activeView.type !== 'collection') return;
  const collections = await loadCollections();
  const col = collections.find(c => c.id === activeView.id);
  if (col) {
    col.qbTree = JSON.parse(JSON.stringify(qbRoot));
    activeView.qbTree = col.qbTree;
    await saveCollections(collections);
  }
}

function runCollectionExploreQuery(matched, data) {
  const collectionId = activeView.id;
  const pinnedUrls = new Set((allCollectionPins[collectionId] || []).map(p => p.url));
  const relatedContainer = document.getElementById('relatedResults');

  if (!matched || matched.length === 0) {
    relatedContainer.innerHTML = '<div class="no-results">No results match this query</div>';
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  // Filter out pinned results from explore
  const exploreMatched = matched.filter(r => !pinnedUrls.has(r.url));

  if (exploreMatched.length === 0) {
    relatedContainer.innerHTML = '<div class="no-results">All matching results are already pinned</div>';
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  const byUrl = groupInteractionsByUrl(data.interactions);
  const hasKeywords = treeHasKeyword(qbRoot);
  const results = exploreMatched.map(item => {
    const group = byUrl.get(item.url) || [];
    const agg = aggregateAttention(group);
    const timestamps = group.map(i => i.timestamp);
    if (timestamps.length === 0) timestamps.push(item.timestamp || Date.now());
    return {
      ...item,
      attScore: agg.score,
      attDetail: agg.detail,
      highlights: [],
      timestamps,
      relevance: hasKeywords ? computeRelevance(qbRoot, item) : 0,
    };
  });

  const effectiveSort = relatedSortState.column ? relatedSortState
    : hasKeywords ? { column: 'relevance', direction: 'desc' }
    : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(results, effectiveSort);
  const maxAtt = Math.max(...sorted.map(r => r.attScore), 0.1);
  const maxRel = Math.max(...sorted.map(r => r.relevance), 0.001);

  const normalized = sorted.map(r => ({
    ...r,
    relevance: hasKeywords ? r.relevance / maxRel : undefined,
  }));

  let html = columnHeaderHtml('related', { hasDelete: true, hasPin: true, showRelevance: hasKeywords });
  html += normalized.map(r =>
    resultRowHtml(r.title, r.url, {
      pinned: isResultPinned(collectionId, r.url),
      deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      highlights: r.highlights, timestamps: r.timestamps, context: 'related', relevance: r.relevance,
    })
  ).join('');
  relatedContainer.innerHTML = html;
  bindColumnHeaderClicks(relatedContainer);
  bindResultClicks(relatedContainer);
  bindPinClicks(relatedContainer, collectionId);

  // Attention chart for explore results
  const urlSet = new Set(exploreMatched.map(r => r.url));
  const matchedInteractions = data.interactions.filter(i => urlSet.has(i.url));
  renderAttentionChartInto(
    document.getElementById('relatedChart'),
    document.getElementById('relatedChartBars'),
    matchedInteractions,
    'Explore results'
  );
  bindChartBarClick(document.getElementById('relatedChart'), document.getElementById('relatedResults'));

}

// --- Query builder: Rendering ---
function getActiveQbBody() {
  if (activeView.type === 'collection') {
    return document.getElementById('collectionQbBody');
  }
  return document.getElementById('qbBody');
}

function renderQueryBuilder() {
  const body = getActiveQbBody();
  if (!body) return;

  if (qbMode === 'normal') {
    body.classList.remove('qb-mode-pro');
    renderQueryBuilderNormal(body);
  } else {
    body.classList.add('qb-mode-pro');
    renderQueryBuilderPro(body);
  }
  bindQueryBuilderEvents(body);

  // Update Normal mode button: disable if tree has AND operators
  const toggle = body.closest('.query-builder')?.querySelector('.qb-mode-toggle');
  const normalBtn = toggle?.querySelector('.qb-mode-btn[data-mode="normal"]');
  if (normalBtn && toggle) {
    let hint = toggle.querySelector('.qb-mode-hint');
    if (qbMode === 'professional' && !qbCanConvertToNormal(qbRoot)) {
      normalBtn.disabled = true;
      if (!hint) {
        hint = document.createElement('span');
        hint.className = 'qb-mode-hint';
        toggle.appendChild(hint);
      }
      hint.textContent = 'Tree contains AND/NOT operators';
    } else {
      normalBtn.disabled = false;
      if (hint) hint.remove();
    }
  }
}

function renderPredicateInputs(node) {
  const nodeId = node.id;

  let html = `<select class="qb-type-select" data-node-id="${nodeId}">
    <option value="keyword"${node.predicateType === 'keyword' || !node.predicateType ? ' selected' : ''}>Keyword</option>
    <option value="smartFilter"${node.predicateType === 'smartFilter' ? ' selected' : ''}>Smart Filter</option>
    <option value="range"${node.predicateType === 'range' ? ' selected' : ''}>Range</option>
  </select>`;

  if (node.predicateType === 'keyword' || !node.predicateType) {
    const fields = normalizeFieldToArray(node.field);
    const isAll = fields.length === KEYWORD_FIELDS.length;
    const label = isAll ? 'All' : fields.map(f => KEYWORD_FIELD_LABELS[f] || f).join(', ');
    html += `<div class="qb-field-multi" data-node-id="${nodeId}">`;
    html += `<div class="qb-field-toggle">${escapeHtml(label)}</div>`;
    html += `<div class="qb-field-dropdown">`;
    html += `<label class="qb-field-option all-option"><input type="checkbox" value="all"${isAll ? ' checked' : ''}> All</label>`;
    for (const f of KEYWORD_FIELDS) {
      const checked = fields.includes(f);
      html += `<label class="qb-field-option"><input type="checkbox" value="${f}"${checked ? ' checked' : ''}> ${KEYWORD_FIELD_LABELS[f]}</label>`;
    }
    html += `</div></div>`;
    html += `<input type="text" class="qb-value-input" data-node-id="${nodeId}" placeholder="Search text..." value="${escapeHtml(node.value || '')}">`;
  } else if (node.predicateType === 'smartFilter') {
    const filter = node.filter || 'gateways';
    html += `<select class="qb-filter-select" data-node-id="${nodeId}">
      <option value="gateways"${filter === 'gateways' ? ' selected' : ''}>Gateways</option>
    </select>`;
  } else if (node.predicateType === 'range') {
    const field = node.field || 'lastVisit';
    const cfg = getRangeConfig(field);
    const lo = node.value != null ? Math.max(node.value, cfg.min) : cfg.min;
    const hi = node.value2 != null ? Math.min(node.value2, cfg.max) : cfg.max;
    const range = cfg.max - cfg.min;
    const loPercent = range > 0 ? ((lo - cfg.min) / range * 100) : 0;
    const hiPercent = range > 0 ? ((cfg.max - hi) / range * 100) : 0;
    html += `<select class="qb-range-field-select" data-node-id="${nodeId}">
      <option value="lastVisit"${field === 'lastVisit' ? ' selected' : ''}>Last Visit</option>
      <option value="firstVisit"${field === 'firstVisit' ? ' selected' : ''}>First Visit</option>
      <option value="visitCount"${field === 'visitCount' ? ' selected' : ''}>Visit Count</option>
      <option value="timeOnPage"${field === 'timeOnPage' ? ' selected' : ''}>Time on Page</option>
      <option value="scrollDepth"${field === 'scrollDepth' ? ' selected' : ''}>Scroll Depth</option>
      <option value="clicks"${field === 'clicks' ? ' selected' : ''}>Clicks</option>
    </select>`;
    html += `<div class="qb-dual-range" data-node-id="${nodeId}">
      <span class="qb-dual-range-label qb-dual-range-lo-label">${cfg.format(lo)}</span>
      <div class="qb-dual-range-track">
        <div class="qb-dual-range-fill" style="left:${loPercent}%;right:${hiPercent}%"></div>
        <input type="range" class="qb-dual-range-lo" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${lo}">
        <input type="range" class="qb-dual-range-hi" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${hi}">
      </div>
      <span class="qb-dual-range-label qb-dual-range-hi-label">${cfg.format(hi)}</span>
    </div>`;
  }

  return html;
}

function renderQueryBuilderNormal(body) {
  const predicates = qbFlatten(qbRoot);
  let html = '';

  for (const pred of predicates) {
    html += `<div class="qb-predicate-row" data-node-id="${pred.id}">`;
    html += renderPredicateInputs(pred);
    html += `<button class="qb-remove-btn" data-node-id="${pred.id}" title="Remove">&times;</button>`;
    html += `</div>`;
  }

  html += `<button class="qb-add-btn">+ Add filter</button>`;
  body.innerHTML = html;
}

function qbLeafButtons(depth, parentOp) {
  if (depth === 0) return ['OR', 'AND']; // root leaf: both (AND first)
  // Always offer the opposite of parent — alternating pattern
  // Same-op nesting would just merge into parent, so only opposite is useful
  return parentOp === 'OR' ? ['AND'] : ['OR'];
}

function renderTreeNodePro(node, depth = 0, parentOp = null) {
  if (!node) return '<span style="color:#9aa0a6;font-size:12px">empty</span>';

  if (node.type === 'predicate') {
    let html = `<div class="qt-leaf" data-node-id="${node.id}">`;
    const buttons = qbLeafButtons(depth, parentOp);
    html += `<div class="qt-edge-btns">`;
    for (let bi = 0; bi < buttons.length; bi++) {
      if (bi > 0) html += `<span class="qt-line"></span>`;
      const btn = buttons[bi];
      if (btn === 'OR') html += `<button class="qt-op-btn" data-leaf-id="${node.id}" data-op="OR" title="Add OR"><span class="qt-sym qt-sym-or"></span></button>`;
      if (btn === 'AND') html += `<button class="qt-op-btn" data-leaf-id="${node.id}" data-op="AND" title="Add AND"><span class="qt-sym qt-sym-and"></span></button>`;
    }
    if (buttons.length > 0) html += `<span class="qt-line"></span>`;
    const notActive = node.negated ? ' active' : '';
    html += `<button class="qt-not-btn${notActive}" data-node-id="${node.id}" title="Negate"><span class="qt-sym qt-sym-not"></span></button>`;
    html += `<span class="qt-line"></span>`;
    html += `</div>`;
    html += renderPredicateInputs(node);
    // Hide remove button for the sole root placeholder (removing it just recreates it)
    const isRootPlaceholder = depth === 0 && !parentOp && node.predicateType === null;
    if (!isRootPlaceholder) {
      html += `<button class="qb-remove-btn" data-node-id="${node.id}" title="Remove">&times;</button>`;
    }
    html += `</div>`;
    return html;
  }

  if (node.type === 'operator') {
    // Single-child: transparent wrapper — just render the child at depth+1
    if (node.children.length === 1) {
      return renderTreeNodePro(node.children[0], depth + 1, parentOp);
    }
    // Multi-child: branching operator — clickable to add another child
    const opCls = node.op === 'OR' ? 'qt-sym-or' : 'qt-sym-and';
    let html = `<div class="qt-op" data-node-id="${node.id}">`;
    html += `<button class="qt-op-parent-btn" data-node-id="${node.id}" data-op="${node.op}" title="Add child"><span class="qt-sym ${opCls}"></span></button>`;
    html += `<div class="qt-children">`;
    for (const child of node.children) {
      html += `<div class="qt-branch">${renderTreeNodePro(child, depth + 1, node.op)}</div>`;
    }
    html += `</div>`;
    html += `</div>`;
    return html;
  }

  return '';
}

function renderQueryBuilderPro(body) {
  body.innerHTML = renderTreeNodePro(qbRoot);
}

function bindQueryBuilderEvents(body) {
  // Type selector change
  body.querySelectorAll('.qb-type-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const nodeId = parseInt(sel.dataset.nodeId);
      const newType = sel.value || null;
      const found = qbFindNode(qbRoot, nodeId);
      if (!found) return;
      // Reset the node to new type with defaults
      found.node.predicateType = newType;
      if (newType === 'keyword') {
        found.node.field = [...KEYWORD_FIELDS];
        found.node.value = '';
        delete found.node.filter;
        delete found.node.op;
        delete found.node.value2;
      } else if (newType === 'smartFilter') {
        found.node.filter = 'gateways';
        delete found.node.field;
        delete found.node.value;
        delete found.node.op;
        delete found.node.value2;
      } else if (newType === 'range') {
        found.node.field = 'lastVisit';
        found.node.op = 'between';
        const cfg = getRangeConfig('lastVisit');
        found.node.value = cfg.min;
        found.node.value2 = cfg.max;
        delete found.node.filter;
      }
      renderQueryBuilder();
      debouncedRunQuery();
    });
  });

  // Keyword field multi-select dropdown
  body.querySelectorAll('.qb-field-multi').forEach(container => {
    const nodeId = parseInt(container.dataset.nodeId);
    const toggle = container.querySelector('.qb-field-toggle');
    const dropdown = container.querySelector('.qb-field-dropdown');
    const allCheckbox = dropdown.querySelector('input[value="all"]');
    const fieldCheckboxes = [...dropdown.querySelectorAll('input:not([value="all"])')];

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close other open dropdowns
      body.querySelectorAll('.qb-field-dropdown.open').forEach(d => { if (d !== dropdown) d.classList.remove('open'); });
      dropdown.classList.toggle('open');
      if (dropdown.classList.contains('open')) {
        const rect = toggle.getBoundingClientRect();
        dropdown.style.top = rect.bottom + 2 + 'px';
        dropdown.style.left = rect.left + 'px';
      }
    });

    function syncFromCheckboxes() {
      const selected = fieldCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
      const isAll = selected.length === KEYWORD_FIELDS.length;
      allCheckbox.checked = isAll;
      toggle.textContent = isAll ? 'All' : (selected.length === 0 ? 'None' : selected.map(f => KEYWORD_FIELD_LABELS[f] || f).join(', '));
      qbUpdateNode(nodeId, { field: isAll ? [...KEYWORD_FIELDS] : selected });
      cachedAllHighlights = null;
      debouncedRunQuery();
    }

    allCheckbox.addEventListener('change', (e) => {
      e.stopPropagation();
      fieldCheckboxes.forEach(cb => { cb.checked = allCheckbox.checked; });
      syncFromCheckboxes();
    });

    fieldCheckboxes.forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        syncFromCheckboxes();
      });
    });
  });

  // Close field dropdowns on outside click
  function closeFieldDropdowns(e) {
    if (!e.target.closest('.qb-field-multi')) {
      body.querySelectorAll('.qb-field-dropdown.open').forEach(d => d.classList.remove('open'));
    }
  }
  document.removeEventListener('click', body._closeFieldDropdowns);
  body._closeFieldDropdowns = closeFieldDropdowns;
  document.addEventListener('click', closeFieldDropdowns);

  // Keyword value input
  body.querySelectorAll('.qb-value-input').forEach(input => {
    input.addEventListener('input', () => {
      const nodeId = parseInt(input.dataset.nodeId);
      qbUpdateNode(nodeId, { value: input.value });
      debouncedRunQuery();
    });
  });

  // Smart filter selector
  body.querySelectorAll('.qb-filter-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const nodeId = parseInt(sel.dataset.nodeId);
      qbUpdateNode(nodeId, { filter: sel.value });
      debouncedRunQuery();
    });
  });

  // Range field selector — reset slider bounds on field change
  body.querySelectorAll('.qb-range-field-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const nodeId = parseInt(sel.dataset.nodeId);
      const cfg = getRangeConfig(sel.value);
      qbUpdateNode(nodeId, { field: sel.value, op: 'between', value: cfg.min, value2: cfg.max });
      renderQueryBuilder();
      debouncedRunQuery();
    });
  });

  // Dual-range sliders
  body.querySelectorAll('.qb-dual-range').forEach(container => {
    const nodeId = parseInt(container.dataset.nodeId);
    const loInput = container.querySelector('.qb-dual-range-lo');
    const hiInput = container.querySelector('.qb-dual-range-hi');
    const fill = container.querySelector('.qb-dual-range-fill');
    const loLabel = container.querySelector('.qb-dual-range-lo-label');
    const hiLabel = container.querySelector('.qb-dual-range-hi-label');
    const min = parseFloat(loInput.min), max = parseFloat(loInput.max), range = max - min;

    function updateSlider() {
      let lo = parseFloat(loInput.value), hi = parseFloat(hiInput.value);
      if (lo > hi) { const t = lo; lo = hi; hi = t; loInput.value = lo; hiInput.value = hi; }
      fill.style.left = (range > 0 ? (lo - min) / range * 100 : 0) + '%';
      fill.style.right = (range > 0 ? (max - hi) / range * 100 : 0) + '%';
      const found = qbFindNode(qbRoot, nodeId);
      if (found) {
        const cfg = RANGE_CONFIGS[found.node.field || 'lastVisit'];
        loLabel.textContent = cfg.format(lo);
        hiLabel.textContent = cfg.format(hi);
      }
      qbUpdateNode(nodeId, { value: lo, value2: hi, op: 'between' });
      debouncedRunQuery();
    }
    loInput.addEventListener('input', () => {
      if (parseFloat(loInput.value) > parseFloat(hiInput.value)) loInput.value = hiInput.value;
      updateSlider();
    });
    hiInput.addEventListener('input', () => {
      if (parseFloat(hiInput.value) < parseFloat(loInput.value)) hiInput.value = loInput.value;
      updateSlider();
    });
  });

  // Remove button — use mousedown to avoid focus/blur swallowing the click
  body.querySelectorAll('.qb-remove-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent focus shift
      const nodeId = parseInt(btn.dataset.nodeId);
      qbRemoveLeaf(nodeId);
      debouncedRunQuery();
    });
  });

  // Add filter (normal mode)
  const addBtn = body.querySelector('.qb-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const newPred = qbCreatePlaceholder();
      const predicates = qbFlatten(qbRoot);
      // Filter out pure placeholders if the user already has configured ones
      const configured = predicates.filter(p => p.predicateType !== null);
      const all = [...configured, newPred];
      if (configured.length === 0) all.unshift(...predicates.filter(p => p.predicateType === null));
      qbRoot = qbToTree([...predicates, newPred]);
      renderQueryBuilder();
    });
  }

  // Pro mode: leaf edge buttons (insert on edge)
  body.querySelectorAll('.qt-op-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const leafId = parseInt(btn.dataset.leafId);
      qbInsertOnEdge(leafId, btn.dataset.op);
    });
  });

  // Pro mode: NOT toggle (negate leaf)
  body.querySelectorAll('.qt-not-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nodeId = parseInt(btn.dataset.nodeId);
      const found = qbFindNode(qbRoot, nodeId);
      if (found) {
        found.node.negated = !found.node.negated;
        btn.classList.toggle('active', found.node.negated);
        debouncedRunQuery();
      }
    });
  });

  // Pro mode: parent operator buttons (add child to existing operator)
  body.querySelectorAll('.qt-op-parent-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nodeId = parseInt(btn.dataset.nodeId);
      qbAddChild(nodeId);
    });
  });

  // Mode toggle buttons
  body.closest('.query-builder')?.querySelectorAll('.qb-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const newMode = btn.dataset.mode;
      if (newMode === qbMode) return;
      qbMode = newMode;
      // Update active class
      btn.closest('.qb-mode-toggle').querySelectorAll('.qb-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderQueryBuilder();
    });
  });
}

function debouncedRunQuery() {
  if (qbDebounceTimer) clearTimeout(qbDebounceTimer);
  qbDebounceTimer = setTimeout(() => runQuery(), 300);
}

// Summarize a query tree into a short display name for collections
function qbSummarize(node) {
  if (!node) return 'Empty query';
  if (node.type === 'predicate') {
    if (node.predicateType === null) return '...';
    if (node.predicateType === 'keyword') {
      const fields = normalizeFieldToArray(node.field);
      const isAll = fields.length === KEYWORD_FIELDS.length;
      const prefix = isAll ? '' : fields.join('+') + ':';
      return node.value ? `${prefix}"${node.value}"` : 'keyword';
    }
    if (node.predicateType === 'smartFilter') return node.filter || 'filter';
    if (node.predicateType === 'range') {
      const cfg = RANGE_CONFIGS[node.field];
      const lo = node.value != null ? cfg.format(node.value) : '?';
      const hi = node.value2 != null ? cfg.format(node.value2) : '?';
      return `${node.field} ${lo}–${hi}`;
    }
    return '...';
  }
  if (node.type === 'operator') {
    const parts = node.children.map(c => qbSummarize(c));
    const full = parts.join(` ${node.op} `);
    return full.length > 50 ? full.substring(0, 47) + '...' : full;
  }
  return 'query';
}

async function showExplore() {
  activeView = { type: 'explore' };
  updateSidebarActive();
  updateMainTitle('Explore');

  // Default to a keyword search over all if no query configured
  if (!qbRoot) {
    qbRoot = qbCreatePlaceholder();
  }

  // Show query builder, hide other UI
  document.getElementById('queryBuilder').style.display = 'block';
  document.getElementById('pinSearchBtn').style.display =
    treeHasConfiguredPredicate(qbRoot) ? 'flex' : 'none';
  showNormalLayout();

  renderQueryBuilder();

  if (treeHasConfiguredPredicate(qbRoot)) {
    await runQuery();
  } else {
    renderAttentionChart([]);
    displayMessage('Add filters to start querying');
  }
}

async function showCollection(collection) {
  const displayName = collectionDisplayName(collection);
  activeView = { type: 'collection', query: collection.query, id: collection.id, qbTree: collection.qbTree || null, name: collection.name || null };
  updateSidebarActive();
  updateMainTitle(displayName);
  document.getElementById('pinSearchBtn').style.display = 'none';

  // Enable double-click rename on title
  const titleEl = document.getElementById('mainTitle');
  function attachDblClick(currentName) {
    titleEl.ondblclick = () => {
      enterTitleEditMode(currentName, async (newName) => {
        const collections = await loadCollections();
        const col = collections.find(c => c.id === collection.id);
        if (col) {
          col.name = newName;
          collection.name = newName;
          await saveCollections(collections);
          await renderCollections();
        }
        activeView.name = newName;
        updateMainTitle(newName);
        attachDblClick(newName);
      }, () => {
        updateMainTitle(currentName);
        attachDblClick(currentName);
      });
    };
  }
  attachDblClick(displayName);
  showCollectionLayout();

  try {
    const data = cachedData || await loadData();

    if (data.interactions.length === 0) {
      document.querySelector('.collection-section[data-section="pinned"]').style.display = 'none';
      document.getElementById('relatedResults').innerHTML = '';
      document.getElementById('pinnedChart').classList.remove('visible');
      document.getElementById('relatedChart').classList.remove('visible');
      document.getElementById('collectionQueryBuilder').style.display = 'none';
      return;
    }

    let searchResults = [];
    let allEnriched = [];

    if (collection.qbTree) {
      // Query builder tree — evaluate it directly
      if (treeNeedsHighlights(collection.qbTree) && !cachedAllHighlights) {
        try {
          const resp = await chrome.runtime.sendMessage({ action: 'loadAllHighlights' });
          cachedAllHighlights = (resp?.success) ? resp.highlightsMap : {};
        } catch { cachedAllHighlights = {}; }
      }
      await loadGatewayDomains();

      const enriched = enrichForQuery(data.interactions, data.contentMap, cachedAllHighlights || {});
      allEnriched = enriched.filter(item => !isPermanentlyDeleted(item.url) && !isRecycled(item.url));
      searchResults = allEnriched.filter(item => evaluateNode(collection.qbTree, item));
    } else if (collection.query) {
      // Legacy string query — use WASM search
      await initWasm();
      const engine = new SearchEngine();
      buildInteractionsForEngine(Interaction, engine, data.interactions, data.contentMap);
      searchResults = await engine.search(collection.query, 0);
      await loadGatewayDomains();
      allEnriched = enrichForQuery(data.interactions, data.contentMap, cachedAllHighlights || {})
        .filter(item => !isPermanentlyDeleted(item.url) && !isRecycled(item.url));
    }

    displayCollectionSections(collection.id, searchResults, data, allEnriched);

    // Render Explore section with the collection's query builder
    renderCollectionExplore(collection, data);
  } catch (error) {
    console.error('Collection search error:', error);
    document.querySelector('.collection-section[data-section="pinned"]').style.display = 'none';
    document.getElementById('relatedResults').innerHTML = `<div class="no-results">${escapeHtml('Error: ' + error.message)}</div>`;
  }
}

function displayCollectionSections(collectionId, searchResults, data, allEnriched) {
  const pins = allCollectionPins[collectionId] || [];
  const pinnedUrls = new Set(pins.map(p => p.url));
  const searchResultUrls = new Set(searchResults.map(r => r.url));
  const byUrl = groupInteractionsByUrl(data.interactions);

  function enrichResult(r) {
    const group = byUrl.get(r.url) || [];
    const agg = aggregateAttention(group);
    const highlights = [];
    const timestamps = group.map(i => i.timestamp);
    if (timestamps.length === 0) timestamps.push(r.timestamp || r.pinnedAt || Date.now());
    const pin = pins.find(p => p.url === r.url);
    return { ...r, attScore: agg.score, attDetail: agg.detail, highlights, timestamps, pinnedAt: pin ? pin.pinnedAt : (r.pinnedAt || null) };
  }

  // Pinned: search results that are pinned + pure pins not in search results
  const pinnedInResults = searchResults.filter(r => pinnedUrls.has(r.url)).map(enrichResult);
  const pinnedOnly = pins.filter(p => !searchResultUrls.has(p.url)).map(enrichResult);
  const allPinned = [...pinnedInResults, ...pinnedOnly];

  // Related: seed-based scoring using pinned pages as seeds
  let related = [];
  if (allPinned.length > 0 && allEnriched && allEnriched.length > 0) {
    const allPinnedUrls = new Set(allPinned.map(r => r.url));
    const seedEnriched = allEnriched.filter(e => allPinnedUrls.has(e.url));
    const candidateEnriched = allEnriched.filter(e => !allPinnedUrls.has(e.url));
    related = findRelatedPages(seedEnriched, candidateEnriched, gatewayDomainsCache).map(enrichResult);
  }

  const effectivePinnedSort = pinnedSortState.column ? pinnedSortState : { column: 'lastVisit', direction: 'desc' };
  const sortedPinned = applySortOrder(allPinned, effectivePinnedSort);
  const sortedRelated = applySortOrder(related, effectivePinnedSort);

  const allForMax = [...sortedPinned, ...sortedRelated];
  const maxAtt = Math.max(...allForMax.map(r => r.attScore), 0.1);

  // Render merged pinned + related into one container
  const pinnedSection = document.querySelector('.collection-section[data-section="pinned"]');
  const pinnedContainer = document.getElementById('pinnedResults');

  if (sortedPinned.length === 0) {
    pinnedSection.style.display = 'none';
  } else {
    pinnedSection.style.display = '';
    let html = columnHeaderHtml('pinned', { hasDelete: true, hasPin: true });

    // Pinned results
    html += sortedPinned.map(r =>
      resultRowHtml(r.title, r.url, { pinned: true, deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps, context: 'pinned', pinnedAt: r.pinnedAt })
    ).join('');

    // Related results after pinned, with gap and transparency
    if (sortedRelated.length > 0 && sortedPinned.length > 0) {
      html += '<div class="related-gap"></div>';
    }
    html += sortedRelated.map(r =>
      resultRowHtml(r.title, r.url, { pinned: false, deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps, context: 'pinned', cssClass: 'related-result' })
    ).join('');

    pinnedContainer.innerHTML = html;
    bindColumnHeaderClicks(pinnedContainer);
    bindResultClicks(pinnedContainer);
    bindPinClicks(pinnedContainer, collectionId);
  }

  // Cache context for related recalculation on date filter
  pinnedFilterCtx = { allPinned, allEnriched, data, collectionId, enrichResult, maxAtt };

  // Attention chart for pinned pages only
  const pinnedUrlsForChart = new Set(allPinned.map(r => r.url));
  const chartInteractions = data.interactions.filter(i => pinnedUrlsForChart.has(i.url));
  renderAttentionChartInto(
    document.getElementById('pinnedChart'),
    document.getElementById('pinnedChartBars'),
    chartInteractions,
    'Collection pages'
  );
  bindChartBarClick(document.getElementById('pinnedChart'), document.getElementById('pinnedResults'));

}

function recalculateRelatedResults() {
  const ctx = pinnedFilterCtx;
  if (!ctx) return;
  const { allPinned, allEnriched, data, collectionId, enrichResult, maxAtt } = ctx;

  // Collect URLs of visible pinned results
  const pinnedContainer = document.getElementById('pinnedResults');
  const visiblePinnedUrls = new Set();
  pinnedContainer.querySelectorAll('.result-item:not(.related-result)').forEach(item => {
    if (item.style.display === 'none') return;
    const row = item.querySelector('.result-row');
    if (row) visiblePinnedUrls.add(row.dataset.url);
  });

  // If no filter active, use all pinned
  const seedUrls = visiblePinnedUrls.size > 0 ? visiblePinnedUrls : new Set(allPinned.map(r => r.url));

  // Recalculate related pages
  let related = [];
  if (seedUrls.size > 0 && allEnriched && allEnriched.length > 0) {
    const seedEnriched = allEnriched.filter(e => seedUrls.has(e.url));
    const allPinnedUrls = new Set(allPinned.map(r => r.url));
    const candidateEnriched = allEnriched.filter(e => !allPinnedUrls.has(e.url));
    related = findRelatedPages(seedEnriched, candidateEnriched, gatewayDomainsCache).map(enrichResult);
  }

  const effectivePinnedSort = pinnedSortState.column ? pinnedSortState : { column: 'lastVisit', direction: 'desc' };
  const sortedRelated = applySortOrder(related, effectivePinnedSort);

  // Remove old related results and gap, then append new ones
  pinnedContainer.querySelectorAll('.related-gap, .result-item.related-result').forEach(el => el.remove());

  if (sortedRelated.length > 0) {
    // Build HTML in a temp container so we can bind only new rows
    const temp = document.createElement('div');
    temp.innerHTML = '<div class="related-gap"></div>' + sortedRelated.map(r =>
      resultRowHtml(r.title, r.url, {
        pinned: false, deletable: true, attScore: r.attScore, maxAtt,
        attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps,
        context: 'pinned', cssClass: 'related-result'
      })
    ).join('');
    bindResultClicks(temp);
    bindPinClicks(temp, collectionId);
    while (temp.firstChild) pinnedContainer.appendChild(temp.firstChild);
  }
}

function renderCollectionExplore(collection, data) {
  const qbContainer = document.getElementById('collectionQueryBuilder');

  // Load the collection's tree into the global qbRoot (explore state already saved)
  qbRoot = collection.qbTree ? JSON.parse(JSON.stringify(collection.qbTree)) : null;
  qbMode = (qbRoot && !qbCanConvertToNormal(qbRoot)) ? 'professional' : 'normal';

  // Show the query builder (interactive)
  qbContainer.style.display = 'block';
  renderQueryBuilder();

  // Run query with current tree
  if (qbRoot && treeHasConfiguredPredicate(qbRoot)) {
    const enriched = enrichForQuery(data.interactions, data.contentMap, cachedAllHighlights || {});
    const filtered = enriched.filter(item => !isPermanentlyDeleted(item.url) && !isRecycled(item.url));
    const matched = filtered.filter(item => evaluateNode(qbRoot, item));
    runCollectionExploreQuery(matched, data);
  } else {
    document.getElementById('relatedResults').innerHTML = '<div class="no-results">Add filters to start querying</div>';
    document.getElementById('relatedChart').classList.remove('visible');
  }
}

function displaySearchResults(results) {
  const container = document.getElementById('results');
  if (!results || results.length === 0) {
    displayMessage('No results found');
    return;
  }

  const data = cachedData || { interactions: [] };
  const byUrl = groupInteractionsByUrl(data.interactions);

  const total = results.length;
  const resultData = results.map((r, index) => {
    const group = byUrl.get(r.url) || [];
    const agg = aggregateAttention(group);
    const highlights = [];
    const timestamps = group.map(i => i.timestamp);
    if (timestamps.length === 0) timestamps.push(r.timestamp);
    const relevance = total > 1 ? (total - index) / total : 1;
    return { ...r, attScore: agg.score, attDetail: agg.detail, highlights, timestamps, relevance };
  });

  // When sort is null, preserve WASM relevance order
  const sorted = applySortOrder(resultData, currentSortState);
  const maxAtt = Math.max(...sorted.map(r => r.attScore), 0.1);

  let html = columnHeaderHtml('global', { hasDelete: true, hasPin: false, showRelevance: true });
  html += sorted.map(r =>
    resultRowHtml(r.title, r.url, { deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps, context: 'global', relevance: r.relevance })
  ).join('');
  container.innerHTML = html;
  bindColumnHeaderClicks(container);
  bindResultClicks(container);

}

function displayInteractionRows(interactions) {
  const container = document.getElementById('results');
  if (!interactions || interactions.length === 0) {
    displayMessage('No interactions found');
    return;
  }

  const byUrl = groupInteractionsByUrl(interactions);
  const entries = [...byUrl.entries()].map(([url, group]) => {
    const latest = group.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    const agg = aggregateAttention(group);
    const highlights = [];
    const timestamps = group.map(i => i.timestamp);
    return { url, title: latest.title, attScore: agg.score, attDetail: agg.detail, highlights, timestamps, latestTs: latest.timestamp };
  });

  // When sort is null, default to lastVisit desc
  const effectiveSort = currentSortState.column ? currentSortState : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(entries, effectiveSort);
  const maxAtt = Math.max(...sorted.map(e => e.attScore), 0.1);

  const deletable = isDeletableView();
  let html = columnHeaderHtml('global', { hasDelete: deletable, hasPin: false });
  html += sorted.map(e =>
    resultRowHtml(e.title, e.url, { deletable, attScore: e.attScore, maxAtt, attDetail: e.attDetail, highlights: e.highlights, timestamps: e.timestamps, context: 'global' })
  ).join('');
  container.innerHTML = html;
  bindColumnHeaderClicks(container);
  bindResultClicks(container);

}

function displayRecycleBinRows(interactions) {
  const container = document.getElementById('results');
  if (!interactions || interactions.length === 0) {
    displayMessage('Recycle bin is empty');
    return;
  }

  const byUrl = groupInteractionsByUrl(interactions);
  const entries = [...byUrl.entries()].map(([url, group]) => {
    const latest = group.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    const recycledItem = recycleBin.find(item => item.url === url);
    const deletedAt = recycledItem ? recycledItem.deletedAt : latest.timestamp;
    return { url, title: recycledItem?.title || latest.title, deletedAt };
  }).sort((a, b) => b.deletedAt - a.deletedAt);

  const RESTORE_SVG = '<svg viewBox="0 0 24 24"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18z"/></svg>';

  container.innerHTML = entries.map(e => {
    const safeTitle = escapeHtml(e.title || 'Untitled');
    const safeUrl = escapeHtml(e.url || '');
    return `<div class="result-item">
      <div class="result-row" data-url="${safeUrl}" data-title="${safeTitle}">
        <button class="result-expand" title="Show details">&#9654;</button>
        <div class="result-title">${safeTitle}</div>
        <div class="result-time">${escapeHtml(formatTime(e.deletedAt))}</div>
        <button class="result-restore" data-restore-url="${safeUrl}" title="Restore">${RESTORE_SVG}</button>
        <button class="result-delete" data-delete-url="${safeUrl}" data-delete-title="${safeTitle}" title="Delete permanently">${DELETE_SVG}</button>
      </div>
      <div class="result-detail"><div class="detail-url"><a href="${safeUrl}" target="_blank">${safeUrl}</a></div></div>
    </div>`;
  }).join('');

  bindRecycleBinClicks(container);
}

function bindRecycleBinClicks(container) {
  container.querySelectorAll('.result-row').forEach(row => {
    row.querySelector('.result-expand')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const item = row.closest('.result-item');
      const detail = item?.querySelector('.result-detail');
      if (detail) {
        const wasOpen = detail.classList.contains('open');
        detail.classList.toggle('open');
        btn.classList.toggle('open');
        if (!wasOpen && !detail.dataset.extraLoaded) {
          detail.dataset.extraLoaded = '1';
          const url = row.dataset.url;
          const extra = await loadExtraDetail(url);
          const extraHtml = renderExtraDetailHtml(extra);
          if (extraHtml) {
            const extraDiv = document.createElement('div');
            extraDiv.className = 'detail-extra';
            extraDiv.innerHTML = extraHtml;
            detail.appendChild(extraDiv);
            bindHighlightDeleteButtons(extraDiv);
          }
        }
      }
    });

    const restoreBtn = row.querySelector('.result-restore');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (row.classList.contains('selected')) {
          for (const r of container.querySelectorAll('.result-row.selected')) {
            await restoreItem(r.dataset.url);
          }
        } else {
          await restoreItem(restoreBtn.dataset.restoreUrl);
        }
        lastClickedRow = null;
        showCategory('recycleBin');
      });
    }

    const deleteBtn = row.querySelector('.result-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (row.classList.contains('selected')) {
          for (const r of container.querySelectorAll('.result-row.selected')) {
            await permanentlyDeleteItem(r.dataset.url);
          }
        } else {
          await permanentlyDeleteItem(deleteBtn.dataset.deleteUrl);
        }
        lastClickedRow = null;
        showCategory('recycleBin');
      });
    }

    // Click selects row(s): plain=single, Shift=range, Ctrl/Cmd=toggle
    row.addEventListener('click', (e) => {
      if (marqueeActive) return;
      if (e.target.closest('.result-restore') || e.target.closest('.result-delete') || e.target.closest('.result-expand')) return;

      const allRows = [...container.querySelectorAll('.result-row')];

      if (e.shiftKey && lastClickedRow) {
        const anchorIdx = allRows.indexOf(lastClickedRow);
        const curIdx = allRows.indexOf(row);
        if (anchorIdx !== -1 && curIdx !== -1) {
          const [start, end] = anchorIdx < curIdx ? [anchorIdx, curIdx] : [curIdx, anchorIdx];
          if (!e.ctrlKey && !e.metaKey) {
            allRows.forEach(r => r.classList.remove('selected'));
          }
          for (let i = start; i <= end; i++) {
            allRows[i].classList.add('selected');
          }
        }
      } else if (e.ctrlKey || e.metaKey) {
        row.classList.toggle('selected');
        lastClickedRow = row;
      } else {
        allRows.forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        lastClickedRow = row;
      }
    });
  });
}

const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>';
const DELETE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';


// Blue (low) → Red (high) color scale
function attentionColor(normalizedScore) {
  // 0 = blue (#4285f4), 0.5 = yellow (#fbbc04), 1 = red (#ea4335)
  const t = Math.max(0, Math.min(1, normalizedScore));
  if (t <= 0.5) {
    const s = t * 2; // 0→1
    const r = Math.round(66 + (251 - 66) * s);
    const g = Math.round(133 + (188 - 133) * s);
    const b = Math.round(244 + (4 - 244) * s);
    return `rgb(${r},${g},${b})`;
  } else {
    const s = (t - 0.5) * 2; // 0→1
    const r = Math.round(251 + (234 - 251) * s);
    const g = Math.round(188 + (67 - 188) * s);
    const b = Math.round(4 + (53 - 4) * s);
    return `rgb(${r},${g},${b})`;
  }
}

// Group interactions by URL, return Map<url, interaction[]>
function groupInteractionsByUrl(interactions) {
  const map = new Map();
  for (const i of interactions) {
    if (!map.has(i.url)) map.set(i.url, []);
    map.get(i.url).push(i);
  }
  return map;
}

// Compute aggregate attention for a group of interactions
function aggregateAttention(interactions) {
  let total = 0;
  let att = null;
  for (const i of interactions) {
    const a = parseAttention(i);
    if (a) {
      total += attentionStrength(a);
      att = a; // keep last one for details
    }
  }
  return { score: total, detail: att };
}

function formatTimeRange(timestamps) {
  if (timestamps.length === 0) return '';
  const sorted = [...timestamps].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (sorted.length === 1 || last - first < 86400000) {
    return formatTime(last);
  }
  const fmt = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(first)} – ${fmt(last)}`;
}

function buildDetailHtml(url, attDetail, highlights) {
  let html = `<div class="detail-url"><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a></div>`;

  if (attDetail) {
    html += '<div class="detail-metrics">';
    if (attDetail.timeOnPage) {
      const mins = Math.round(attDetail.timeOnPage / 60000);
      html += `<span class="detail-metric"><strong>${mins}m</strong> on page</span>`;
    }
    if (attDetail.scrollDepth) {
      html += `<span class="detail-metric"><strong>${Math.round(attDetail.scrollDepth)}%</strong> scrolled</span>`;
    }
    if (attDetail.clicks) {
      html += `<span class="detail-metric"><strong>${attDetail.clicks}</strong> clicks</span>`;
    }
    html += '</div>';
  }

  if (highlights && highlights.length > 0) {
    html += '<div class="detail-highlights">';
    for (const h of highlights.slice(0, 5)) {
      const raw = typeof h === 'string' ? h : h.text;
      const text = Array.isArray(raw) ? raw.join(' ') : (raw || '');
      if (text) html += `<div class="detail-highlight-item">${escapeHtml(text)}</div>`;
    }
    html += '</div>';
  }

  return html;
}

// Lazy-load extra detail data (notes, collections, snapshots) when detail is expanded
async function loadExtraDetail(url) {
  const slug = generateSlugFromUrl(url);

  // Load all highlights
  let highlights = [];
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'loadHighlights', slug });
    if (resp && resp.success && resp.highlights) {
      highlights = resp.highlights;
    }
  } catch (e) { /* filesystem not available */ }

  // Load snapshots
  let snapshots = [];
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'listSnapshots', slug });
    if (resp && resp.success && resp.snapshots) {
      snapshots = resp.snapshots;
    }
  } catch (e) { /* filesystem not available */ }

  // Find belonged collections (reverse lookup)
  const collections = await loadCollections();
  const belongedCollections = [];
  for (const collection of collections) {
    const pins = allCollectionPins[collection.id] || [];
    if (pins.some(p => p.url === url)) {
      belongedCollections.push(collectionDisplayName(collection));
    }
  }

  // Gateway lineage: if this URL is a gateway root, include child URLs
  let gatewayLineage = [];
  try {
    const origin = new URL(url).origin;
    const entry = gatewayDomainsCache[origin];
    if (entry && entry.rootUrl === url && entry.childUrls && entry.childUrls.length > 0) {
      gatewayLineage = entry.childUrls;
    }
  } catch {}

  return { highlights, snapshots, belongedCollections, slug, gatewayLineage };
}

function renderExtraDetailHtml(extra) {
  let html = '';

  if (extra.belongedCollections.length > 0) {
    html += '<div class="detail-section"><span class="detail-section-label">Collections:</span> ';
    html += extra.belongedCollections.map(t => `<span class="detail-collection-tag">${escapeHtml(t)}</span>`).join(' ');
    html += '</div>';
  }

  if (extra.highlights.length > 0) {
    html += `<div class="detail-section detail-highlights-section" data-slug="${escapeHtml(extra.slug)}"><span class="detail-section-label">Highlights:</span>`;
    for (const h of extra.highlights.slice(0, 20)) {
      const rawText = Array.isArray(h.text) ? h.text.join(' ') : (h.text || '');
      const note = h.note || '';
      const ts = h.timestamp || 0;
      const isGlobal = h.isGlobalNote;
      const label = isGlobal ? 'Page note' : escapeHtml(rawText.substring(0, 100)) + (rawText.length > 100 ? '...' : '');
      const noteHtml = note ? ` <span class="detail-note-text">${escapeHtml(note)}</span>` : '';
      html += `<div class="detail-highlight-entry" data-text="${escapeHtml(rawText)}" data-timestamp="${ts}">
        <span class="detail-highlight-content">${isGlobal ? '<em>Page note</em>' : `"${label}"`}${noteHtml}</span>
        <button class="detail-highlight-delete" title="Delete">&times;</button>
      </div>`;
    }
    html += '</div>';
  }

  if (extra.snapshots.length > 0) {
    html += '<div class="detail-section"><span class="detail-section-label">Snapshots:</span>';
    html += '<div class="detail-snapshots">';
    for (const s of extra.snapshots) {
      const date = new Date(s.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      const formats = [];
      if (s.hasMd) formats.push('md');
      if (s.hasHtml) formats.push('html');
      html += `<span class="detail-snapshot-item">${escapeHtml(date)} (${formats.join(', ')})</span>`;
    }
    html += '</div></div>';
  }

  if (extra.gatewayLineage && extra.gatewayLineage.length > 0) {
    const cap = 20;
    const shown = extra.gatewayLineage.slice(0, cap);
    const remaining = extra.gatewayLineage.length - cap;
    html += `<div class="detail-section"><span class="detail-section-label">Child pages (${extra.gatewayLineage.length}):</span>`;
    html += '<div class="detail-lineage">';
    for (const childUrl of shown) {
      html += `<a class="detail-lineage-url" href="${escapeHtml(childUrl)}" target="_blank">${escapeHtml(childUrl)}</a>`;
    }
    if (remaining > 0) {
      html += `<span class="detail-lineage-more">...and ${remaining} more</span>`;
    }
    html += '</div></div>';
  }

  return html;
}

function bindHighlightDeleteButtons(container) {
  container.querySelectorAll('.detail-highlight-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const entry = btn.closest('.detail-highlight-entry');
      const section = btn.closest('.detail-highlights-section');
      const slug = section?.dataset.slug;
      const text = entry?.dataset.text || '';
      const timestamp = parseInt(entry?.dataset.timestamp) || 0;

      if (!slug) return;

      try {
        await chrome.runtime.sendMessage({
          action: 'deleteHighlight',
          slug,
          text,
          timestamp
        });
      } catch (err) {
        console.error('Delete highlight error:', err);
        return;
      }

      entry.remove();
      // If no more highlights, remove the section
      if (section && section.querySelectorAll('.detail-highlight-entry').length === 0) {
        section.remove();
      }
    });
  });
}

// opts: { pinned, deletable, attScore, maxAtt, attDetail, highlights, timestamps, context, pinnedAt, relevance }
function resultRowHtml(title, url, opts = {}) {
  const safeTitle = escapeHtml(title || 'Untitled');
  const safeUrl = escapeHtml(url || '');
  const { pinned, deletable = false, attScore = 0, maxAtt = 1, attDetail = null, highlights = [], timestamps = [], context = 'global', pinnedAt, relevance, cssClass } = opts;
  const extraCols = getExtraColumns(context);

  const lastVisit = timestamps.length > 0 ? formatTime(Math.max(...timestamps)) : '';
  const normalized = maxAtt > 0 ? attScore / maxAtt : 0;
  const dotColor = attentionColor(normalized);

  const pinBtn = pinned !== undefined
    ? `<button class="result-pin${pinned ? ' pinned' : ''}" data-pin-url="${safeUrl}" data-pin-title="${safeTitle}" title="${pinned ? 'Unpin' : 'Pin'}">${PIN_SVG}</button>`
    : '';

  const detailHtml = buildDetailHtml(url, attDetail, highlights);

  let relevanceCell = '';
  if (relevance != null) {
    const pct = Math.round(relevance * 100);
    relevanceCell = `<div class="result-rel">${pct}%</div>`;
  }

  let extraTimeCells = '';
  if (extraCols.includes('firstVisit')) {
    const firstVisit = timestamps.length > 0 ? formatTime(Math.min(...timestamps)) : '';
    extraTimeCells += `<div class="result-time">${escapeHtml(firstVisit)}</div>`;
  }

  let extraAfterAtt = '';
  if (extraCols.includes('pinTime')) {
    extraAfterAtt += `<div class="result-time">${pinnedAt ? escapeHtml(formatTime(pinnedAt)) : ''}</div>`;
  }

  const dates = [...new Set(timestamps.map(ts => new Date(ts).toISOString().slice(0, 10)))].join(',');

  return `<div class="result-item${cssClass ? ' ' + cssClass : ''}">
    <div class="result-row" data-url="${safeUrl}" data-title="${safeTitle}" data-dates="${dates}" draggable="true">
      <button class="result-expand" title="Show details">&#9654;</button>
      <div class="result-title">${safeTitle}</div>
      ${relevanceCell}
      <div class="result-time">${escapeHtml(lastVisit)}</div>
      ${extraTimeCells}
      <div class="attention-dot-wrap" title="Attention: ${(normalized * 100).toFixed(0)}%">
        <div class="attention-dot" style="background: ${dotColor}"></div>
      </div>
      ${extraAfterAtt}
      ${deletable ? `<button class="result-delete" data-delete-url="${safeUrl}" data-delete-title="${safeTitle}" title="Delete">${DELETE_SVG}</button>` : ''}
      ${pinBtn}
    </div>
    <div class="result-detail">${detailHtml}</div>
  </div>`;
}

function bindResultClicks(container) {
  container.querySelectorAll('.result-row').forEach(row => {
    // Expand/collapse detail via chevron
    row.querySelector('.result-expand').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const item = row.closest('.result-item');
      const detail = item?.querySelector('.result-detail');
      if (detail) {
        const wasOpen = detail.classList.contains('open');
        detail.classList.toggle('open');
        btn.classList.toggle('open');
        // Lazy-load extra detail on first expand
        if (!wasOpen && !detail.dataset.extraLoaded) {
          detail.dataset.extraLoaded = '1';
          const url = row.dataset.url;
          const extra = await loadExtraDetail(url);
          const extraHtml = renderExtraDetailHtml(extra);
          if (extraHtml) {
            const extraDiv = document.createElement('div');
            extraDiv.className = 'detail-extra';
            extraDiv.innerHTML = extraHtml;
            detail.appendChild(extraDiv);
            bindHighlightDeleteButtons(extraDiv);
          }
        }
      }
    });
    // Delete button — deletes all selected if this row is part of selection
    const deleteBtn = row.querySelector('.result-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (row.classList.contains('selected')) {
          const selectedRows = container.querySelectorAll('.result-row.selected');
          for (const r of selectedRows) {
            await handleDelete(r.dataset.url, r.dataset.title);
          }
        } else {
          await handleDelete(deleteBtn.dataset.deleteUrl, deleteBtn.dataset.deleteTitle);
        }
        lastClickedRow = null;
        refreshCurrentView();
      });
    }
    // Click selects row(s): plain=single, Shift=range, Ctrl/Cmd=toggle
    row.addEventListener('click', (e) => {
      if (marqueeActive) return;
      if (e.target.closest('.result-pin')) return;
      if (e.target.closest('.result-expand')) return;
      if (e.target.closest('.result-delete')) return;

      const allRows = [...container.querySelectorAll('.result-row')];

      if (e.shiftKey && lastClickedRow) {
        // Range select from lastClickedRow to current
        const anchorIdx = allRows.indexOf(lastClickedRow);
        const curIdx = allRows.indexOf(row);
        if (anchorIdx !== -1 && curIdx !== -1) {
          const [start, end] = anchorIdx < curIdx ? [anchorIdx, curIdx] : [curIdx, anchorIdx];
          if (!e.ctrlKey && !e.metaKey) {
            allRows.forEach(r => r.classList.remove('selected'));
          }
          for (let i = start; i <= end; i++) {
            allRows[i].classList.add('selected');
          }
        }
      } else if (e.ctrlKey || e.metaKey) {
        // Toggle individual
        row.classList.toggle('selected');
        lastClickedRow = row;
      } else {
        // Plain click: toggle if already sole selection, otherwise select only this one
        const wasSelected = row.classList.contains('selected');
        allRows.forEach(r => r.classList.remove('selected'));
        if (!wasSelected) {
          row.classList.add('selected');
        }
        lastClickedRow = row;
      }
      syncChartHighlights();
    });
    // Double-click opens the link
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.result-pin')) return;
      if (e.target.closest('.result-expand')) return;
      if (e.target.closest('.result-delete')) return;
      chrome.tabs.create({ url: row.dataset.url });
    });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({
        url: row.dataset.url,
        title: row.dataset.title
      }));
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
}

function bindPinClicks(container, collectionId) {
  container.querySelectorAll('.result-pin').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = btn.dataset.pinUrl;
      const title = btn.dataset.pinTitle;
      await toggleResultPin(collectionId, url, title);
      // Re-render collection view
      const collection = { id: collectionId, query: activeView.query, qbTree: activeView.qbTree, name: activeView.name };
      showCollection(collection);
    });
  });
}

function displayMessage(msg) {
  document.getElementById('attentionChart').classList.remove('visible');
  document.getElementById('attentionChartSecondary').classList.remove('visible');
  document.getElementById('results').innerHTML =
    `<div class="no-results">${escapeHtml(msg)}</div>`;
}

function categoryLabel(category) {
  const labels = { all: 'All', today: 'Today', week: 'This Week', highlighted: 'Highlighted', gateways: 'Gateways', recycleBin: 'Recycle Bin', explore: 'Explore' };
  return labels[category] || category;
}

function collectionDisplayName(collection) {
  return collection.name || collection.query;
}

function updateMainTitle(text) {
  const titleEl = document.getElementById('mainTitle');
  const inputEl = document.getElementById('mainTitleInput');
  const confirmBtn = document.getElementById('confirmTitleBtn');
  // Exit any edit mode and show normal title
  titleEl.textContent = text;
  titleEl.style.display = '';
  titleEl.ondblclick = null;
  inputEl.style.display = 'none';
  confirmBtn.style.display = 'none';
  // Hide recycle bin actions by default (showCategory will re-show them)
  document.getElementById('restoreAllBtn').style.display = 'none';
  document.getElementById('deleteAllBtn').style.display = 'none';
}

function enterTitleEditMode(prefill, onConfirm, onCancel) {
  const titleEl = document.getElementById('mainTitle');
  const inputEl = document.getElementById('mainTitleInput');
  const confirmBtn = document.getElementById('confirmTitleBtn');
  const pinBtn = document.getElementById('pinSearchBtn');

  titleEl.style.display = 'none';
  pinBtn.style.display = 'none';
  inputEl.value = prefill;
  inputEl.style.display = '';
  confirmBtn.style.display = 'flex';
  inputEl.focus();
  inputEl.select();

  let settled = false;

  function confirm() {
    if (settled) return;
    settled = true;
    cleanup();
    onConfirm(inputEl.value.trim() || prefill);
  }

  function cancel() {
    if (settled) return;
    settled = true;
    cleanup();
    if (onCancel) onCancel();
  }

  function cleanup() {
    confirmBtn.removeEventListener('click', confirm);
    inputEl.removeEventListener('keydown', onKey);
    inputEl.removeEventListener('blur', onBlur);
  }

  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }

  function onBlur() {
    setTimeout(() => {
      if (!settled && document.activeElement !== confirmBtn) {
        confirm();
      }
    }, 100);
  }

  confirmBtn.addEventListener('click', confirm);
  inputEl.addEventListener('keydown', onKey);
  inputEl.addEventListener('blur', onBlur);
}

function updateSidebarActive() {
  document.querySelectorAll('.sidebar-item').forEach(item => item.classList.remove('active'));
  document.getElementById('exploreBtn').classList.remove('active');

  if (activeView.type === 'category') {
    const el = document.querySelector(`.sidebar-item[data-category="${activeView.value}"]`);
    if (el) el.classList.add('active');
  } else if (activeView.type === 'collection') {
    const el = document.querySelector(`.sidebar-item[data-collection-id="${activeView.id}"]`);
    if (el) el.classList.add('active');
  } else if (activeView.type === 'explore') {
    document.getElementById('exploreBtn').classList.add('active');
  }
}

// --- Collections (pinned searches) ---
async function loadCollections() {
  // Migration: try pinnedCollections first, fall back to pinnedTopics
  const result = await chrome.storage.local.get(['pinnedCollections', 'pinnedTopics']);
  if (result.pinnedCollections) return result.pinnedCollections;
  if (result.pinnedTopics) {
    await chrome.storage.local.set({ pinnedCollections: result.pinnedTopics });
    return result.pinnedTopics;
  }
  return [];
}

async function saveCollections(collections) {
  await chrome.storage.local.set({ pinnedCollections: collections });
}

async function renderCollections() {
  const collections = await loadCollections();
  const list = document.getElementById('collectionsList');
  const empty = document.getElementById('collectionsEmpty');

  // Remove existing collection items (keep the empty placeholder)
  list.querySelectorAll('.sidebar-item').forEach(el => el.remove());

  if (collections.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  for (const collection of collections) {
    const item = document.createElement('div');
    item.className = 'sidebar-item';
    item.dataset.collectionId = collection.id;
    item.innerHTML = `
      <span class="icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg></span>
      <span class="label">${escapeHtml(collectionDisplayName(collection))}</span>
      <button class="remove-collection" title="Remove collection">&times;</button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.remove-collection')) return;
      showCollection(collection);
    });

    item.querySelector('.remove-collection').addEventListener('click', async (e) => {
      e.stopPropagation();
      const collections = await loadCollections();
      const updated = collections.filter(t => t.id !== collection.id);
      await saveCollections(updated);
      // Clean up pinned results for this collection
      if (allCollectionPins[collection.id]) {
        delete allCollectionPins[collection.id];
        await saveAllCollectionPins();
      }
      renderCollections();
      if (activeView.type === 'collection' && activeView.id === collection.id) {
        showCategory('all');
      }
    });

    // Drag-and-drop: collection as drop target (counter prevents child-triggered dragleave)
    let dragCounter = 0;
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    item.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        item.classList.remove('drag-over');
      }
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      item.classList.remove('drag-over');
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (data.url && !isResultPinned(collection.id, data.url)) {
          await toggleResultPin(collection.id, data.url, data.title);
          // If we're viewing this collection, refresh
          if (activeView.type === 'collection' && activeView.id === collection.id) {
            showCollection(collection);
          }
        }
      } catch (err) {
        console.error('Drop error:', err);
      }
    });

    list.appendChild(item);
  }

  updateSidebarActive();
}

async function pinCurrentSearch() {
  if (activeView.type === 'explore') {
    // Pin explore query tree — enter naming mode
    if (!qbRoot || !treeHasConfiguredPredicate(qbRoot)) return;
    const autoName = qbSummarize(qbRoot);

    pendingPin = {
      query: autoName,
      qbTree: JSON.parse(JSON.stringify(qbRoot)), // deep clone
    };

    enterTitleEditMode(autoName, async (name) => {
      const pin = pendingPin;
      pendingPin = null;
      if (!pin) return;

      const collections = await loadCollections();
      const collection = {
        id: Date.now().toString(),
        query: pin.query,
        name: name !== pin.query ? name : undefined,
        qbTree: pin.qbTree,
      };
      collections.push(collection);
      await saveCollections(collections);
      await renderCollections();
      showCollection(collection);
    }, () => {
      // Escape: cancel pin, restore explore view
      pendingPin = null;
      updateMainTitle('Explore');
      document.getElementById('pinSearchBtn').style.display =
        treeHasConfiguredPredicate(qbRoot) ? 'flex' : 'none';
    });
    return;
  }

  const query = activeView.query;
  if (!query) return;
  if (activeView.type !== 'search') return;

  pendingPin = { query };

  enterTitleEditMode(query, async (name) => {
    const pin = pendingPin;
    pendingPin = null;
    if (!pin) return;

    const collections = await loadCollections();
    if (collections.some(t => t.query === pin.query)) return;

    const collection = {
      id: Date.now().toString(),
      query: pin.query,
      name: name !== pin.query ? name : undefined,
    };
    collections.push(collection);
    await saveCollections(collections);
    await renderCollections();
    showCollection(collection);
  }, () => {
    pendingPin = null;
    updateMainTitle(query);
    document.getElementById('pinSearchBtn').style.display = 'flex';
  });
}

// --- Utility ---
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- Event listeners: Sidebar categories ---
document.querySelectorAll('.sidebar-item[data-category]').forEach(item => {
  item.addEventListener('click', () => {
    showCategory(item.dataset.category);
  });
});

// --- Event listeners: Explore button ---
document.getElementById('exploreBtn').addEventListener('click', () => {
  showExplore();
});


// --- Event listeners: Pin search ---
document.getElementById('pinSearchBtn').addEventListener('click', pinCurrentSearch);

// --- Event listeners: Del key to delete selected rows ---
document.addEventListener('keydown', async (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    const selectedRows = document.querySelectorAll('.result-row.selected');
    if (selectedRows.length === 0) return;

    const isRecycleBinView = activeView.type === 'category' && activeView.value === 'recycleBin';

    if (!isRecycleBinView && !isDeletableView()) return;

    e.preventDefault();
    if (isRecycleBinView) {
      for (const row of selectedRows) {
        await permanentlyDeleteItem(row.dataset.url);
      }
    } else {
      for (const row of selectedRows) {
        await handleDelete(row.dataset.url, row.dataset.title);
      }
    }
    lastClickedRow = null;
    refreshCurrentView();
  }
});

// --- Marquee drag-select from results background ---
function initMarqueeForElements(wrapper, container) {
  let band = null;
  let startX = 0;
  let startY = 0;
  let didDrag = false;

  function ensureBand() {
    band = wrapper.querySelector('.select-band');
    if (!band) {
      band = document.createElement('div');
      band.className = 'select-band';
      wrapper.appendChild(band);
    }
    return band;
  }

  wrapper.addEventListener('mousedown', (e) => {
    // Only start marquee from the background, not from interactive content
    if (e.target.closest('.result-item, .column-header-row')) return;

    e.preventDefault();
    const wrapperRect = wrapper.getBoundingClientRect();
    startX = e.clientX - wrapperRect.left;
    startY = e.clientY - wrapperRect.top;
    didDrag = false;
    marqueeActive = true;

    const b = ensureBand();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;

    if (!additive) {
      container.querySelectorAll('.result-row.selected').forEach(r => r.classList.remove('selected'));
    }

    const onMouseMove = (ev) => {
      const currentWrapperRect = wrapper.getBoundingClientRect();
      const currentX = ev.clientX - currentWrapperRect.left;
      const currentY = ev.clientY - currentWrapperRect.top;
      const minX = Math.min(startX, currentX);
      const maxX = Math.max(startX, currentX);
      const minY = Math.min(startY, currentY);
      const maxY = Math.max(startY, currentY);

      if (Math.abs(currentY - startY) > 3 || Math.abs(currentX - startX) > 3) didDrag = true;

      b.style.display = 'block';
      b.style.left = minX + 'px';
      b.style.top = minY + 'px';
      b.style.width = (maxX - minX) + 'px';
      b.style.height = (maxY - minY) + 'px';

      container.querySelectorAll('.result-row').forEach(row => {
        const rowRect = row.getBoundingClientRect();
        const rowTop = rowRect.top - currentWrapperRect.top;
        const rowBottom = rowTop + rowRect.height;

        if (rowBottom > minY && rowTop < maxY) {
          row.classList.add('selected');
        } else if (!additive) {
          row.classList.remove('selected');
        }
      });
    };

    const onMouseUp = () => {
      b.style.display = 'none';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      syncChartHighlights();

      setTimeout(() => { marqueeActive = false; }, 0);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Init marquee for global results
initMarqueeForElements(
  document.getElementById('resultsWrapper'),
  document.getElementById('results')
);
// Init marquee for collection sections
initMarqueeForElements(
  document.getElementById('pinnedResultsWrapper'),
  document.getElementById('pinnedResults')
);
initMarqueeForElements(
  document.getElementById('relatedResultsWrapper'),
  document.getElementById('relatedResults')
);

// --- Section collapse toggle ---
document.querySelectorAll('.section-header[data-collapse]').forEach(header => {
  header.addEventListener('click', () => {
    header.classList.toggle('collapsed');
  
  });
});

// --- Settings modal ---
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.add('open');
  updateStorageStatus();
  updateStatistics();
  renderBlacklist();
  renderTrimRules();
});

document.getElementById('settingsClose').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.remove('open');
});

document.getElementById('settingsModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('open');
  }
});

// --- Settings: Storage ---
async function updateStorageStatus() {
  const info = await fsStorage.getDirectoryInfo();

  const locationDiv = document.getElementById('storageLocation');
  const statusSpan = document.getElementById('storageStatus');
  const pathContainer = document.getElementById('storagePathContainer');
  const pathSpan = document.getElementById('storagePath');
  const selectBtn = document.getElementById('selectDirBtn');
  const changeBtn = document.getElementById('changeDirBtn');

  if (info && info.hasPermission) {
    locationDiv.className = 'storage-location';
    statusSpan.textContent = 'Connected';
    statusSpan.style.color = '#137333';
    pathContainer.style.display = 'block';
    pathSpan.textContent = info.name + '/';
    selectBtn.style.display = 'none';
    changeBtn.style.display = 'inline-block';
  } else {
    locationDiv.className = 'storage-location not-configured';
    statusSpan.textContent = 'Not configured - please select a directory';
    statusSpan.style.color = '#c5221f';
    pathContainer.style.display = 'none';
    selectBtn.style.display = 'inline-block';
    changeBtn.style.display = 'none';
  }
}

async function updateStatistics() {
  try {
    const interactions = await fsStorage.loadAllInteractions();
    document.getElementById('totalInteractions').textContent = interactions.length;

    const today = new Date().setHours(0, 0, 0, 0);
    const todayCount = interactions.filter(i => i.timestamp >= today).length;
    document.getElementById('todayInteractions').textContent = todayCount;
  } catch (error) {
    console.log('Could not load from filesystem:', error.message);
    document.getElementById('totalInteractions').textContent = '0';
    document.getElementById('todayInteractions').textContent = '0';
  }

  chrome.storage.local.get(['writeBuffer'], (result) => {
    const buffer = result.writeBuffer || [];
    document.getElementById('bufferSize').textContent = buffer.length;
  });
}

// Select directory
document.getElementById('selectDirBtn').addEventListener('click', async () => {
  try {
    const result = await fsStorage.selectDirectory();
    if (result.success) {
      await updateStorageStatus();
      showStatus(`Storage location set: ${result.name}`, 'success');
      chrome.runtime.sendMessage({ action: 'initializeFilesystem' });
      // Reload data for main view
      cachedData = null; cachedFieldRanges = null;
      showCategory(activeView.type === 'category' ? activeView.value : 'all');
    } else if (result.error !== 'User cancelled') {
      showStatus(`Error: ${result.error}`, 'error');
    }
  } catch (error) {
    showStatus(`Error selecting directory: ${error.message}`, 'error');
  }
});

// Change directory
document.getElementById('changeDirBtn').addEventListener('click', async () => {
  if (!confirm('Change storage directory? This will migrate all existing data to the new location.')) {
    return;
  }

  const changeDirBtn = document.getElementById('changeDirBtn');
  changeDirBtn.disabled = true;
  changeDirBtn.textContent = 'Changing...';

  try {
    const oldInteractions = await fsStorage.loadAllInteractions();
    let oldContentMap = {};
    try {
      oldContentMap = await fsStorage.loadAllContent();
    } catch (error) {
      console.log('Could not load old content:', error.message);
    }

    for (const interaction of oldInteractions) {
      if (interaction.content && interaction.slug && !oldContentMap[interaction.slug]) {
        oldContentMap[interaction.slug] = interaction.content;
      }
    }

    const result = await fsStorage.selectDirectory();

    if (!result.success) {
      if (result.error !== 'User cancelled') {
        showStatus(`Error: ${result.error}`, 'error');
      }
      changeDirBtn.disabled = false;
      changeDirBtn.textContent = 'Change Directory';
      return;
    }

    if (oldInteractions.length > 0) {
      showStatus(`Migrating ${oldInteractions.length} interactions...`, 'warning');
      const migrateResult = await fsStorage.writeAllInteractions(oldInteractions, oldContentMap);
      if (migrateResult.success) {
        showStatus(`Migrated ${oldInteractions.length} interactions to ${result.name}`, 'success');
      } else {
        showStatus(`Error migrating data: ${migrateResult.error}`, 'error');
      }
    } else {
      showStatus(`Storage location changed to: ${result.name}`, 'success');
    }

    await updateStorageStatus();
    await updateStatistics();
    chrome.runtime.sendMessage({ action: 'initializeFilesystem' });
    cachedData = null; cachedFieldRanges = null;
  } catch (error) {
    showStatus(`Error changing directory: ${error.message}`, 'error');
  }

  changeDirBtn.disabled = false;
  changeDirBtn.textContent = 'Change Directory';
});

// Save settings on change
['captureContent', 'captureAttention', 'archiveQuality'].forEach(id => {
  const element = document.getElementById(id);
  element.addEventListener('change', () => {
    chrome.storage.local.get(['settings'], (result) => {
      const settings = result.settings || {};
      if (id === 'archiveQuality') {
        settings[id] = element.value;
      } else {
        settings[id] = element.checked;
      }
      chrome.storage.local.set({ settings });
      showStatus('Settings saved', 'success');
    });
  });
});

// Clear all data
document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('WARNING: This will DELETE ALL FILES in your storage directory!\n\nThis cannot be undone. Are you absolutely sure?')) {
    return;
  }
  if (!confirm('Final confirmation: Delete all interaction history files?')) {
    return;
  }

  const clearBtn = document.getElementById('clearBtn');
  clearBtn.disabled = true;
  clearBtn.textContent = 'Clearing...';

  try {
    const info = await fsStorage.getDirectoryInfo();
    if (!info || !info.hasPermission) {
      showStatus('No storage directory configured', 'error');
      clearBtn.disabled = false;
      clearBtn.textContent = 'Clear All Data';
      return;
    }

    await fsStorage.loadDirectoryHandle();
    let deletedCount = 0;

    for await (const entry of fsStorage.directoryHandle.values()) {
      if (entry.kind === 'file' && (entry.name.endsWith('.jsonl') || entry.name === 'README.md')) {
        await fsStorage.directoryHandle.removeEntry(entry.name);
        deletedCount++;
      }
    }

    try {
      await fsStorage.directoryHandle.removeEntry('pages', { recursive: true });
      deletedCount++;
    } catch (error) {}

    await chrome.storage.local.set({ writeBuffer: [] });
    showStatus(`Cleared ${deletedCount} files/directories`, 'success');
    await updateStatistics();
    cachedData = null; cachedFieldRanges = null;
    showCategory('all');
  } catch (error) {
    showStatus(`Error clearing data: ${error.message}`, 'error');
  }

  clearBtn.disabled = false;
  clearBtn.textContent = 'Clear All Data';
});

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;
  setTimeout(() => { status.className = 'status'; }, 5000);
}

// --- URL Blacklist ---
const DEFAULT_BLACKLIST = ['chrome://', 'edge://'];

async function loadBlacklist() {
  const result = await chrome.storage.local.get(['urlBlacklist']);
  if (result.urlBlacklist === undefined) {
    await saveBlacklist(DEFAULT_BLACKLIST);
    return [...DEFAULT_BLACKLIST];
  }
  return result.urlBlacklist;
}

async function saveBlacklist(list) {
  await chrome.storage.local.set({ urlBlacklist: list });
}

async function renderBlacklist() {
  const list = await loadBlacklist();
  const container = document.getElementById('blacklistEntries');

  if (list.length === 0) {
    container.innerHTML = '<div class="blacklist-empty">No blocked URL prefixes</div>';
    return;
  }

  container.innerHTML = list.map((prefix, idx) =>
    `<div class="blacklist-entry">
      <span>${escapeHtml(prefix)}</span>
      <button class="blacklist-remove" data-index="${idx}" title="Remove">&times;</button>
    </div>`
  ).join('');

  container.querySelectorAll('.blacklist-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const current = await loadBlacklist();
      current.splice(parseInt(btn.dataset.index), 1);
      await saveBlacklist(current);
      renderBlacklist();
    });
  });
}

document.getElementById('blacklistAddBtn').addEventListener('click', async () => {
  const input = document.getElementById('blacklistInput');
  const prefix = input.value.trim();
  if (!prefix) return;

  const list = await loadBlacklist();
  if (list.includes(prefix)) {
    input.value = '';
    return;
  }

  list.push(prefix);
  await saveBlacklist(list);
  input.value = '';
  renderBlacklist();
});

document.getElementById('blacklistInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('blacklistAddBtn').click();
});

// --- Title Trimming Rules ---
const TRIM_ACTION_LABELS = {
  remove_after_pipe: 'Remove after |',
  remove_brackets: 'Remove [brackets]',
  remove_parens: 'Remove (parens)'
};

async function loadTrimRules() {
  const result = await chrome.storage.local.get(['titleTrimRules']);
  return result.titleTrimRules || [];
}

async function saveTrimRules(rules) {
  await chrome.storage.local.set({ titleTrimRules: rules });
}

async function renderTrimRules() {
  const rules = await loadTrimRules();
  const container = document.getElementById('trimEntries');

  if (rules.length === 0) {
    container.innerHTML = '<div class="blacklist-empty">No trimming rules</div>';
    return;
  }

  container.innerHTML = rules.map((rule, idx) =>
    `<div class="blacklist-entry">
      <span>${escapeHtml(rule.urlPrefix)}</span>
      <span class="trim-action-label">${escapeHtml(TRIM_ACTION_LABELS[rule.action] || rule.action)}</span>
      <button class="blacklist-remove" data-index="${idx}" title="Remove">&times;</button>
    </div>`
  ).join('');

  container.querySelectorAll('.blacklist-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const current = await loadTrimRules();
      current.splice(parseInt(btn.dataset.index), 1);
      await saveTrimRules(current);
      renderTrimRules();
    });
  });
}

document.getElementById('trimAddBtn').addEventListener('click', async () => {
  const urlInput = document.getElementById('trimUrlInput');
  const actionSelect = document.getElementById('trimActionSelect');
  const prefix = urlInput.value.trim();
  if (!prefix) return;

  const rules = await loadTrimRules();
  // Don't add duplicate prefix+action
  if (rules.some(r => r.urlPrefix === prefix && r.action === actionSelect.value)) {
    urlInput.value = '';
    return;
  }

  rules.push({ urlPrefix: prefix, action: actionSelect.value });
  await saveTrimRules(rules);
  urlInput.value = '';
  renderTrimRules();
});

document.getElementById('trimUrlInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('trimAddBtn').click();
});

// --- Initialize ---
async function initialize() {
  // Load settings
  chrome.storage.local.get(['settings'], (result) => {
    const settings = result.settings || {};
    document.getElementById('captureContent').checked = settings.captureContent !== false;
    document.getElementById('captureAttention').checked = settings.captureAttention !== false;
    document.getElementById('archiveQuality').value = settings.archiveQuality || 'medium';
  });

  // Initialize query builder
  qbRoot = qbCreatePlaceholder();

  // Load data and show default view
  await loadData();
  await loadAllCollectionPins();
  await loadRecycleBin();
  await loadGatewayDomains();
  updateRecycleSidebarCount();
  await renderCollections();
  renderBlacklist();
  renderTrimRules();
  showCategory('all');
}

initialize();
