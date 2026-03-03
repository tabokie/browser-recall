// Options page for Portal extension
// Bookmark-manager style UI with sidebar navigation, search, and settings modal
import { FileSystemStorage } from './filesystem-storage.js';
import init, { Interaction, SearchEngine, searchBatch } from './pkg/portal_extension.js';
import { mergeBufferIntoInteractions, getBufferContentMap, buildInteractionsForEngine, extractInteractionBuffer } from './search-helpers.js';
import { generateSlugFromUrl, generateSlugFromTitle, loadSettingsValue, saveSettingsValue, readCacheable, sendAction, collectQbTrees, qbTreesChanged, isGatewayRoot, escapeHtml } from './utils.js';
import { findRelatedPages } from './related-scoring.js';
import { attentionStrength, attentionColor, aggregateAttention } from './attention-utils.js';
import { qbCreatePredicate, qbCreateOperator, qbCreatePlaceholder, qbFindNode, qbCollapseTree, qbFlattenSameOp, qbToTree, qbFlatten } from './qb-tree.js';
import { initCharts, renderTimeChart, renderTimeChartInto, bindChartBarClick, syncChartHighlights, applyDateFilter } from './time-chart.js';
import { VirtualScroller } from './virtual-scroller.js';

const fsStorage = new FileSystemStorage();

// ─── Error UI ────────────────────────────────────────────────────────

function showFatalError(message) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#fff;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  overlay.innerHTML = `
    <div style="color:#b41e1e;font-size:18px;font-weight:600;">Storage Unavailable</div>
    <div style="color:#555;font-size:14px;max-width:480px;text-align:center;">${escapeHtml(message)}</div>
    <button id="fatalReloadBtn" style="margin-top:8px;padding:6px 16px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:13px;">Reload Extension</button>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#fatalReloadBtn').addEventListener('click', () => chrome.runtime.reload());
}

let _errorBubbleTimer = null;
function showErrorBubble(message) {
  let bubble = document.getElementById('errorBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'errorBubble';
    bubble.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(180,30,30,0.92);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;';
    document.body.appendChild(bubble);
  }
  bubble.textContent = message + ' — please reload the extension.';
  bubble.style.opacity = '1';
  clearTimeout(_errorBubbleTimer);
  _errorBubbleTimer = setTimeout(() => { bubble.style.opacity = '0'; }, 4000);
}


// --- State ---
let currentSortState = { column: null, direction: null };
let pinnedSortState = { column: null, direction: null };
let relatedSortState = { column: null, direction: null };
let currentExtraColumns = [];
let pinnedExtraColumns = [];
let relatedExtraColumns = [];
let wasmInitialized = false;
// --- Demand-loaded history ---
let historyFileBatch = 10;        // files per load (configurable in settings)
const HISTORY_MAX_FILES = 100;    // cap total loaded files
let historyFiles = [];             // all JSONL filenames, newest-first
let historyLoadedCount = 0;        // how many files loaded so far
let historyByUrl = new Map();      // url → interaction (deduped, newest wins)
let historyAllEntries = [];        // all loaded entries (not deduped), for date-boundary rendering
let historyLoading = false;        // guard against concurrent loads
let activeView = { type: 'category', value: 'all' }; // or { type: 'search', query: '...' } or { type: 'list', query: '...', id: '...' } or { type: 'explore', query: '...', filter: '...' }
let allListPins = {}; // listId -> [{ url, title, pinnedAt }]
let lastClickedRow = null; // for shift-click range select
let marqueeActive = false; // suppress click during marquee drag
let gatewayOriginsCache = []; // [origin, ...]
let gatewayOriginsLoaded = false;
let bufferContentMap = {}; // slug → markdown from write buffer (small, kept in memory)
// pinnedFilterCtx removed — pinned section no longer has related pages
const EXPLORE_LIST_ID = 'explore';
// List results and page data are cached in chrome.storage.session
// (managed by background for pages, by options for list results).
// Keys: 'page:{slug}' for pages, 'listCache:{slug}' for list results.
let listCacheKeys = []; // tracks which listCache:* keys exist in session

// --- Query builder state ---
let qbRoot = null;        // tree root (null = empty)
let cachedAllNotes = null; // slug → [noteEntity, ...], lazy-loaded
let qbDebounceTimer = null;
let savedExploreQbRoot = null;  // saved global explore QB state when viewing a list

// --- Explore blocks state ---
let exploreBlocks = []; // [{ id, type:'auto'|'manual', label, enabled, urls?:Set, tree? }]
let exploreBlockIdCounter = 0;
let activeBlockId = null; // which block's QB tree is currently being edited

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
let relatedPagesLimit = 50; // configurable in settings

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
    const vals = {
      lastVisit, firstVisit, visitCount,
      timeOnPage: latest.timeOnPage || 0,
      scrollDepth: latest.scrollDepth || 0,
      clicks: latest.clicks || 0,
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
  if (historyByUrl.size === 0) return null;
  cachedFieldRanges = computeFieldRanges(Array.from(historyByUrl.values()));
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

// --- Pipelined search ---
let capturesMatchCache = null; // Map<queryString, Set<url>> — cleared on history reset

async function pipelinedSearch(query) {
  await initWasm();
  await fsStorage.loadDirectoryHandle();
  const rootDir = fsStorage.directoryHandle;
  if (!rootDir) throw new Error('No storage directory configured');
  const historyDir = await rootDir.getDirectoryHandle('history');
  const pagesDir = await rootDir.getDirectoryHandle('pages');

  const filesResp = await sendAction({ action: 'listInteractionFiles' });
  const files = filesResp.files;

  // Write buffer overlay — read undrained entries before WASM processes JSONL on disk
  const { logBuffer = [] } = await chrome.storage.local.get(['logBuffer']);
  const interactionBuffer = extractInteractionBuffer(logBuffer);
  bufferContentMap = getBufferContentMap(interactionBuffer);

  // WASM reads files directly (no JS↔WASM data copy)
  const CHUNK = 10;
  const chunks = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    chunks.push(files.slice(i, i + CHUNK));
  }

  const byUrl = new Map();
  const batchResults = await Promise.all(
    chunks.map(chunk => searchBatch(historyDir, pagesDir, query, chunk))
  );
  for (const results of batchResults) {
    for (const r of results) {
      const existing = byUrl.get(r.url);
      if (!existing || r.score > existing.score) byUrl.set(r.url, r);
    }
  }

  // Also search log buffer entries
  if (interactionBuffer.length > 0) {
    const engine = new SearchEngine();
    buildInteractionsForEngine(Interaction, engine, interactionBuffer, bufferContentMap);
    const bufferResults = await engine.search(query, 0);
    for (const r of bufferResults) {
      const existing = byUrl.get(r.url);
      if (!existing || r.score > existing.score) byUrl.set(r.url, r);
    }
  }

  const allResults = Array.from(byUrl.values());
  allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
  return allResults;
}

// --- Pre-compute captures matches for QB ---
function extractCapturesQueries(node) {
  const queries = new Set();
  if (!node) return queries;
  if (node.type === 'operator') {
    for (const child of node.children) {
      for (const q of extractCapturesQueries(child)) queries.add(q);
    }
    return queries;
  }
  if (node.predicateType === 'keyword' && node.value && node.value.trim()) {
    const fields = normalizeFieldToArray(node.field);
    if (fields.includes('captures')) {
      queries.add(node.value.trim());
    }
  }
  return queries;
}

async function precomputeCapturesMatches(queries) {
  const cache = new Map();
  for (const query of queries) {
    const results = await pipelinedSearch(query);
    const urlSet = new Set(results.map(r => r.url));
    cache.set(query, urlSet);
  }
  return cache;
}

// --- Demand-loaded history ---

async function initHistoryFiles() {
  if (historyFiles.length > 0) return;

  // Always get file list from offscreen (no session cache for file list)
  try {
    const resp = await sendAction({ action: 'listInteractionFiles' });
    historyFiles = resp.files;
  } catch (error) {
    console.log('Filesystem not available:', error.message);
  }

  // Merge today's history — session cache has disk + undrained entries via addLog
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayEntries = await readCacheable('history:' + todayStr) || [];
  const interactionBuffer = todayEntries.filter(e => (e.action === 'page' || !e.action) && e.url);
  for (const entry of interactionBuffer) {
    const existing = historyByUrl.get(entry.url);
    if (!existing || entry.timestamp > existing.timestamp) {
      historyByUrl.set(entry.url, entry);
      // Preserve title/user_title from older entry if new one lacks it
      if (existing && existing.title && !entry.title) entry.title = existing.title;
      if (existing && existing.user_title && !entry.user_title) entry.user_title = existing.user_title;
    } else if (entry.title && !existing.title) {
      existing.title = entry.title;
    }
    if (entry.user_title && (!existing || !existing.user_title)) {
      if (existing) existing.user_title = entry.user_title;
    }
    historyAllEntries.push(entry);
  }
  bufferContentMap = getBufferContentMap(interactionBuffer);
}

async function loadHistoryBatch() {
  if (historyLoading || historyLoadedCount >= historyFiles.length
      || historyLoadedCount >= HISTORY_MAX_FILES) return [];
  historyLoading = true;
  const batch = historyFiles.slice(historyLoadedCount, historyLoadedCount + historyFileBatch);
  try {
    const t0 = performance.now();
    const resp = await sendAction({ action: 'loadInteractionBatch', files: batch });
    const interactions = resp.interactions;
    const newItems = [];
    // Entries within a day file arrive oldest→newest. This isn't a full replay,
    // but we simulate replay semantics: newer values always win, and older
    // values are only kept when the newer entry omits the field (the "omit
    // unchanged fields" optimisation in background.js means later entries
    // often lack a title when it hasn't changed since the previous write).
    for (const item of interactions) {
      // Skip non-visit entries (set, highlight, list, etc.)
      if ((item.action && item.action !== 'page') || !item.url) continue;
      historyAllEntries.push(item);
      const existing = historyByUrl.get(item.url);
      if (!existing) {
        historyByUrl.set(item.url, item);
      } else {
        if (item.title) existing.title = item.title;
        if (item.user_title) existing.user_title = item.user_title;
      }
      newItems.push(item);
    }
    console.debug(`[I/O] loadHistoryBatch: ${batch.length} files, ${interactions.length} items, ${newItems.length} new in ${(performance.now() - t0).toFixed(1)}ms`);
    historyLoadedCount += batch.length;
    historyLoading = false;
    return newItems;
  } catch (error) {
    console.log('Error loading history batch:', error.message);
    historyLoading = false;
    return [];
  }
}

function resetHistory() {
  historyFiles = [];
  historyLoadedCount = 0;
  historyByUrl.clear();
  historyAllEntries = [];
  historyLoading = false;
  cachedFieldRanges = null;
  capturesMatchCache = null;
  // Invalidate list results in session
  if (listCacheKeys.length > 0) {
    chrome.storage.session.remove(listCacheKeys.map(id => 'listCache:' + id));
    listCacheKeys = [];
  }
  allListPins = {};
  cachedAllNotes = null;
  gatewayOriginsCache = [];
  gatewayOriginsLoaded = false;
  bufferContentMap = {};
}


function getActivePinListId() {
  if (activeView.type === 'explore') return EXPLORE_LIST_ID;
  if (activeView.type === 'list') return activeView.id;
  return EXPLORE_LIST_ID; // default: pin to explore
}

function pinIdToUrl(id) {
  if (id.startsWith('shallow:')) return id.slice(8);
  // page:<slug> — need to resolve via page entity. Return null if can't resolve here.
  return null;
}

function slugFromPinId(id) {
  if (id.startsWith('page:')) return id.slice(5);
  if (id.startsWith('shallow:')) return generateSlugFromUrl(id.slice(8));
}

// Resolve a typed page reference to entity-like data, or null.
// page:<slug> → page entity from pageSnap. shallow:<url> → metadata from shallowPageIndex.
// Unreferenced shallow pages return null.
function resolvePageRef(refId, pageSnap, spi) {
  if (!refId) return null;
  if (refId.startsWith('page:')) {
    return pageSnap?.get(refId.slice(5)) || null;
  }
  if (refId.startsWith('shallow:')) {
    const url = refId.slice(8);
    const entry = spi?.index?.[url];
    if (!entry) return null;
    return { url, title: entry.title || null, user_title: entry.user_title || null, parentIds: entry.parentIds || [], lists: entry.lists || [] };
  }
  return null;
}

// Load page entities + shallowPageIndex for a set of pins.
// Session cache first, filesystem fallback for page: slugs not in session.
async function loadPinContext(pins) {
  const pagePinSlugs = [];
  for (const p of pins) {
    if (p.id?.startsWith('page:')) pagePinSlugs.push(p.id.slice(5));
  }
  const sessionKeys = [...pagePinSlugs.map(s => 'page:' + s), 'list:system/shallow-page'];
  const sessionBatch = sessionKeys.length > 0 ? await chrome.storage.session.get(sessionKeys) : {};
  let spi = sessionBatch['list:system/shallow-page'];
  if (!spi) {
    const spiResp = await chrome.runtime.sendMessage({ action: 'getShallowPageIndex' });
    if (spiResp?.success === false) throw new Error(spiResp.error || 'Failed to load shallow page index');
    spi = spiResp;
  }
  const pageSnap = new Map();
  const missingSlugs = [];
  for (const slug of pagePinSlugs) {
    const page = sessionBatch['page:' + slug];
    if (page) pageSnap.set(slug, page);
    else missingSlugs.push(slug);
  }
  if (missingSlugs.length > 0) {
    const resp = await sendAction({ action: 'loadPageBatch', slugs: missingSlugs });
    for (const [slug, page] of Object.entries(resp.pages || {})) pageSnap.set(slug, page);
  }
  return { pageSnap, spi };
}

function isResultPinned(listId, url) {
  const pins = allListPins[listId] || [];
  const pageId = 'page:' + generateSlugFromUrl(url);
  const shallowId = 'shallow:' + url;
  return pins.some(p => p.id === pageId || p.id === shallowId || p.url === url);
}

async function toggleResultPin(listId, url, title) {
  if (!allListPins[listId]) allListPins[listId] = [];
  const pins = allListPins[listId];
  const slug = generateSlugFromUrl(url);
  const pageId = `page:${slug}`;
  const shallowId = 'shallow:' + url;
  const idx = pins.findIndex(p => p.id === pageId || p.id === shallowId || p.url === url);
  if (idx !== -1) {
    pins.splice(idx, 1);
  } else {
    pins.push({ id: pageId, pinnedAt: Date.now() });
  }
  await chrome.runtime.sendMessage({ action: 'toggleListPin', listId, url });
}

// --- Layout switching (list vs normal) ---
function showListLayout() {
  saveExploreQbState();
  document.getElementById('timeChart').classList.remove('visible');
  document.getElementById('resultsWrapper').style.display = 'none';
  document.getElementById('listLayout').classList.add('visible');
  document.getElementById('queryBuilder').style.display = 'none';
}

function showNormalLayout() {
  document.getElementById('resultsWrapper').style.display = '';
  document.getElementById('listLayout').classList.remove('visible');
  restoreExploreQbState();
}

function saveExploreQbState() {
  if (savedExploreQbRoot === null) {
    savedExploreQbRoot = qbRoot;
  }
}

function restoreExploreQbState() {
  if (savedExploreQbRoot !== null) {
    qbRoot = savedExploreQbRoot;
    savedExploreQbRoot = null;
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
        av = (a.user_title || a.title || '').toLowerCase();
        bv = (b.user_title || b.title || '').toLowerCase();
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
  const { hasDelete = false, hasPin = false, showRelevance = false } = opts;

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
  if (container._colHeaderDelegationBound) return;
  container._colHeaderDelegationBound = true;

  container.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.col-add-btn');
    if (addBtn) {
      e.stopPropagation();
      const context = addBtn.dataset.context;
      showColumnPopover(addBtn, context);
      return;
    }

    const header = e.target.closest('.col-header');
    if (!header) return;
    const col = header.dataset.col;
    const headerRow = header.closest('.column-header-row');
    if (!headerRow) return;
    const context = headerRow.dataset.context;
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
    resortActiveScroller(context);
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


// Show chart frame + column headers immediately (bars and rows fill in after data loads)
function renderResultsSkeleton(opts = {}) {
  const { showRelevance = false } = opts;
  const chartEl = document.getElementById('timeChart');
  chartEl.querySelector('.chart-bars').innerHTML = '';
  chartEl.classList.add('visible');

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = columnHeaderHtml('global', { hasPin: false, showRelevance });
  vs.setData([], () => '');
}

// Show list chart frames + column headers immediately
function renderListSkeleton() {
  // Pinned section: show column header
  const pinnedSection = document.querySelector('.list-section[data-section="pinned"]');
  pinnedSection.style.display = '';
  const pinnedContainer = document.getElementById('pinnedResults');
  pinnedContainer.innerHTML = columnHeaderHtml('pinned', { hasPin: true });
  bindColumnHeaderClicks(pinnedContainer);

  // Explore section: show chart frame + column header
  const relatedChart = document.getElementById('relatedChart');
  relatedChart.querySelector('.chart-bars').innerHTML = '';
  relatedChart.classList.add('visible');
  const vs = getOrCreateRelatedScroller();
  vs._headerHtml = columnHeaderHtml('related', { hasPin: true, showRelevance: false });
  vs.setData([], () => '');
}

function refreshCurrentView() {
  if (activeView.type === 'category') {
    showCategory(activeView.value);
  } else if (activeView.type === 'list') {
    showList({ slug: activeView.id, qbTrees: activeView.qbTrees, name: activeView.name });
  } else if (activeView.type === 'explore') {
    showExplore();
  }
}

function resortActiveScroller(context) {
  if (context === 'pinned') { refreshCurrentView(); return; }
  const vs = context === 'related' ? relatedVirtualScroller : globalVirtualScroller;
  if (!vs || vs.data.length === 0) { refreshCurrentView(); return; }

  const sortState = getSortState(context);
  const effectiveSort = sortState.column ? sortState : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder([...vs._fullData], effectiveSort);

  // Regenerate header with updated sort indicators
  const showRelevance = vs._headerHtml.includes('col-rel');
  const hasPin = context === 'related' || context === 'pinned';
  vs._headerHtml = columnHeaderHtml(context, { hasPin, showRelevance });

  vs.updateData(sorted);
}

// --- Category filters ---
function filterByCategory(interactions, category) {
  const now = Date.now();
  switch (category) {
    case 'today': {
      const startOfDay = new Date().setHours(0, 0, 0, 0);
      return interactions.filter(i => i.timestamp >= startOfDay);
    }
    case 'week': {
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      return interactions.filter(i => i.timestamp >= weekAgo);
    }
    case 'highlighted':
      return interactions.filter(i => (i.likes > 0));
    case 'gateways':
      return interactions.filter(i => isGatewayOrigin(i.url));
    case 'all':
    default:
      return interactions;
  }
}

async function loadGatewayDomains() {
  if (gatewayOriginsLoaded) return;
  const gateways = await readCacheable('list:system/gateways');
  gatewayOriginsCache = gateways.origins;
  gatewayOriginsLoaded = true;
}

function isGatewayOrigin(url) {
  return isGatewayRoot(url, gatewayOriginsCache);
}

// Time chart tooltips initialized via initCharts() in initialize()


// --- Display ---
async function showCategory(category) {
  activeView = { type: 'category', value: category };
  updateSidebarActive();
  const categoryLabels = { all: 'History', today: 'Today', week: 'This Week', highlighted: 'Highlighted', gateways: 'Gateways', explore: 'Explore' };
  updateMainTitle(categoryLabels[category] || category);
  document.getElementById('pinSearchBtn').style.display = 'none';
  document.getElementById('queryBuilder').style.display = 'none';

  renderResultsSkeleton();
  showNormalLayout();

  if (category === 'gateways') await loadGatewayDomains();

  // Demand-load history
  await initHistoryFiles();
  await loadHistoryBatch();
  const interactions = [...historyAllEntries];
  interactions.sort((a, b) => b.timestamp - a.timestamp);
  const filtered = filterByCategory(interactions, category);
  renderTimeChart(filtered);
  await displayInteractionRows(filtered);

  // Wire up demand-loading on scroll
  const vs = getOrCreateGlobalScroller();
  vs.onLoadMore = async () => {
    const newItems = await loadHistoryBatch();
    if (newItems.length > 0) {
      const newFiltered = filterByCategory(newItems, activeView.value);
      if (newFiltered.length > 0) {
        const sort = currentSortState.column ? currentSortState : { column: 'lastVisit', direction: 'desc' };
        const newEntries = processInteractionsForDisplay(newFiltered);
        await enrichFromEntityStorage(newEntries);
        vs.appendData(applySortOrder(newEntries, sort));
      }
      // Re-render chart with all loaded history
      const allInteractions = [...historyAllEntries];
      const allFiltered = filterByCategory(allInteractions, activeView.value);
      renderTimeChart(allFiltered);
    }
  };
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
  if (fields.includes('title') && (textMatches(item.user_title, q, exact) || textMatches(item.title, q, exact))) return true;
  if (fields.includes('url') && textMatches(item.url, q, exact)) return true;
  if (fields.includes('captures')) {
    const trimmed = value.trim();
    if (capturesMatchCache && capturesMatchCache.has(trimmed)) {
      if (capturesMatchCache.get(trimmed).has(item.url)) return true;
    }
  }
  if (fields.includes('highlights') && item.notes && item.notes.some(n => {
    if (n.excerpt === null) return false; // skip global notes
    const quotes = Array.isArray(n.excerpt) ? n.excerpt : [n.excerpt || ''];
    return quotes.some(t => textMatches(t, q, exact));
  })) return true;
  if (fields.includes('notes') && item.notes && item.notes.some(n => textMatches(n.note, q, exact))) return true;
  return false;
}

function matchSmartFilter(item, filterName) {
  if (filterName === 'gateways') return isGatewayOrigin(item.url);
  return false;
}

function matchRange(item, field, op, value, value2) {
  const cfg = RANGE_CONFIGS[field];
  let v = item[field] || 0;
  if (cfg?.isDaysAgo) {
    v = (Date.now() - v) / 86400000;
  }
  if (value != null && value2 != null) return v >= value && v <= value2;
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
  if (fields.includes('title') && (textMatches(item.user_title, q, exact) || textMatches(item.title, q, exact))) score += 2.0;
  if (fields.includes('url') && textMatches(item.url, q, exact)) score += 1.0;
  if (fields.includes('captures')) {
    const trimmed = value.trim();
    if (capturesMatchCache && capturesMatchCache.has(trimmed)) {
      if (capturesMatchCache.get(trimmed).has(item.url)) score += 1.0;
    }
  }
  if (fields.includes('highlights') && item.notes && item.notes.some(n => {
    if (n.excerpt === null) return false; // skip global notes
    const quotes = Array.isArray(n.excerpt) ? n.excerpt : [n.excerpt || ''];
    return quotes.some(t => textMatches(t, q, exact));
  })) score += 1.5;
  if (fields.includes('notes') && item.notes && item.notes.some(n => textMatches(n.note, q, exact))) score += 1.5;
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
function qbInsertOnEdge(leafId, op) {
  const placeholder = qbCreatePlaceholder(KEYWORD_FIELDS);
  if (!qbRoot || qbRoot.id === leafId) {
    // Root leaf — wrap in requested op
    qbRoot = qbCreateOperator(op, [qbRoot || placeholder, qbCreatePlaceholder(KEYWORD_FIELDS)]);
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
  node.children.push(qbCreatePlaceholder(KEYWORD_FIELDS));
  renderQueryBuilder();
}

function qbRemoveLeaf(nodeId) {
  if (!qbRoot) return;
  if (qbRoot.id === nodeId) {
    qbRoot = qbCreatePlaceholder(KEYWORD_FIELDS);
    renderQueryBuilder();
    return;
  }
  const found = qbFindNode(qbRoot, nodeId);
  if (!found?.parent) return;
  found.parent.children.splice(found.childIndex, 1);
  // Cascade collapse: single-child → unwrap, empty → remove
  qbRoot = qbCollapseTree(qbRoot);
  if (!qbRoot) qbRoot = qbCreatePlaceholder(KEYWORD_FIELDS); // only at root level
  renderQueryBuilder();
}

function qbUpdateNode(nodeId, updates) {
  const found = qbFindNode(qbRoot, nodeId);
  if (found) Object.assign(found.node, updates);
}

// --- Stream-evaluate a qbTree against all JSONL files ---
async function evaluateQueryStream(qbTree) {
  const filesResp = await sendAction({ action: 'listInteractionFiles' });
  const files = filesResp.files;
  let notesMap = {};
  if (treeNeedsHighlights(qbTree)) {
    const notesResp = await sendAction({ action: 'loadAllNotes' });
    notesMap = notesResp.notesMap || {};
    cachedAllNotes = notesMap;
  }
  await loadGatewayDomains();

  const capturesQueries = extractCapturesQueries(qbTree);
  if (capturesQueries.size > 0) {
    capturesMatchCache = await precomputeCapturesMatches(capturesQueries);
  } else {
    capturesMatchCache = null;
  }

  // Merge today's entries (session cache has disk + undrained via addLog)
  const todayEntries = await readCacheable('history:' + new Date().toISOString().slice(0, 10)) || [];
  const interactionBuffer = todayEntries.filter(e => (e.action === 'page' || !e.action) && e.url);
  const seenByDay = new Map(); // YYYYMMDD → Set<url>
  const results = [];

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  function tryAdd(item) {
    const day = dayKey(item.timestamp);
    if (!seenByDay.has(day)) seenByDay.set(day, new Set());
    const daySet = seenByDay.get(day);
    if (daySet.has(item.url)) return;
    daySet.add(item.url);
    const enriched = enrichSingle(item, notesMap);
    if (evaluateNode(qbTree, enriched)) results.push(enriched);
  }

  // Process buffer entries first (newest)
  for (const entry of interactionBuffer) tryAdd(entry);

  for (let fi = 0; fi < files.length; fi += 10) {
    const batchResp = await sendAction({ action: 'loadInteractionBatch', files: files.slice(fi, fi + 10) });
    const batchItems = batchResp.interactions;
    for (const item of batchItems) tryAdd(item);
  }
  return results;
}

// Enrich a single interaction for QB evaluation
function enrichSingle(item, notesMap) {
  const slug = item.slug || '';
  const notes = (slug && notesMap && notesMap[slug]) || [];
  const attScore = attentionStrength(item);
  return {
    url: item.url, title: item.title, user_title: item.user_title, slug, timestamps: [item.timestamp],
    attScore, attDetail: item,
    notes,
    visitCount: 1,
    lastVisit: item.timestamp,
    firstVisit: item.timestamp,
    timeOnPage: item.timeOnPage || 0,
    scrollDepth: item.scrollDepth || 0,
    clicks: item.clicks || 0,
    intent: item.intent || '',
  };
}

// --- Query builder: Query execution ---
async function runQuery() {
  const inList = activeView.type === 'list';

  if (!qbRoot || (qbRoot.type === 'predicate' && qbRoot.predicateType === null) || !treeHasConfiguredPredicate(qbRoot)) {
    if (inList) {
      saveListQbTrees();
      const relatedContainer = document.getElementById('relatedResults');
      relatedContainer.innerHTML = '<div class="no-results">Add filters to start querying</div>';
      document.getElementById('relatedChart').classList.remove('visible');
    } else {
      displayMessage(!qbRoot || (qbRoot.type === 'predicate' && qbRoot.predicateType === null)
        ? 'Add filters to start querying' : 'Configure at least one filter');
    }
    return;
  }

  if (!inList) renderResultsSkeleton();

  const matched = await evaluateQueryStream(qbRoot);

  if (inList) {
    // Save updated qbTree to list storage
    saveListQbTrees();
    runListExploreQuery(matched);
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
    notes: [], // will lazy-load on expand
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

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = columnHeaderHtml('global', { hasPin: false, showRelevance: hasKeywords });
  vs.setData(normalized, (r) =>
    resultRowHtml(r.user_title || r.title, r.url, {
      attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      notes: r.notes, timestamps: r.timestamps, context: 'global', relevance: r.relevance
    })
  );

  // Render time chart for matched results
  renderTimeChart(matched.map(r => ({ url: r.url, timestamp: r.lastVisit || Date.now(), attention: '' })));

}

async function saveListQbTrees() {
  if (activeView.type !== 'list') return;
  const trees = collectQbTrees(exploreBlocks);
  if (!qbTreesChanged(activeView.qbTrees, trees)) return;
  activeView.qbTrees = trees;
  await chrome.runtime.sendMessage({ action: 'saveListMeta', listId: activeView.id, name: activeView.name, qbTrees: trees });
}

function runListExploreQuery(matched) {
  const listId = activeView.id;
  const pinnedSlugs = new Set((allListPins[listId] || []).map(p => slugFromPinId(p.id)));
  const relatedContainer = document.getElementById('relatedResults');

  if (!matched || matched.length === 0) {
    relatedContainer.innerHTML = '<div class="no-results">No results match this query</div>';
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  // Filter out pinned results from explore
  const exploreMatched = matched.filter(r => !pinnedSlugs.has(generateSlugFromUrl(r.url)));

  if (exploreMatched.length === 0) {
    relatedContainer.innerHTML = '<div class="no-results">All matching results are already pinned</div>';
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  const hasKeywords = treeHasKeyword(qbRoot);
  const results = exploreMatched.map(item => ({
    ...item,
    relevance: hasKeywords ? computeRelevance(qbRoot, item) : 0,
    notes: item.notes || [],
  }));

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

  const vs = getOrCreateRelatedScroller();
  vs._headerHtml = columnHeaderHtml('related', { hasPin: true, showRelevance: hasKeywords });
  vs.setData(normalized, (r) =>
    resultRowHtml(r.user_title || r.title, r.url, {
      pinned: isResultPinned(listId, r.url),
      attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      notes: r.notes, timestamps: r.timestamps, context: 'related', relevance: r.relevance,
    })
  );
  bindPinClicks(relatedContainer, listId);

  // Time chart for explore results — use enriched data directly
  const chartData = exploreMatched.map(r => ({ url: r.url, timestamp: r.lastVisit || Date.now(), attention: '' }));
  renderTimeChartInto(
    document.getElementById('relatedChart'),
    document.getElementById('relatedChartBars'),
    chartData,
    'Explore results'
  );
  bindChartBarClick(document.getElementById('relatedChart'), document.getElementById('relatedResults'));

}

// --- Query builder: Rendering ---
function getActiveQbBody() {
  if (activeView.type === 'list') {
    return document.getElementById('listQbBody');
  }
  return document.getElementById('qbBody');
}

function renderQueryBuilder() {
  // In explore/list view, always use block layout
  if (activeView.type === 'explore' || activeView.type === 'list') {
    // Copy mutated qbRoot back to active block's tree
    const block = exploreBlocks.find(b => b.id === activeBlockId);
    if (block && block.type === 'manual') block.tree = qbRoot;
    renderExploreBlocks();
    saveExploreBlockState();
    return;
  }

  const body = getActiveQbBody();
  if (!body) return;

  body.classList.add('qb-mode-pro');
  body.innerHTML = renderTreeNodePro(qbRoot);
  bindQueryBuilderEvents(body);
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


function qbCountLeaves(node) {
  if (!node) return 0;
  if (node.type === 'predicate') return 1;
  if (node.type === 'operator') return node.children.reduce((sum, c) => sum + qbCountLeaves(c), 0);
  return 0;
}

function qbLeafButtons(depth, parentOp, singleLeafTree) {
  if (depth === 0) {
    // Single-node tree: only AND (use separate blocks for OR)
    if (singleLeafTree) return ['AND'];
    return ['OR', 'AND'];
  }
  // Always offer the opposite of parent — alternating pattern
  // Same-op nesting would just merge into parent, so only opposite is useful
  return parentOp === 'OR' ? ['AND'] : ['OR'];
}

function renderTreeNodePro(node, depth = 0, parentOp = null, singleLeafTree = null) {
  if (!node) return '<span style="color:#9aa0a6;font-size:12px">empty</span>';
  // Compute once at root level
  if (singleLeafTree === null) singleLeafTree = qbCountLeaves(node) <= 1;

  if (node.type === 'predicate') {
    let html = `<div class="qt-leaf" data-node-id="${node.id}">`;
    const buttons = qbLeafButtons(depth, parentOp, singleLeafTree);
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
      return renderTreeNodePro(node.children[0], depth + 1, parentOp, singleLeafTree);
    }
    // Multi-child: branching operator — clickable to add another child
    const opCls = node.op === 'OR' ? 'qt-sym-or' : 'qt-sym-and';
    let html = `<div class="qt-op" data-node-id="${node.id}">`;
    html += `<button class="qt-op-parent-btn" data-node-id="${node.id}" data-op="${node.op}" title="Add child"><span class="qt-sym ${opCls}"></span></button>`;
    html += `<div class="qt-children">`;
    for (const child of node.children) {
      html += `<div class="qt-branch">${renderTreeNodePro(child, depth + 1, node.op, singleLeafTree)}</div>`;
    }
    html += `</div>`;
    html += `</div>`;
    return html;
  }

  return '';
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
      cachedAllNotes = null;
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

  // Leaf edge buttons (insert on edge)
  body.querySelectorAll('.qt-op-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const leafId = parseInt(btn.dataset.leafId);
      qbInsertOnEdge(leafId, btn.dataset.op);
    });
  });

  // NOT toggle (negate leaf)
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

  // Parent operator buttons (add child to existing operator)
  body.querySelectorAll('.qt-op-parent-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const nodeId = parseInt(btn.dataset.nodeId);
      qbAddChild(nodeId);
    });
  });

}

function debouncedRunQuery() {
  if (qbDebounceTimer) clearTimeout(qbDebounceTimer);
  qbDebounceTimer = setTimeout(() => {
    // In explore/list view, always use block query
    if (activeView.type === 'explore' || activeView.type === 'list') {
      runExploreBlockQuery();
    } else {
      runQuery();
    }
  }, 300);
}

// Summarize a query tree into a short display name for lists
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
  const _t0 = performance.now();
  const _timer = (label) => console.debug(`[explore-timer] ${label}: ${(performance.now() - _t0).toFixed(0)}ms`);

  activeView = { type: 'explore' };
  updateSidebarActive();
  updateMainTitle('Explore');
  document.getElementById('pinSearchBtn').style.display = 'flex';

  // Always use list layout with block-based explore
  showListLayout();
  renderListSkeleton();

  const listId = EXPLORE_LIST_ID;
  // Lazy-load explore pins (may have been invalidated by visibilitychange)
  if (!allListPins[listId]) {
    const pinsResp = await sendAction({ action: 'loadListPinsById', listId });
    allListPins[listId] = pinsResp.pins;
  }
  const pins = getExplorePins();
  _timer('load explore pins');

  // Hide pinned section when no pins
  const pinnedSection = document.querySelector('.list-section[data-section="pinned"]');
  if (pins.length === 0) {
    pinnedSection.style.display = 'none';
  } else {
    const { pageSnap, spi } = await loadPinContext(pins);
    const pinsResolved = pins.map(p => {
      const ref = resolvePageRef(p.id, pageSnap, spi);
      return { ...p, url: ref?.url || '', title: ref?.title || '', user_title: ref?.user_title || null };
    });

    function enrichResult(r) {
      const slug = r.slug || generateSlugFromUrl(r.url);
      const cached = pageSnap.get(slug);
      const source = (cached && cached.watermark > (r.watermark || 0)) ? cached : r;
      const attScore = source.attDetail ? attentionStrength(source.attDetail) : (source.attScore || attentionStrength(source));
      const attDetail = source.attDetail || source;
      const rSlug = slug;
      const pin = pins.find(p => slugFromPinId(p.id) === rSlug);
      const enriched = {
        ...r, slug, attScore, attDetail,
        notes: source.notes || r.notes || [],
        timestamps: [source.watermark || r.watermark || r.pinnedAt || Date.now()],
        pinnedAt: pin ? pin.pinnedAt : (r.pinnedAt || null),
      };
      if (source.user_title) enriched.user_title = source.user_title;
      return enriched;
    }

    const fullPinned = pinsResolved.map(enrichResult);
    renderPinnedSection(fullPinned, listId);
    _timer('render pinned section');
  }

  // Load history for block evaluation and fallback display
  await initHistoryFiles();
  _timer('initHistoryFiles');
  await loadHistoryBatch();
  _timer('loadHistoryBatch');

  // Build auto-blocks from pins (empty array if no pins)
  exploreBlocks = pins.length > 0 ? await buildExploreAutoBlocks(pins) : [];
  _timer('buildExploreAutoBlocks');

  // Restore saved block state (enabled flags + manual blocks)
  const { exploreBlockState } = await chrome.storage.session.get(['exploreBlockState']);
  if (exploreBlockState) {
    if (exploreBlockState.autoEnabled) {
      for (const block of exploreBlocks) {
        if (block.type === 'auto' && exploreBlockState.autoEnabled[block.label] !== undefined) {
          block.enabled = exploreBlockState.autoEnabled[block.label];
        }
      }
    }
    if (exploreBlockState.manualBlocks) {
      for (const saved of exploreBlockState.manualBlocks) {
        exploreBlocks.push({
          id: ++exploreBlockIdCounter,
          type: 'manual',
          label: saved.label,
          enabled: saved.enabled,
          tree: saved.tree,
        });
      }
    }
  }

  renderExploreBlocks();
  _timer('renderExploreBlocks');
  runExploreBlockQuery();
  _timer('runExploreBlockQuery (fired)');
  document.body.dataset.ready = 'true';
}

// Incremental refresh after pin toggle — preserves scroll position and block selection state
async function refreshExplorePins() {
  const listId = EXPLORE_LIST_ID;
  const pins = getExplorePins();

  // Re-render pinned section
  const pinnedSection = document.querySelector('.list-section[data-section="pinned"]');
  if (pins.length === 0) {
    pinnedSection.style.display = 'none';
  } else {
    const { pageSnap, spi } = await loadPinContext(pins);
    const pinsResolved = pins.map(p => {
      const ref = resolvePageRef(p.id, pageSnap, spi);
      return { ...p, url: ref?.url || '', title: ref?.title || '', user_title: ref?.user_title || null };
    });
    function enrichResult(r) {
      const slug = r.slug || generateSlugFromUrl(r.url);
      const cached = pageSnap.get(slug);
      const source = (cached && cached.watermark > (r.watermark || 0)) ? cached : r;
      const attScore = source.attDetail ? attentionStrength(source.attDetail) : (source.attScore || attentionStrength(source));
      const attDetail = source.attDetail || source;
      const rSlug = slug;
      const pin = pins.find(p => slugFromPinId(p.id) === rSlug);
      const enriched = {
        ...r, slug, attScore, attDetail,
        notes: source.notes || r.notes || [],
        timestamps: [source.watermark || r.watermark || r.pinnedAt || Date.now()],
        pinnedAt: pin ? pin.pinnedAt : (r.pinnedAt || null),
      };
      if (source.user_title) enriched.user_title = source.user_title;
      return enriched;
    }
    const fullPinned = pinsResolved.map(enrichResult);
    renderPinnedSection(fullPinned, listId);
  }

  updateExploreBadge();

  // Rebuild auto-blocks from new pins, preserving enabled/disabled state of existing blocks
  const oldEnabledMap = new Map();
  for (const block of exploreBlocks) {
    oldEnabledMap.set(block.label, block.enabled);
  }
  // Keep manual blocks as-is
  const manualBlocks = exploreBlocks.filter(b => b.type === 'manual');
  const newAutoBlocks = pins.length > 0 ? await buildExploreAutoBlocks(pins) : [];
  // Restore enabled state from old auto-blocks
  for (const block of newAutoBlocks) {
    if (oldEnabledMap.has(block.label)) {
      block.enabled = oldEnabledMap.get(block.label);
    }
  }
  exploreBlocks = [...newAutoBlocks, ...manualBlocks];
  renderExploreBlocks();
  runExploreBlockQuery();
}

async function showList(list) {
  // loadLists() returns { slug, name } only — load full entity for qbTrees
  if (!list.qbTrees) {
    try {
      const entity = await readCacheable('list:' + list.slug);
      if (entity?.qbTrees) list.qbTrees = entity.qbTrees;
    } catch (err) { showErrorBubble(err.message); return; }
  }
  const displayName = listDisplayName(list);
  activeView = { type: 'list', id: list.slug, qbTrees: list.qbTrees || [], name: list.name || null };
  updateSidebarActive();
  updateMainTitle(displayName);
  document.getElementById('pinSearchBtn').style.display = 'none';

  // Enable double-click rename on title
  const titleEl = document.getElementById('mainTitle');
  function attachDblClick(currentName) {
    titleEl.ondblclick = () => {
      enterTitleEditMode(currentName, async (newName) => {
        list.name = newName;
        await chrome.runtime.sendMessage({ action: 'saveListMeta', listId: list.slug, name: newName });
        await renderLists();
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
  showListLayout();
  renderListSkeleton();

  try {
    const listId = list.slug;

    // Always fetch pins from entity storage
    const pinsResp = await sendAction({ action: 'loadListPinsById', listId });
    allListPins[listId] = pinsResp.pins;
    const pins = allListPins[listId];

    const { pageSnap, spi } = await loadPinContext(pins);
    const pinsResolved = pins.map(p => {
      const ref = resolvePageRef(p.id, pageSnap, spi);
      return { ...p, url: ref?.url || '', title: ref?.title || '', user_title: ref?.user_title || null };
    });

    // Enrich from cached pin fields + session page cache (no further I/O)
    function enrichResult(r) {
      const slug = r.slug || generateSlugFromUrl(r.url);
      const cached = pageSnap.get(slug);
      // Use session page if available and newer than pin's watermark, else use pin's cached fields
      const source = (cached && cached.watermark > (r.watermark || 0)) ? cached : r;
      let attSource = source.attDetail || source;
      // Fallback: use attention from loaded history when page lacks it
      if (attSource.scrollDepth === undefined && attSource.timeOnPage === undefined) {
        const histEntry = historyByUrl.get(r.url);
        if (histEntry) attSource = histEntry;
      }
      const attScore = attentionStrength(attSource) || (source.attScore || 0);
      const rSlug = slug;
      const pin = pins.find(p => slugFromPinId(p.id) === rSlug);
      const enriched = {
        ...r, slug, attScore, attDetail: attSource,
        notes: source.notes || r.notes || [],
        timestamps: [source.watermark || r.watermark || r.pinnedAt || Date.now()],
        pinnedAt: pin ? pin.pinnedAt : (r.pinnedAt || null),
      };
      if (source.user_title) enriched.user_title = source.user_title;
      return enriched;
    }

    // --- Pinned+Related section: cache in session or async fetch ---
    const listCacheKey = 'listCache:' + listId;
    const cachedPinned = (await chrome.storage.session.get(listCacheKey))[listCacheKey] || null;
    if (cachedPinned) {
      renderPinnedSection(cachedPinned.fullPinned, listId);
    } else {
      renderPinnedSection(pinsResolved.map(enrichResult), listId);
      fetchListResults(list, listId, pinsResolved, enrichResult);
    }

    // --- Explore section: always immediate ---
    renderListExplore(list);

    // Fire-and-forget: refresh pages in background and update pin file
    refreshListPages(listId, pins);
  } catch (error) {
    console.error('List load error:', error);
    document.getElementById('pinnedResults').innerHTML = `<div class="no-results">${escapeHtml('Error: ' + error.message)}</div>`;
  }
}

// Background refresh: load fresh pages and update pin file + cache
async function refreshListPages(listId, pins) {
  try {
    const slugs = pins.map(p => slugFromPinId(p.id));
    if (slugs.length === 0) return;
    // Read pages: session cache (dirty/recent) → filesystem (cold)
    const pages = {};
    const uncachedSlugs = [];
    const pageKeys = slugs.map(s => 'page:' + s);
    const sessionPages = pageKeys.length > 0 ? await chrome.storage.session.get(pageKeys) : {};
    for (const slug of slugs) {
      const cached = sessionPages['page:' + slug];
      if (cached) pages[slug] = cached;
      else uncachedSlugs.push(slug);
    }
    if (uncachedSlugs.length > 0) {
      const pageResp = await sendAction({ action: 'loadPageBatch', slugs: uncachedSlugs });
      Object.assign(pages, pageResp.pages || {});
    }
    let changed = false;
    for (const pin of pins) {
      const slug = slugFromPinId(pin.id);
      const page = pages[slug];
      if (!page) continue;
      if ((page.watermark || 0) > (pin.watermark || 0)) {
        let attSource = page;
        // Fallback: use attention from loaded history when page lacks it
        if (attSource.scrollDepth === undefined && attSource.timeOnPage === undefined) {
          const pinUrl = pin.id.startsWith('shallow:') ? pin.id.slice(8) : (page.url || '');
          const histEntry = historyByUrl.get(pinUrl);
          if (histEntry) attSource = histEntry;
        }
        pin.attScore = attentionStrength(attSource);
        pin.attDetail = attSource;
        pin.notes = []; // Notes loaded separately when needed for search
        pin.watermark = page.watermark;
        changed = true;
      }
    }
    if (changed) {
      allListPins[listId] = pins;
    }
  } catch (error) {
    console.debug('refreshListPages failed:', error.message);
  }
}

// Async: fetch search results, compute pinned+related, cache, and render both sections
async function fetchListResults(list, listId, pins, enrichResult) {
  // Yield to browser so Phase 1 paints first
  await new Promise(resolve => setTimeout(resolve, 0));
  if (activeView.type !== 'list' || activeView.id !== listId) return;

  try {
    let searchResults = [];

    if (list.qbTrees && list.qbTrees.length > 0) {
      searchResults = await evaluateQueryStream(list.qbTrees[0]);
    }

    if (activeView.type !== 'list' || activeView.id !== listId) return;

    // Enrich pinned pages with search result data where available
    const pinnedSlugs = new Set(pins.map(p => p.slug || generateSlugFromUrl(p.url)));
    const searchResultSlugs = new Set(searchResults.map(r => generateSlugFromUrl(r.url)));
    const pinnedInResults = searchResults.filter(r => pinnedSlugs.has(generateSlugFromUrl(r.url))).map(enrichResult);
    const pinnedOnly = pins.filter(p => !searchResultSlugs.has(p.slug || generateSlugFromUrl(p.url))).map(enrichResult);
    const fullPinned = [...pinnedInResults, ...pinnedOnly];

    // Cache pinned in session
    if (!listCacheKeys.includes(listId)) listCacheKeys.push(listId);
    chrome.storage.session.set({ ['listCache:' + listId]: { fullPinned } });

    renderPinnedSection(fullPinned, listId);
  } catch (error) {
    console.error('List fetch error:', error);
  }
}

// Render pinned rows (no related pages, no time chart)
function renderPinnedSection(allPinned, listId) {
  const effectivePinnedSort = pinnedSortState.column ? pinnedSortState : { column: 'lastVisit', direction: 'desc' };
  const sortedPinned = applySortOrder(allPinned, effectivePinnedSort);
  const maxAtt = Math.max(...sortedPinned.map(r => r.attScore), 0.1);

  const pinnedSection = document.querySelector('.list-section[data-section="pinned"]');
  const pinnedContainer = document.getElementById('pinnedResults');

  if (sortedPinned.length === 0) {
    pinnedSection.style.display = 'none';
  } else {
    pinnedSection.style.display = '';
    let html = columnHeaderHtml('pinned', { hasPin: true });
    html += sortedPinned.map(r =>
      resultRowHtml(r.user_title || r.title, r.url, { pinned: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail, notes: r.notes, timestamps: r.timestamps, context: 'pinned', pinnedAt: r.pinnedAt })
    ).join('');
    pinnedContainer.innerHTML = html;
    bindColumnHeaderClicks(pinnedContainer);
    bindResultDelegation(pinnedContainer);
    bindPinClicks(pinnedContainer, listId);
  }
}

// renderPinnedWithRelated removed — pinned section only shows pinned rows

// recalculateRelatedResults removed — pinned section no longer has related pages

async function renderListExplore(list) {
  const listId = list.slug;
  const pins = allListPins[listId] || [];

  // Load history for block evaluation
  await initHistoryFiles();
  await loadHistoryBatch();

  // Build auto-blocks from list pins
  exploreBlocks = pins.length > 0 ? await buildExploreAutoBlocks(pins) : [];

  // Add saved qbTrees as manual blocks if present
  if (list.qbTrees && list.qbTrees.length > 0) {
    for (const tree of list.qbTrees) {
      exploreBlocks.push({
        id: ++exploreBlockIdCounter,
        type: 'manual',
        label: 'Saved query',
        enabled: true,
        tree: JSON.parse(JSON.stringify(tree)),
      });
    }
  }

  renderExploreBlocks();
  runExploreBlockQuery();
}

// Convert raw interactions to display entries with date-boundary dedup.
// Each URL appears at most once per calendar day, sorted newest-first.
function processInteractionsForDisplay(interactions, { globalDedup = false } = {}) {
  // Sort newest first
  const sorted = [...interactions].sort((a, b) => b.timestamp - a.timestamp);

  const results = [];
  const globalIndex = globalDedup ? new Map() : null; // url → index in results
  const seenByDay = globalDedup ? null : new Map(); // YYYYMMDD → Set<url>

  for (const item of sorted) {
    const d = new Date(item.timestamp);
    const day = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

    if (globalDedup) {
      if (globalIndex.has(item.url)) {
        results[globalIndex.get(item.url)].timestamps.push(item.timestamp);
        continue;
      }
      globalIndex.set(item.url, results.length);
    } else {
      if (!seenByDay.has(day)) seenByDay.set(day, new Set());
      const daySet = seenByDay.get(day);
      if (daySet.has(item.url)) continue;
      daySet.add(item.url);
    }
    results.push({
      url: item.url,
      title: item.title || historyByUrl.get(item.url)?.title || '',
      user_title: item.user_title || historyByUrl.get(item.url)?.user_title,
      slug: item.slug || generateSlugFromUrl(item.url),
      timestamp: item.timestamp,
      day,
      attScore: attentionStrength(item),
      attDetail: item,
      notes: [],
      timestamps: [item.timestamp],
      latestTs: item.timestamp,
    });
  }
  return results;
}

// Batch-fetch page entities for all unique slugs in entries, enrich with entity titles.
// Falls back to SPI for shallow pages (no checkpoint) still missing a title.
async function enrichFromEntityStorage(entries) {
  const titleless = entries.filter(e => !e.title);
  if (titleless.length === 0) return;
  const slugs = [...new Set(titleless.map(r => r.slug).filter(Boolean))];
  if (slugs.length === 0) return;
  const resp = await sendAction({ action: 'loadPageBatch', slugs });
  const pages = resp.pages || {};
  const needSpi = []; // entries still missing title after checkpoint lookup
  for (const entry of titleless) {
    const page = pages[entry.slug];
    if (page) {
      if (page.title) entry.title = page.title;
      if (page.user_title) entry.user_title = page.user_title;
    } else {
      needSpi.push(entry);
    }
  }
  // SPI fallback for shallow pages with no title
  if (needSpi.length > 0) {
    const spi = await readCacheable('list:system/shallow-page');
    for (const entry of needSpi) {
      const spiEntry = spi?.index?.[entry.url];
      if (spiEntry?.title) entry.title = spiEntry.title;
      if (spiEntry?.user_title) entry.user_title = spiEntry.user_title;
    }
  }
}

async function displayInteractionRows(interactions) {
  if (!interactions || interactions.length === 0) {
    displayMessage('No interactions found');
    return;
  }

  const entries = processInteractionsForDisplay(interactions);
  await enrichFromEntityStorage(entries);

  // When sort is null, default to lastVisit desc
  const effectiveSort = currentSortState.column ? currentSortState : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(entries, effectiveSort);
  const maxAtt = Math.max(...sorted.map(e => e.attScore), 0.1);

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = columnHeaderHtml('global', { hasPin: false });
  vs.setData(sorted, (e) =>
    resultRowHtml(e.user_title || e.title, e.url, { attScore: e.attScore, maxAtt, attDetail: e.attDetail, notes: e.notes, timestamps: e.timestamps, context: 'global' })
  );
}

const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>';
const DELETE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const FOCUS_SVG = '<svg viewBox="0 0 24 24"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>';


// Group interactions by URL, return Map<url, interaction[]>
function groupInteractionsByUrl(interactions) {
  const map = new Map();
  for (const i of interactions) {
    if (!map.has(i.url)) map.set(i.url, []);
    map.get(i.url).push(i);
  }
  return map;
}

function buildDetailHtml(url, attDetail, notes) {
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

  if (notes && notes.length > 0) {
    html += '<div class="detail-notes">';
    for (const n of notes.slice(0, 5)) {
      if (n.excerpt === null) continue; // skip global notes
      const raw = n.excerpt || '';
      const text = Array.isArray(raw) ? raw.join(' ') : (raw || '');
      if (text) html += `<div class="detail-note-item">${escapeHtml(text)}</div>`;
    }
    html += '</div>';
  }

  return html;
}

// Lazy-load extra detail data (notes, lists, snapshots) when detail is expanded
async function loadExtraDetail(url) {
  const slug = generateSlugFromUrl(url);

  // Load notes for this page
  const notesResp = await sendAction({ action: 'loadPageNotes', slug });
  const notes = notesResp.notes || [];

  const snapResp = await sendAction({ action: 'listSnapshots', slug });
  const snapshots = snapResp.snapshots || [];

  // Find belonged lists (reverse lookup)
  const lists = await loadLists();
  const belongedLists = [];
  for (const lst of lists) {
    const pins = allListPins[lst.slug] || [];
    const pageId = 'page:' + generateSlugFromUrl(url);
    const shallowId = 'shallow:' + url;
    if (pins.some(p => p.id === pageId || p.id === shallowId)) {
      belongedLists.push(listDisplayName(lst));
    }
  }

  return { notes, snapshots, belongedLists, slug };
}

function renderExtraDetailHtml(extra) {
  let html = '';

  if (extra.belongedLists.length > 0) {
    html += '<div class="detail-section"><span class="detail-section-label">Lists:</span> ';
    html += extra.belongedLists.map(t => `<span class="detail-list-tag">${escapeHtml(t)}</span>`).join(' ');
    html += '</div>';
  }

  if (extra.notes.length > 0) {
    html += `<div class="detail-section detail-notes-section" data-slug="${escapeHtml(extra.slug)}"><span class="detail-section-label">Notes:</span>`;
    for (const n of extra.notes.slice(0, 20)) {
      const rawQuote = Array.isArray(n.excerpt) ? n.excerpt.join(' ') : (n.excerpt || '');
      const noteText = n.note || '';
      const noteSlug = n.slug || '';
      const isGlobal = n.excerpt === null;
      const label = isGlobal ? 'Page note' : escapeHtml(rawQuote.substring(0, 100)) + (rawQuote.length > 100 ? '...' : '');
      const noteHtml = noteText ? ` <span class="detail-note-text">${escapeHtml(noteText)}</span>` : '';
      html += `<div class="detail-note-entry" data-note-slug="${escapeHtml(noteSlug)}">
        <span class="detail-note-content">${isGlobal ? '<em>Page note</em>' : `"${label}"`}${noteHtml}</span>
        <button class="detail-note-delete" title="Delete">&times;</button>
      </div>`;
    }
    html += '</div>';
  }

  if (extra.snapshots.length > 0) {
    html += '<div class="detail-section"><span class="detail-section-label">Snapshots:</span>';
    html += `<div class="detail-snapshots" data-slug="${escapeHtml(extra.slug)}">`;
    for (const s of extra.snapshots) {
      const date = new Date(s.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      if (s.hasHtml) html += `<span class="detail-snapshot-item html" data-ts="${s.timestamp}">${escapeHtml(date)} (html)</span>`;
      if (s.hasMd) html += `<span class="detail-snapshot-item md" data-ts="${s.timestamp}">${escapeHtml(date)} (md)</span>`;
    }
    html += '</div></div>';
  }

  return html;
}

function bindNoteDeleteButtons(container) {
  container.querySelectorAll('.detail-note-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const entry = btn.closest('.detail-note-entry');
      const section = btn.closest('.detail-notes-section');
      const noteSlug = entry?.dataset.noteSlug;

      if (!noteSlug) return;

      try {
        await chrome.runtime.sendMessage({
          action: 'deleteNote',
          noteSlug
        });
      } catch (err) {
        console.error('Delete note error:', err);
        return;
      }

      entry.remove();
      // If no more notes, remove the section
      if (section && section.querySelectorAll('.detail-note-entry').length === 0) {
        section.remove();
      }
    });
  });
}

function bindSnapshotClickHandlers(container) {
  container.querySelectorAll('.detail-snapshot-item').forEach(item => {
    item.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const slug = item.closest('.detail-snapshots')?.dataset.slug;
      const ts = parseInt(item.dataset.ts, 10);
      if (!slug || !ts) return;
      const resp = await chrome.runtime.sendMessage({ action: 'getSnapshotUrl', slug, timestamp: ts });
      if (resp?.success) chrome.tabs.create({ url: resp.url });
    });
  });
}

// opts: { pinned, deletable, attScore, maxAtt, attDetail, notes, timestamps, context, pinnedAt, relevance, noFocusButton }
function resultRowHtml(title, url, opts = {}) {
  const safeTitle = escapeHtml(title || 'Untitled');
  const safeUrl = escapeHtml(url || '');
  const { pinned, deletable = false, attScore = 0, maxAtt = 1, attDetail = null, notes = [], timestamps = [], context = 'global', pinnedAt, relevance, cssClass, noFocusButton = false } = opts;
  const extraCols = getExtraColumns(context);

  const lastVisit = timestamps.length > 0 ? formatTime(Math.max(...timestamps)) : '';
  const normalized = maxAtt > 0 ? attScore / maxAtt : 0;
  const dotColor = attentionColor(normalized);

  const isPinned = pinned !== undefined ? pinned : isResultPinned(getActivePinListId(), url);
  const pinBtn = `<button class="result-pin${isPinned ? ' pinned' : ''}" data-pin-url="${safeUrl}" data-pin-title="${safeTitle}" title="${isPinned ? 'Unpin' : 'Pin'}">${PIN_SVG}</button>`;

  const detailHtml = buildDetailHtml(url, attDetail, notes);

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
      ${noFocusButton ? '' : `<button class="result-focus" data-focus-url="${safeUrl}" data-focus-title="${safeTitle}" title="Focus">${FOCUS_SVG}</button>`}
    </div>
    <div class="result-detail">${detailHtml}</div>
  </div>`;
}

function bindResultDelegation(container) {
  if (container._resultDelegationBound) return;
  container._resultDelegationBound = true;

  container.addEventListener('click', async (e) => {
    const expandBtn = e.target.closest('.result-expand');
    if (expandBtn) {
      e.stopPropagation();
      const row = expandBtn.closest('.result-row');
      const item = row?.closest('.result-item');
      const detail = item?.querySelector('.result-detail');
      if (detail) {
        const wasOpen = detail.classList.contains('open');
        detail.classList.toggle('open');
        expandBtn.classList.toggle('open');
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
            bindNoteDeleteButtons(extraDiv);
            bindSnapshotClickHandlers(extraDiv);
          }
        }
        // Notify virtual scroller of height change
        if (container._virtualScroller) container._virtualScroller.onExpandToggle();
      }
      return;
    }

    const pinBtn = e.target.closest('.result-pin');
    if (pinBtn) {
      e.stopPropagation();
      return; // pin clicks handled by bindPinClicks
    }

    const focusBtn = e.target.closest('.result-focus');
    if (focusBtn) {
      e.stopPropagation();
      openFocusPanel(focusBtn.dataset.focusUrl, focusBtn.dataset.focusTitle);
      return;
    }

    const row = e.target.closest('.result-row');
    if (!row) return;
    if (marqueeActive) return;

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
      const wasSelected = row.classList.contains('selected');
      allRows.forEach(r => r.classList.remove('selected'));
      if (!wasSelected) {
        row.classList.add('selected');
      }
      lastClickedRow = row;
    }
    syncChartHighlights();
  });

  container.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.result-row');
    if (!row) return;
    if (e.target.closest('.result-pin') || e.target.closest('.result-expand') || e.target.closest('.result-focus')) return;
    const url = row.dataset.url;
    // Proactive checkpoint: ensure a page entity exists before navigation
    sendAction({ action: 'ensurePageCheckpoint', url, title: row.dataset.title }).catch(e => console.warn('[checkpoint]', e.message));
    chrome.tabs.create({ url });
  });

  container.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.result-row');
    if (!row) return;
    let items;
    const selectedRows = container.querySelectorAll('.result-row.selected');
    if (row.classList.contains('selected') && selectedRows.length > 1) {
      items = Array.from(selectedRows).map(r => ({ url: r.dataset.url, title: r.dataset.title }));
      // Show count badge as drag image
      const badge = document.createElement('div');
      badge.textContent = `${items.length} pages`;
      badge.style.cssText = 'position:absolute;top:-9999px;padding:4px 10px;background:#4a90d9;color:#fff;border-radius:4px;font-size:13px;white-space:nowrap;';
      document.body.appendChild(badge);
      e.dataTransfer.setDragImage(badge, 0, 0);
      requestAnimationFrame(() => badge.remove());
    } else {
      items = [{ url: row.dataset.url, title: row.dataset.title }];
    }
    e.dataTransfer.setData('text/plain', JSON.stringify({ items }));
    e.dataTransfer.effectAllowed = 'copy';
  });
}

function bindPinClicks(container, listId) {
  // Use delegation — store listId on container for the handler
  container._pinListId = listId;
  if (container._pinDelegationBound) return;
  container._pinDelegationBound = true;

  container.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('.result-pin');
    if (!pinBtn) return;
    e.stopPropagation();
    const url = pinBtn.dataset.pinUrl;
    const title = pinBtn.dataset.pinTitle;
    const cid = container._pinListId;
    await toggleResultPin(cid, url, title);
    if (cid === EXPLORE_LIST_ID && activeView.type === 'explore') {
      refreshExplorePins();
    } else if (cid === EXPLORE_LIST_ID) {
      showExplore();
    } else {
      const lst = { id: cid, qbTrees: activeView.qbTrees, name: activeView.name };
      showList(lst);
    }
  });
}

// Virtual scroller instances for main results and list explore results
let globalVirtualScroller = null;
let relatedVirtualScroller = null;

function getOrCreateGlobalScroller() {
  const containerEl = document.getElementById('results');
  if (!globalVirtualScroller) {
    const scrollEl = document.querySelector('.main');
    globalVirtualScroller = new VirtualScroller(scrollEl, containerEl);
    bindResultDelegation(containerEl);
    bindColumnHeaderClicks(containerEl);
  }
  // Always refresh pin target for the active view
  bindPinClicks(containerEl, getActivePinListId());
  return globalVirtualScroller;
}

function getOrCreateRelatedScroller() {
  if (!relatedVirtualScroller) {
    const scrollEl = document.querySelector('.main');
    const containerEl = document.getElementById('relatedResults');
    relatedVirtualScroller = new VirtualScroller(scrollEl, containerEl);
    bindResultDelegation(containerEl);
    bindColumnHeaderClicks(containerEl);
  }
  return relatedVirtualScroller;
}

function displayMessage(msg) {
  document.getElementById('timeChart').classList.remove('visible');
  // Reset virtual scroller state so it doesn't re-render over the message
  if (globalVirtualScroller) {
    globalVirtualScroller.data = [];
    globalVirtualScroller.renderedRange = { start: -1, end: -1 };
  }
  const container = document.getElementById('results');
  container.style.paddingTop = '0px';
  container.style.paddingBottom = '0px';
  container.innerHTML = `<div class="no-results">${escapeHtml(msg)}</div>`;
}

function listDisplayName(list) {
  return list.name;
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
  } else if (activeView.type === 'list') {
    const el = document.querySelector(`.sidebar-item[data-list-id="${activeView.id}"]`);
    if (el) el.classList.add('active');
  } else if (activeView.type === 'explore') {
    document.getElementById('exploreBtn').classList.add('active');
  }
}

// --- Lists (pinned searches) ---
async function loadLists() {
  const settings = await readCacheable('settings');
  const listOrder = settings?.listOrder || [];
  return listOrder.map(e => ({ slug: e.id.startsWith('list:') ? e.id.slice(5) : e.id, name: e.name }));
}

// saveLists removed — use saveListMeta/deleteList messages instead

async function renderLists() {
  const allLists = await loadLists();
  const listEl = document.getElementById('listsList');
  const empty = document.getElementById('listsEmpty');

  // Remove existing list items (keep the empty placeholder)
  listEl.querySelectorAll('.sidebar-item').forEach(el => el.remove());

  if (allLists.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  for (const lst of allLists) {
    const item = document.createElement('div');
    item.className = 'sidebar-item';
    item.dataset.listId = lst.slug;
    item.innerHTML = `
      <span class="icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg></span>
      <span class="label">${escapeHtml(listDisplayName(lst))}</span>
      <button class="remove-list" title="Remove list">&times;</button>
    `;

    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-list-reorder', lst.slug);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      listEl.querySelectorAll('.reorder-above, .reorder-below').forEach(el => {
        el.classList.remove('reorder-above', 'reorder-below');
      });
    });

    item.addEventListener('click', (e) => {
      if (e.target.closest('.remove-list')) return;
      showList(lst);
    });

    item.querySelector('.remove-list').addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ action: 'deleteList', listId: lst.slug });
      // Clean up local state
      delete allListPins[lst.slug];
      chrome.storage.session.remove('listCache:' + lst.slug);
      listCacheKeys = listCacheKeys.filter(id => id !== lst.slug);
      renderLists();
      if (activeView.type === 'list' && activeView.id === lst.slug) {
        showExplore();
      }
    });

    // Drag-and-drop: list as drop target (counter prevents child-triggered dragleave)
    let dragCounter = 0;
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer.types.includes('application/x-list-reorder')) {
        e.dataTransfer.dropEffect = 'move';
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          item.classList.add('reorder-above');
          item.classList.remove('reorder-below');
        } else {
          item.classList.add('reorder-below');
          item.classList.remove('reorder-above');
        }
      } else {
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    item.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (!e.dataTransfer.types.includes('application/x-list-reorder')) {
        dragCounter++;
        item.classList.add('drag-over');
      }
    });
    item.addEventListener('dragleave', (e) => {
      if (e.dataTransfer.types.includes('application/x-list-reorder')) {
        item.classList.remove('reorder-above', 'reorder-below');
      } else {
        dragCounter--;
        if (dragCounter <= 0) {
          dragCounter = 0;
          item.classList.remove('drag-over');
        }
      }
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drag-over', 'reorder-above', 'reorder-below');

      if (e.dataTransfer.types.includes('application/x-list-reorder')) {
        // --- Reorder ---
        const draggedId = e.dataTransfer.getData('application/x-list-reorder');
        if (draggedId === lst.slug) return;
        const allItems = await loadLists();
        const fromIdx = allItems.findIndex(c => c.slug === draggedId);
        if (fromIdx === -1) return;
        const [moved] = allItems.splice(fromIdx, 1);
        let toIdx = allItems.findIndex(c => c.slug === lst.slug);
        const rect = item.getBoundingClientRect();
        if (e.clientY >= rect.top + rect.height / 2) toIdx++;
        allItems.splice(toIdx, 0, moved);
        await saveSettingsValue('listOrder', allItems.map(c => ({ id: 'list:' + c.slug, name: c.name })));
        await renderLists();
      } else {
        // --- Pin drop (existing logic) ---
        dragCounter = 0;
        try {
          const data = JSON.parse(e.dataTransfer.getData('text/plain'));
          const items = data.items || [{ url: data.url, title: data.title }];
          if (!allListPins[lst.slug]) allListPins[lst.slug] = [];
          const pins = allListPins[lst.slug];
          const newUrls = [];
          for (const { url } of items) {
            const pinId = 'page:' + generateSlugFromUrl(url);
            if (url && !pins.some(p => p.id === pinId || p.id === 'shallow:' + url)) {
              pins.push({ id: pinId, pinnedAt: Date.now() });
              newUrls.push(url);
            }
          }
          if (newUrls.length > 0) {
            await chrome.runtime.sendMessage({ action: 'addListPins', listId: lst.slug, urls: newUrls });
            if (activeView.type === 'list' && activeView.id === lst.slug) {
              showList(lst);
            }
          }
        } catch (err) {
          console.error('Drop error:', err);
        }
      }
    });

    listEl.appendChild(item);
  }

  updateSidebarActive();
}

async function saveExploreAsList() {
  if (activeView.type !== 'explore') return;
  const pins = getExplorePins();

  // Collect manual block trees as qbTrees for the new list
  const qbTrees = exploreBlocks
    .filter(b => b.type === 'manual' && b.tree && treeHasConfiguredPredicate(b.tree))
    .map(b => JSON.parse(JSON.stringify(b.tree)));

  enterTitleEditMode('', async (name) => {
    if (!name) return;
    try {
      const listId = generateSlugFromTitle(name);
      const newList = { slug: listId, name, qbTrees };
      await chrome.runtime.sendMessage({ action: 'saveListMeta', listId, name, qbTrees });
      const order = (await readCacheable('settings')).listOrder || [];
      await saveSettingsValue('listOrder', [...order, { id: 'list:' + listId, name }]);
      // Copy explore pins to the new list (if any)
      if (pins.length > 0) {
        await chrome.runtime.sendMessage({
          action: 'copyListPins', fromListId: EXPLORE_LIST_ID, toListId: listId,
        });
      }
      await renderLists();
      showList(newList);
    } catch (err) { showErrorBubble(err.message); }
  }, () => {
    updateMainTitle('Explore');
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
document.getElementById('pinSearchBtn').addEventListener('click', saveExploreAsList);

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
// Init marquee for list sections
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
  const interactions = Array.from(historyByUrl.values());
  document.getElementById('totalInteractions').textContent = interactions.length;

  const today = new Date().setHours(0, 0, 0, 0);
  const todayCount = interactions.filter(i => i.timestamp >= today).length;
  document.getElementById('todayInteractions').textContent = todayCount;

  const result = await chrome.storage.local.get(['logBuffer']);
  document.getElementById('bufferSize').textContent = (result.logBuffer || []).length;

  updateCacheTable();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Session-cached keys live in chrome.storage.session; logBuffer lives in chrome.storage.local
const SESSION_CACHE_KEYS = [
  { key: 'settings', label: 'Settings' },
  { key: 'lists', label: 'Lists' },
  { key: 'list:system/gateways', label: 'Gateway Origins' },
  { key: 'list:system/shallow-page', label: 'Shallow Page Index' },
];
const LOCAL_CACHE_KEYS = [
  { key: 'logBuffer', label: 'Log Buffer' },
];
const CACHE_KEYS = [...SESSION_CACHE_KEYS, ...LOCAL_CACHE_KEYS];

async function updateCacheTable() {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(SESSION_CACHE_KEYS.map(c => c.key)),
    chrome.storage.local.get(LOCAL_CACHE_KEYS.map(c => c.key)),
  ]);
  const data = { ...sessionData, ...localData };
  const tbody = document.getElementById('cacheTableBody');

  let totalBytes = 0;
  let rows = '';

  for (const { key, label } of CACHE_KEYS) {
    const val = data[key];
    const size = val !== undefined ? new Blob([JSON.stringify(val)]).size : 0;
    totalBytes += size;
    rows += `<tr><td>${label}</td><td class="cache-size">${formatBytes(size)}</td></tr>`;
  }

  rows += `<tr class="cache-total"><td>Total</td><td class="cache-size">${formatBytes(totalBytes)}</td></tr>`;
  tbody.innerHTML = rows;
}

document.getElementById('flushBufferBtn').addEventListener('click', async () => {
  const btn = document.getElementById('flushBufferBtn');
  btn.disabled = true;
  btn.textContent = 'Flushing...';

  try {
    const resp = await chrome.runtime.sendMessage({ action: 'flushLogBuffer' });
    if (resp?.success) {
      btn.textContent = resp.remaining > 0 ? `${resp.remaining} remaining` : 'Flushed!';
      await updateStatistics();
    } else {
      btn.textContent = 'Failed: ' + (resp?.error || 'unknown');
    }
  } catch (e) {
    btn.textContent = 'Error: ' + e.message;
  }
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = 'Flush to Disk';
  }, 2000);
});

document.getElementById('clearCacheBtn').addEventListener('click', async () => {
  const btn = document.getElementById('clearCacheBtn');
  btn.disabled = true;
  btn.textContent = 'Reloading...';

  try {
    // Clear session cache keys (logBuffer stays in local — it's a transient buffer for pending log entries)
    const sessionKeysToRemove = SESSION_CACHE_KEYS.map(c => c.key);
    await chrome.storage.session.remove(sessionKeysToRemove);

    // Ask background to re-hydrate from settings.json
    await chrome.runtime.sendMessage({ action: 'hydrateCache' });

    showStatus('Cache cleared and reloaded from storage', 'success');
  } catch (error) {
    showStatus('Cache clear failed: ' + error.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Clear Cache & Reload';
  updateCacheTable();
});

// Select directory
document.getElementById('selectDirBtn').addEventListener('click', async () => {
  try {
    const result = await fsStorage.selectDirectory();
    if (result.success) {
      await updateStorageStatus();
      showStatus(`Storage location set: ${result.name}`, 'success');
      chrome.runtime.sendMessage({ action: 'initializeFilesystem' });
      // Reload data for main view
      resetHistory();
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
  if (!confirm('Change storage directory?\n\nData will NOT be migrated automatically. To keep existing data, disable the extension and copy the portal-data folder to the new location before proceeding.')) {
    return;
  }

  const changeDirBtn = document.getElementById('changeDirBtn');
  changeDirBtn.disabled = true;
  changeDirBtn.textContent = 'Changing...';

  try {
    const result = await fsStorage.selectDirectory();

    if (!result.success) {
      if (result.error !== 'User cancelled') {
        showStatus(`Error: ${result.error}`, 'error');
      }
      changeDirBtn.disabled = false;
      changeDirBtn.textContent = 'Change Directory';
      return;
    }

    showStatus(`Storage location changed to: ${result.name}`, 'success');
    await updateStorageStatus();
    await updateStatistics();
    chrome.runtime.sendMessage({ action: 'initializeFilesystem' });
    resetHistory();
  } catch (error) {
    showStatus(`Error changing directory: ${error.message}`, 'error');
  }

  changeDirBtn.disabled = false;
  changeDirBtn.textContent = 'Change Directory';
});

document.getElementById('relatedPagesLimit').addEventListener('change', async () => {
  const val = parseInt(document.getElementById('relatedPagesLimit').value) || 50;
  relatedPagesLimit = Math.max(1, val);
  document.getElementById('relatedPagesLimit').value = relatedPagesLimit;
  await saveSettingsValue('relatedPagesLimit', relatedPagesLimit);
  showStatus('Settings saved', 'success');
});

document.getElementById('historyFileBatch').addEventListener('change', async () => {
  const val = parseInt(document.getElementById('historyFileBatch').value) || 10;
  historyFileBatch = Math.max(1, val);
  document.getElementById('historyFileBatch').value = historyFileBatch;
  await saveSettingsValue('historyFileBatch', historyFileBatch);
  showStatus('Settings saved', 'success');
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
        await fsStorage.softDelete(fsStorage.directoryHandle, entry.name);
        deletedCount++;
      }
    }

    try {
      await fsStorage.softDelete(fsStorage.directoryHandle, 'pages', { recursive: true });
      deletedCount++;
    } catch (error) {}

    await chrome.runtime.sendMessage({ action: 'clearWriteQueue' });
    showStatus(`Cleared ${deletedCount} files/directories`, 'success');
    await updateStatistics();
    resetHistory();
    showExplore();
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
  const list = await loadSettingsValue('urlBlacklist', null);
  if (list === null) {
    await saveBlacklist(DEFAULT_BLACKLIST);
    return [...DEFAULT_BLACKLIST];
  }
  return list;
}

async function saveBlacklist(list) {
  await saveSettingsValue('urlBlacklist', list);
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
  return await loadSettingsValue('titleTrimRules', []);
}

async function saveTrimRules(rules) {
  await saveSettingsValue('titleTrimRules', rules);
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

// --- Mutation notifications from background ---
let mutationRefreshTimer = null;

chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== 'mutation') return;

  const { type } = request;

  if (type === 'interaction') {
    // New page visit — merge into historyByUrl and historyAllEntries
    clearTimeout(mutationRefreshTimer);
    mutationRefreshTimer = setTimeout(async () => {
      const todayEntries = await readCacheable('history:' + new Date().toISOString().slice(0, 10)) || [];
      const interactionBuffer = todayEntries.filter(e => (e.action === 'page' || !e.action) && e.url);
      let changed = false;
      for (const entry of interactionBuffer) {
        const existing = historyByUrl.get(entry.url);
        if (!existing || entry.timestamp > existing.timestamp) {
          historyByUrl.set(entry.url, entry);
          if (existing && existing.title && !entry.title) entry.title = existing.title;
          if (existing && existing.user_title && !entry.user_title) entry.user_title = existing.user_title;
          changed = true;
        } else if (entry.title && !existing.title) {
          existing.title = entry.title;
        }
        if (entry.user_title && (!existing || !existing.user_title)) {
          if (existing) existing.user_title = entry.user_title;
        }
        // Always push to allEntries for date-boundary rendering
        historyAllEntries.push(entry);
      }
      if (changed) {
        if (activeView.type === 'explore' || activeView.type === 'list') {
          runExploreBlockQuery();
        } else {
          refreshCurrentView();
        }
      }
    }, 500);
  } else if (type === 'pins') {
    // List pins changed — invalidate caches and re-render active list.
    const activeListId = activeView.type === 'explore' ? EXPLORE_LIST_ID
      : (activeView.type === 'list' ? activeView.id : null);
    if (request.listId) {
      delete allListPins[request.listId];
      chrome.storage.session.remove('listCache:' + request.listId);
      listCacheKeys = listCacheKeys.filter(id => id !== request.listId);
      if (request.listId === activeListId) refreshCurrentView();
    } else {
      allListPins = {};
      if (listCacheKeys.length > 0) {
        chrome.storage.session.remove(listCacheKeys.map(id => 'listCache:' + id));
        listCacheKeys = [];
      }
      if (activeListId) refreshCurrentView();
    }
  } else if (type === 'lists') {
    renderLists();
  } else if (type === 'settings') {
    if (request.key === 'listOrder') {
      renderLists();
    }
  } else if (type === 'note') {
    // Note created/deleted — invalidate cached notes and refresh view
    cachedAllNotes = null;
    refreshCurrentView();
  }
  // highlight, snapshot: session cache is already updated by background
});

// --- Visibility change: invalidate stale caches when tab regains focus ---
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;

  // Invalidate pin and list caches (may have been modified in popup)
  allListPins = {};
  if (listCacheKeys.length > 0) {
    chrome.storage.session.remove(listCacheKeys.map(id => 'listCache:' + id));
    listCacheKeys = [];
  }

  // Refresh sidebar lists (may have been created/deleted in popup)
  renderLists();

  // Re-list history files and load any new ones
  let historyChanged = false;
  try {
    const filesResp = await sendAction({ action: 'listInteractionFiles' });
    const allFiles = filesResp.files;
    const newFiles = allFiles.filter(f => !historyFiles.includes(f));
    if (newFiles.length > 0) {
      historyFiles = allFiles;
      const batchResp = await sendAction({ action: 'loadInteractionBatch', files: newFiles });
      const newInteractions = batchResp.interactions;
      for (const item of newInteractions) {
        if (!historyByUrl.has(item.url) || item.timestamp > historyByUrl.get(item.url).timestamp) {
          historyByUrl.set(item.url, item);
          historyChanged = true;
        }
      }
    }
  } catch (error) {
    console.debug('visibilitychange refresh failed:', error.message);
  }

  // Don't refreshCurrentView() here — mutation notifications from background already
  // handle re-rendering for pin/list/interaction changes. A full re-render would
  // destroy scroll position, block enable/disable state, and expanded details.
});

// --- Explore Pins ---

function getExplorePins() {
  return allListPins[EXPLORE_LIST_ID] || [];
}

function updateExploreBadge() {
  const badge = document.getElementById('exploreBadge');
  if (!badge) return;
  const pins = getExplorePins();
  if (pins.length > 0) {
    badge.textContent = pins.length;
    badge.classList.add('visible');
  } else {
    badge.textContent = '';
    badge.classList.remove('visible');
  }
}

// --- Explore Blocks ---

async function buildExploreAutoBlocks(pins) {
  const pinnedSlugs = new Set(pins.map(p => slugFromPinId(p.id)));

  // Load pages for all pins via background (checks cache + disk)
  const pinSlugs = pins.map(p => slugFromPinId(p.id));
  const pageData = {};
  if (pinSlugs.length > 0) {
    const resp = await chrome.runtime.sendMessage({ action: 'loadPageBatch', slugs: pinSlugs });
    if (resp?.success && resp.pages) {
      for (const [slug, page] of Object.entries(resp.pages)) {
        pageData['page:' + slug] = page;
      }
    }
  }

  // Helper: resolve typed refs (page:<slug> | shallow:<url>) → URLs
  async function resolveTypedRefs(refs) {
    const urls = [];
    const slugs = [];
    for (const ref of refs) {
      if (ref.startsWith('shallow:')) { urls.push(ref.slice(8)); continue; }
      if (ref.startsWith('page:')) { slugs.push(ref.slice(5)); continue; }
    }
    if (slugs.length > 0) {
      const resp = await chrome.runtime.sendMessage({ action: 'loadPageBatch', slugs });
      if (resp?.success && resp.pages) {
        for (const s of slugs) {
          const p = resp.pages[s];
          if (p && p.url) urls.push(p.url);
        }
      }
    }
    return urls;
  }

  // Children of pins: from page.childIds (typed keys, filter out notes) + shallowPageIndex inverse
  const allChildRefs = [];
  for (const slug of pinSlugs) {
    const page = pageData['page:' + slug];
    if (page && page.childIds) {
      for (const c of page.childIds) {
        if (!c.startsWith('note:')) allChildRefs.push(c); // Skip note children
      }
    }
  }
  const resolvedChildUrls = await resolveTypedRefs(allChildRefs);
  const childrenUrls = new Set(resolvedChildUrls.filter(u => !pinnedSlugs.has(generateSlugFromUrl(u))));
  // Also check shallowPageIndex for non-checkpointed children
  const spiData = await readCacheable('list:system/shallow-page');
  const pinSlugSet = new Set(pinSlugs);
  for (const [childUrl, entry] of Object.entries(spiData.index)) {
    if (pinnedSlugs.has(generateSlugFromUrl(childUrl))) continue;
    const parentIds = entry.parentIds || [];
    if (parentIds.some(p => pinSlugSet.has(p.startsWith('page:') ? p.slice(5) : p))) childrenUrls.add(childUrl);
  }

  // Parents of pins: from page.parentIds (typed keys) + shallowPageIndex fallback
  const allParentRefs = [];
  for (let i = 0; i < pinSlugs.length; i++) {
    const page = pageData['page:' + pinSlugs[i]];
    if (page && page.parentIds && page.parentIds.length > 0) {
      for (const p of page.parentIds) allParentRefs.push(p);
    } else {
      // Non-checkpointed pin: check shallowPageIndex for its parentIds
      const pinUrl = pins[i].id.startsWith('shallow:') ? pins[i].id.slice(8) : (pageData['page:' + pinSlugs[i]]?.url || '');
      const spiEntry = spiData.index[pinUrl];
      if (spiEntry && spiEntry.parentIds) {
        for (const ps of spiEntry.parentIds) allParentRefs.push(ps);
      }
    }
  }
  const resolvedParentUrls = await resolveTypedRefs(allParentRefs);
  const parentUrls = new Set(resolvedParentUrls.filter(u => !pinnedSlugs.has(generateSlugFromUrl(u))));

  // Similar to pins: use findRelatedPages
  const allEnriched = Array.from(historyByUrl.values()).map(r => ({
    ...r, timestamps: [r.timestamp || Date.now()], attScore: 0, attDetail: null, notes: [],
  }));
  const seedEnriched = allEnriched.filter(e => pinnedSlugs.has(generateSlugFromUrl(e.url)));
  const candidateEnriched = allEnriched.filter(e => !pinnedSlugs.has(generateSlugFromUrl(e.url)));
  const similarResults = findRelatedPages(seedEnriched, candidateEnriched, relatedPagesLimit);
  const similarUrls = new Set(similarResults.map(r => r.url));

  return [
    {
      id: ++exploreBlockIdCounter,
      type: 'auto',
      label: 'Children of pins',
      enabled: false,
      urls: childrenUrls,
    },
    {
      id: ++exploreBlockIdCounter,
      type: 'auto',
      label: 'Parents of pins',
      enabled: false,
      urls: parentUrls,
    },
    {
      id: ++exploreBlockIdCounter,
      type: 'auto',
      label: 'Similar to pins',
      enabled: false,
      urls: similarUrls,
    },
  ];
}

function saveExploreBlockState() {
  if (activeView.type !== 'explore') return;
  const autoEnabled = {};
  const manualBlocks = [];
  for (const block of exploreBlocks) {
    if (block.type === 'auto') {
      autoEnabled[block.label] = block.enabled;
    } else if (block.type === 'manual') {
      manualBlocks.push({ label: block.label, enabled: block.enabled, tree: block.tree });
    }
  }
  chrome.storage.session.set({ exploreBlockState: { autoEnabled, manualBlocks } });
}

function renderExploreBlocks() {
  const container = document.getElementById('listQueryBuilder');
  container.style.display = 'block';

  let html = '<div class="explore-blocks">';

  const eyeOpenSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeClosedSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const removeSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  for (const block of exploreBlocks) {
    const enabledClass = block.enabled ? 'enabled' : 'disabled';
    const blockClass = block.enabled ? '' : ' disabled';
    const countLabel = '';

    html += `<div class="explore-block${blockClass}" data-block-id="${block.id}">`;

    // Left: full-height toggle
    html += `<button class="explore-block-toggle ${enabledClass}" data-block-id="${block.id}" title="${block.enabled ? 'Disable' : 'Enable'}">${block.enabled ? eyeOpenSvg : eyeClosedSvg}</button>`;

    // Middle: content
    html += `<div class="explore-block-content">`;
    html += `<span class="explore-block-label">${escapeHtml(block.label)} <span class="explore-block-count">${countLabel}</span></span>`;

    if (block.type === 'manual' && block.tree) {
      html += `<div class="explore-block-body">`;
      html += `<div class="qb-body qb-mode-pro" data-block-id="${block.id}">`;
      html += renderTreeNodePro(block.tree);
      html += `</div></div>`;
    }
    html += `</div>`;

    // Right: full-height remove (manual blocks only; auto blocks are derived from pins)
    if (block.type === 'manual') {
      html += `<button class="explore-block-remove" data-block-id="${block.id}" title="Remove">${removeSvg}</button>`;
    }

    html += `</div>`;
  }

  html += `<button class="explore-add-block">+ Add query block</button>`;
  html += '</div>';

  // Replace qb-header and qb-body with block layout
  container.innerHTML = html;

  // Bind events
  bindExploreBlockEvents(container);
}

function bindExploreBlockEvents(container) {
  // Toggle buttons
  container.querySelectorAll('.explore-block-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockId = parseInt(btn.dataset.blockId);
      const block = exploreBlocks.find(b => b.id === blockId);
      if (!block) return;
      block.enabled = !block.enabled;
      renderExploreBlocks();
      saveExploreBlockState();
      runExploreBlockQuery();
    });
  });

  // Remove buttons
  container.querySelectorAll('.explore-block-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockId = parseInt(btn.dataset.blockId);
      exploreBlocks = exploreBlocks.filter(b => b.id !== blockId);
      renderExploreBlocks();
      saveExploreBlockState();
      runExploreBlockQuery();
    });
  });

  // Add block button
  const addBtn = container.querySelector('.explore-add-block');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const newBlock = {
        id: ++exploreBlockIdCounter,
        type: 'manual',
        label: 'Custom query',
        enabled: true,
        tree: qbCreatePlaceholder(KEYWORD_FIELDS),
      };
      exploreBlocks.push(newBlock);
      renderExploreBlocks();
      saveExploreBlockState();
    });
  }

  // Bind QB events on each manual block's body
  // For block-scoped QB, we swap qbRoot to the block's tree during event binding.
  // The events that call qbUpdateNode/debouncedRunQuery will work because those
  // search the tree for node IDs. The debouncedRunQuery checks the context.
  // However, tree-structure mutations (insert/remove/add child) also call
  // renderQueryBuilder() which we need to redirect to renderExploreBlocks().
  container.querySelectorAll('.qb-body[data-block-id]').forEach(body => {
    const blockId = parseInt(body.dataset.blockId);
    const block = exploreBlocks.find(b => b.id === blockId);
    if (!block || block.type !== 'manual') return;

    // Swap qbRoot to block's tree for binding.
    // QB mutation functions (qbInsertOnEdge, etc.) reference qbRoot globally.
    // They call renderQueryBuilder() which checks the explore context and
    // copies qbRoot back to the active block's tree.
    const savedRoot = qbRoot;
    qbRoot = block.tree;
    activeBlockId = blockId;
    bindQueryBuilderEvents(body);
    qbRoot = savedRoot;
    activeBlockId = null;

    // Wrap the interactive elements to swap qbRoot before their handlers fire
    body.addEventListener('click', () => { qbRoot = block.tree; activeBlockId = blockId; }, true);
    body.addEventListener('mousedown', () => { qbRoot = block.tree; activeBlockId = blockId; }, true);
    body.addEventListener('input', () => { qbRoot = block.tree; activeBlockId = blockId; }, true);
    body.addEventListener('change', () => { qbRoot = block.tree; activeBlockId = blockId; }, true);
  });
}

let exploreBlockDebounceTimer = null;
function debouncedRunExploreBlockQuery() {
  if (exploreBlockDebounceTimer) clearTimeout(exploreBlockDebounceTimer);
  exploreBlockDebounceTimer = setTimeout(() => runExploreBlockQuery(), 300);
}

async function runExploreBlockQuery() {
  if (activeView.type !== 'explore' && activeView.type !== 'list') return;

  // Derive pinned slugs and listId from active view
  let pinnedSlugs, listId;
  if (activeView.type === 'explore') {
    listId = EXPLORE_LIST_ID;
    pinnedSlugs = new Set(getExplorePins().map(p => slugFromPinId(p.id)));
  } else {
    listId = activeView.id;
    pinnedSlugs = new Set((allListPins[listId] || []).map(p => slugFromPinId(p.id)));
    // Sync manual block trees to list's qbTrees (skips save if unchanged)
    saveListQbTrees();
  }

  const enabledBlocks = exploreBlocks.filter(b => b.enabled);
  let results;
  let showAllHistory = false;

  if (enabledBlocks.length === 0) {
    if (activeView.type === 'explore') {
      // Explore: show entire history when no blocks enabled (date-boundary dedup)
      showAllHistory = true;
      results = processInteractionsForDisplay(
        historyAllEntries.filter(item => item.url && !pinnedSlugs.has(generateSlugFromUrl(item.url)))
      ).map(item => ({ ...item, relevance: 0 }));
      await enrichFromEntityStorage(results);
    } else {
      // List: show empty state when no blocks enabled
      const relatedContainer = document.getElementById('relatedResults');
      relatedContainer.innerHTML = '<div class="no-results">Enable a block or add a query</div>';
      document.getElementById('relatedChart').classList.remove('visible');
      return;
    }
  } else {
    const mergedUrls = new Set();

    // Collect URLs from auto blocks
    for (const block of enabledBlocks) {
      if (block.type === 'auto' && block.urls) {
        for (const url of block.urls) {
          if (!pinnedSlugs.has(generateSlugFromUrl(url))) mergedUrls.add(url);
        }
      }
    }

    // Evaluate manual blocks
    let matchAll = false;
    for (const block of enabledBlocks) {
      if (block.type === 'manual') {
        if (!block.tree || !treeHasConfiguredPredicate(block.tree)) {
          // Uninitialized block = no filter = all history
          matchAll = true;
          showAllHistory = true;
          break;
        }
        const matched = await evaluateQueryStream(block.tree);
        for (const item of matched) {
          if (!pinnedSlugs.has(generateSlugFromUrl(item.url))) mergedUrls.add(item.url);
        }
      }
    }

    // Build result items — global dedup for filtered results, day-wise for all-history
    const filteredEntries = historyAllEntries.filter(item => {
      if (!item.url || pinnedSlugs.has(generateSlugFromUrl(item.url))) return false;
      return matchAll || mergedUrls.has(item.url);
    });
    results = processInteractionsForDisplay(filteredEntries, { globalDedup: !showAllHistory }).map(item => ({ ...item, relevance: 0 }));
    await enrichFromEntityStorage(results);
  }

  const relatedContainer = document.getElementById('relatedResults');
  if (results.length === 0) {
    relatedContainer.innerHTML = '<div class="no-results">No results</div>';
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  const effectiveSort = relatedSortState.column ? relatedSortState : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(results, effectiveSort);
  const maxAtt = Math.max(...sorted.map(r => r.attScore), 0.1);

  const vs = getOrCreateRelatedScroller();
  vs._headerHtml = columnHeaderHtml('related', { hasPin: true, showRelevance: false });
  vs.updateData(sorted, (r) =>
    resultRowHtml(r.user_title || r.title, r.url, {
      pinned: isResultPinned(listId, r.url),
      attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      notes: r.notes, timestamps: r.timestamps, context: 'related',
    })
  );
  bindPinClicks(relatedContainer, listId);

  // Demand-load more history when scrolling (for all-history mode)
  if (showAllHistory) {
    vs.onLoadMore = async () => {
      const newItems = await loadHistoryBatch();
      if (newItems.length > 0) {
        const filtered = newItems.filter(item => item.url && !pinnedSlugs.has(generateSlugFromUrl(item.url)));
        const newResults = processInteractionsForDisplay(filtered).map(item => ({ ...item, relevance: 0 }));
        await enrichFromEntityStorage(newResults);
        if (newResults.length > 0) {
          const sort = relatedSortState.column ? relatedSortState : { column: 'lastVisit', direction: 'desc' };
          vs.appendData(applySortOrder(newResults, sort));
        }
      }
    };
  }

  // Time chart for explore results
  const chartData = results.map(r => ({ url: r.url, timestamp: r.timestamps?.[0] || Date.now(), attention: '' }));
  renderTimeChartInto(
    document.getElementById('relatedChart'),
    document.getElementById('relatedChartBars'),
    chartData,
    'Explore results'
  );
  bindChartBarClick(document.getElementById('relatedChart'), document.getElementById('relatedResults'));
}

// --- Focus Panel ---

async function openFocusPanel(url, title) {
  const overlay = document.getElementById('focusOverlay');
  const content = document.getElementById('focusContent');

  content.innerHTML = '<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">Loading...</div></div></div>';
  overlay.classList.add('visible');

  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getPageRelations', url });
    if (!resp?.success) {
      content.innerHTML = '<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">Could not load relations</div></div></div>';
      return;
    }

    // Compute similar pages from loaded history
    const seedInteraction = historyByUrl.get(url);
    let similar = [];
    if (seedInteraction) {
      const seed = { ...seedInteraction, timestamps: [seedInteraction.timestamp || Date.now()], attScore: 0, attDetail: null, notes: [] };
      const candidates = Array.from(historyByUrl.values())
        .filter(i => i.url !== url)
        .map(i => ({ ...i, timestamps: [i.timestamp || Date.now()], attScore: 0, attDetail: null, notes: [] }));
      similar = findRelatedPages([seed], candidates, 20);
    }

    renderFocusWaterfall(content, url, title, resp.parents, resp.children, similar);
  } catch (error) {
    content.innerHTML = `<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">${escapeHtml('Error: ' + error.message)}</div></div></div>`;
  }
}

async function openListFocusPanel(listId, listName) {
  const overlay = document.getElementById('focusOverlay');
  const content = document.getElementById('focusContent');

  content.innerHTML = '<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">Loading...</div></div></div>';
  overlay.classList.add('visible');

  try {
    let pins = allListPins[listId];
    if (!pins) {
      const fpResp = await sendAction({ action: 'loadListPinsById', listId });
      pins = fpResp.pins;
      allListPins[listId] = pins;
    }

    let html = '';

    // Pinned pages section
    html += '<div class="focus-section"><div class="focus-section-label">Pinned</div><div class="focus-section-cards">';
    if (pins.length === 0) {
      html += '<div class="focus-empty">No pinned pages</div>';
    } else {
      const maxAtt = 0.1;
      const { pageSnap: fpSnap, spi: fpSpi } = await loadPinContext(pins);
      html += pins.map(p => {
        const ref = resolvePageRef(p.id, fpSnap, fpSpi);
        const title = ref?.user_title || ref?.title || 'Untitled';
        const url = ref?.url || '';
        return resultRowHtml(title, url, {
          deletable: false, attScore: 0, maxAtt, timestamps: [p.pinnedAt || Date.now()], context: 'global', noFocusButton: true
        });
      }).join('');
    }
    html += '</div></div>';

    content.innerHTML = html;

    // Bind event delegation for focus content cards
    bindFocusContentDelegation(content);
  } catch (error) {
    content.innerHTML = `<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">${escapeHtml('Error: ' + error.message)}</div></div></div>`;
  }
}

function renderFocusWaterfall(content, url, title, parents, children, similar) {
  const maxAtt = 0.1;
  const focusOpts = { deletable: false, maxAtt, context: 'global', noFocusButton: true };

  function makeCard(cardUrl, cardTitle, opts = {}) {
    const hist = historyByUrl.get(cardUrl);
    let resolvedTitle = cardTitle || (hist ? (hist.user_title || hist.title) : null);
    if (!resolvedTitle) {
      try { resolvedTitle = new URL(cardUrl).hostname + new URL(cardUrl).pathname; } catch { resolvedTitle = cardUrl; }
    }
    const timestamps = hist ? [hist.timestamp || Date.now()] : [Date.now()];
    const attScore = 0;
    return resultRowHtml(resolvedTitle, cardUrl, { ...focusOpts, attScore, timestamps, ...opts });
  }

  let html = '';

  // Parents section
  html += '<div class="focus-section"><div class="focus-section-label">Parents</div><div class="focus-section-cards">';
  const hasParents = (parents.referrers.length + parents.lists.length) > 0;
  if (!hasParents) {
    html += '<div class="focus-empty">No known parents</div>';
  } else {
    html += parents.referrers.map(ref => makeCard(ref, null)).join('');
  }
  html += '</div></div>';

  // Focused page
  html += '<div class="focus-section"><div class="focus-section-label">Focus</div><div class="focus-section-cards">';
  html += makeCard(url, title, { cssClass: 'focus-highlight' });
  html += '</div></div>';

  // Children section
  html += '<div class="focus-section"><div class="focus-section-label">Children</div><div class="focus-section-cards">';
  if (children.length === 0) {
    html += '<div class="focus-empty">No known children</div>';
  } else {
    html += children.map(childUrl => makeCard(childUrl, null)).join('');
  }
  html += '</div></div>';

  // Similar section
  if (similar.length > 0) {
    html += '<div class="focus-section"><div class="focus-section-label">Similar</div><div class="focus-section-cards">';
    html += similar.map(s => makeCard(s.url, s.title)).join('');
    html += '</div></div>';
  }

  content.innerHTML = html;

  // Bind delegation for focus content
  bindFocusContentDelegation(content);
}

function closeFocusPanel() {
  document.getElementById('focusOverlay').classList.remove('visible');
}

function bindFocusContentDelegation(content) {
  // Re-use result delegation for expand on focus cards
  bindResultDelegation(content);

  // Focus card row clicks (not on buttons) re-open focus for that URL
  if (content._focusDelegationBound) return;
  content._focusDelegationBound = true;

  // Pin clicks inside focus panel
  content.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('.result-pin');
    if (pinBtn) {
      e.stopPropagation();
      const url = pinBtn.dataset.pinUrl;
      const title = pinBtn.dataset.pinTitle;
      const cid = getActivePinListId();
      await toggleResultPin(cid, url, title);
      // Update pin button appearance
      pinBtn.classList.toggle('pinned');
      // Refresh background UI
      if (activeView.type === 'explore') {
        refreshExplorePins();
      } else if (activeView.type === 'list') {
        const lst = { id: cid, qbTrees: activeView.qbTrees, name: activeView.name };
        showList(lst);
      }
      return;
    }
  });

  content.addEventListener('click', (e) => {
    // Skip if click was on a button or handled by result delegation
    if (e.target.closest('.result-expand') || e.target.closest('.result-delete') ||
        e.target.closest('.result-pin') ||
        e.target.closest('.result-focus') || e.target.closest('.attention-dot-wrap')) return;

    const row = e.target.closest('.result-row');
    if (!row) return;

    // Don't re-focus the highlighted (focused) page
    const item = row.closest('.result-item');
    if (item && item.classList.contains('focus-highlight')) return;

    e.stopPropagation();
    openFocusPanel(row.dataset.url, row.dataset.title);
  });
}

// --- Initialize ---
async function initialize() {
  const _t0 = performance.now();
  const _timer = (label) => console.debug(`[init-timer] ${label}: ${(performance.now() - _t0).toFixed(0)}ms`);

  // Load settings from filesystem
  relatedPagesLimit = await loadSettingsValue('relatedPagesLimit', 50);
  document.getElementById('relatedPagesLimit').value = relatedPagesLimit;
  historyFileBatch = await loadSettingsValue('historyFileBatch', 10);
  document.getElementById('historyFileBatch').value = historyFileBatch;
  _timer('loadSettings');

  // Initialize query builder and chart tooltips
  qbRoot = qbCreatePlaceholder(KEYWORD_FIELDS);
  initCharts();
  _timer('initCharts');

  // Render sidebar concurrently with heavy data (don't block on sidebar)
  renderLists().catch(err => showFatalError(err.message));
  renderBlacklist();
  renderTrimRules();
  _timer('renderSidebar (fire-and-forget)');

  // Load metadata in parallel (history is demand-loaded in showCategory, pins loaded per-list)
  await Promise.all([
    initHistoryFiles(), loadGatewayDomains(),
    sendAction({ action: 'loadListPinsById', listId: EXPLORE_LIST_ID }).then(resp => { allListPins[EXPLORE_LIST_ID] = resp.pins; }),
  ]);
  _timer('parallel metadata load');
  updateExploreBadge();
  showExplore();

  // Focus overlay: close on backdrop click or Escape
  document.getElementById('focusOverlay').addEventListener('click', (e) => {
    // Close when clicking the backdrop (not the content)
    if (e.target === e.currentTarget) closeFocusPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('focusOverlay').classList.contains('visible')) {
      e.stopPropagation();
      closeFocusPanel();
    }
  });

  // Explore button: drag-to-explore
  const exploreBtn = document.getElementById('exploreBtn');
  exploreBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    exploreBtn.classList.add('drag-over');
  });
  exploreBtn.addEventListener('dragleave', () => {
    exploreBtn.classList.remove('drag-over');
  });
  exploreBtn.addEventListener('drop', async (e) => {
    e.preventDefault();
    exploreBtn.classList.remove('drag-over');
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.items) {
        if (!allListPins[EXPLORE_LIST_ID]) allListPins[EXPLORE_LIST_ID] = [];
        const pins = allListPins[EXPLORE_LIST_ID];
        const newUrls = [];
        for (const item of data.items) {
          const pinId = 'page:' + generateSlugFromUrl(item.url);
          if (!pins.some(p => p.id === pinId || p.id === 'shallow:' + item.url)) {
            pins.push({ id: pinId, pinnedAt: Date.now() });
            newUrls.push(item.url);
          }
        }
        if (newUrls.length > 0) {
          await chrome.runtime.sendMessage({ action: 'addListPins', listId: EXPLORE_LIST_ID, urls: newUrls });
          updateExploreBadge();
          if (activeView.type === 'explore') showExplore();
        }
      }
    } catch {}
  });
}

initialize().catch(err => showFatalError(err.message));
