// Options page for Portal extension
// Bookmark-manager style UI with sidebar navigation, search, and settings modal
import { FileSystemStorage } from './filesystem-storage.js';
import init, { Interaction, SearchEngine, searchBatch } from './pkg/portal_extension.js';
import { mergeBufferIntoInteractions, getBufferContentMap, buildInteractionsForEngine, extractInteractionBuffer } from './search-helpers.js';
import { generateSlugFromUrl, saveSettingsValue } from './utils.js';

const fsStorage = new FileSystemStorage();

// Read settings from session cache → local filesystem (no background relay).
// Dirty objects are always in session cache, so stale filesystem reads are safe.
async function loadSettingsValue(key, defaultValue) {
  try {
    const cached = await chrome.storage.session.get(key);
    if (key in cached) return cached[key];
  } catch {}
  try {
    const settings = await fsStorage.loadSettings();
    if (key in settings) return settings[key];
  } catch {}
  return defaultValue;
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
const HISTORY_FILE_BATCH = 10;    // files per load
const HISTORY_MAX_FILES = 100;    // cap total loaded files
let historyFiles = [];             // all JSONL filenames, newest-first
let historyLoadedCount = 0;        // how many files loaded so far
let historyByUrl = new Map();      // url → interaction (deduped, newest wins)
let historyLoading = false;        // guard against concurrent loads
let activeView = { type: 'category', value: 'all' }; // or { type: 'search', query: '...' } or { type: 'collection', query: '...', id: '...' } or { type: 'explore', query: '...', filter: '...' }
let allCollectionPins = {}; // collectionId -> [{ url, title, pinnedAt }]
let recycleBin = []; // [{ url, title, deletedAt }] — global recycle bin
let permanentDeletes = []; // [url, ...] — permanently deleted URLs
let lastClickedRow = null; // for shift-click range select
let marqueeActive = false; // suppress click during marquee drag
let gatewayDomainsCache = {}; // { [origin]: { rootUrl, childCount, fetched } }
let gatewayDomainsLoaded = false;
let bufferContentMap = {}; // slug → markdown from write buffer (small, kept in memory)
let pendingPin = null; // { query, qbTree? } — set during pin naming mode
// pinnedFilterCtx removed — pinned section no longer has related pages
const EXPLORE_COLLECTION_ID = 'explore';
// Collection results and atom data are cached in chrome.storage.session
// (managed by background for atoms, by options for collection results).
// Keys: 'atom:{slug}' for atoms, 'colCache:{id}' for collection results.
let colCacheKeys = []; // tracks which colCache:* keys exist in session

// --- Query builder state ---
let qbNodeIdCounter = 0;
let qbRoot = null;        // tree root (null = empty)
let cachedAllHighlights = null; // slug → highlights[], lazy-loaded
let qbDebounceTimer = null;
let savedExploreQbRoot = null;  // saved global explore QB state when viewing a collection

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

// --- Pipelined search ---
let capturesMatchCache = null; // Map<queryString, Set<url>> — cleared on history reset

async function pipelinedSearch(query) {
  await initWasm();
  await fsStorage.loadDirectoryHandle();
  const rootDir = fsStorage.directoryHandle;
  if (!rootDir) throw new Error('No storage directory configured');
  const historyDir = await rootDir.getDirectoryHandle('history');
  const atomsDir = await rootDir.getDirectoryHandle('atoms');

  const files = await fsStorage.listInteractionFiles();

  // Write buffer overlay
  const { writeBuffer = [] } = await chrome.storage.local.get(['writeBuffer']);
  const interactionBuffer = extractInteractionBuffer(writeBuffer);
  bufferContentMap = getBufferContentMap(interactionBuffer);

  // WASM reads files directly (no JS↔WASM data copy)
  const CHUNK = 10;
  const chunks = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    chunks.push(files.slice(i, i + CHUNK));
  }

  const byUrl = new Map();
  const batchResults = await Promise.all(
    chunks.map(chunk => searchBatch(historyDir, atomsDir, query, chunk))
  );
  for (const results of batchResults) {
    for (const r of results) {
      const existing = byUrl.get(r.url);
      if (!existing || r.score > existing.score) byUrl.set(r.url, r);
    }
  }

  // Also search write buffer entries
  if (interactionBuffer.length > 0) {
    const bufferItems = interactionBuffer.map(e => e.interaction);
    const engine = new SearchEngine();
    buildInteractionsForEngine(Interaction, engine, bufferItems, bufferContentMap);
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
  try {
    historyFiles = await fsStorage.listInteractionFiles();
  } catch (error) {
    console.log('Filesystem not available:', error.message);
  }
  // Merge write buffer (newest unwritten data)
  const { writeBuffer = [] } = await chrome.storage.local.get(['writeBuffer']);
  const interactionBuffer = extractInteractionBuffer(writeBuffer);
  for (const entry of interactionBuffer) {
    const item = entry.interaction;
    if (!historyByUrl.has(item.url) || item.timestamp > historyByUrl.get(item.url).timestamp) {
      historyByUrl.set(item.url, item);
    }
  }
  bufferContentMap = getBufferContentMap(interactionBuffer);
}

async function loadHistoryBatch() {
  if (historyLoading || historyLoadedCount >= historyFiles.length
      || historyLoadedCount >= HISTORY_MAX_FILES) return [];
  historyLoading = true;
  const batch = historyFiles.slice(historyLoadedCount, historyLoadedCount + HISTORY_FILE_BATCH);
  try {
    const t0 = performance.now();
    const interactions = await fsStorage.loadInteractionFiles(batch);
    const newItems = [];
    for (const item of interactions) {
      if (!historyByUrl.has(item.url)) {
        historyByUrl.set(item.url, item);
        newItems.push(item);
      }
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
  historyLoading = false;
  cachedFieldRanges = null;
  capturesMatchCache = null;
  // Invalidate collection results in session
  if (colCacheKeys.length > 0) {
    chrome.storage.session.remove(colCacheKeys.map(id => 'colCache:' + id));
    colCacheKeys = [];
  }
  allCollectionPins = {};
  cachedAllHighlights = null;
  gatewayDomainsCache = {};
  gatewayDomainsLoaded = false;
  bufferContentMap = {};
}

// --- Collection pins (filesystem) ---
async function loadAllCollectionPins() {
  try {
    allCollectionPins = await fsStorage.loadCollectionPins();
  } catch (error) {
    console.log('Could not load collection pins:', error.message);
  }
  return allCollectionPins;
}

async function saveCollectionPinsById(collectionId) {
  try {
    await chrome.runtime.sendMessage({ action: 'saveCollectionPinsById', collectionId, pins: allCollectionPins[collectionId] || [] });
  } catch (error) {
    console.log('Could not save collection pins:', error.message);
  }
}

function getActivePinCollectionId() {
  if (activeView.type === 'explore') return EXPLORE_COLLECTION_ID;
  if (activeView.type === 'collection') return activeView.id;
  return EXPLORE_COLLECTION_ID; // default: pin to explore
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
  await saveCollectionPinsById(collectionId);
}

// --- Recycle bin ---
// Global recycle bin: { url, title, deletedAt }
// Permanent deletes: URLs that are gone forever

async function loadRecycleBin() {
  recycleBin = await loadSettingsValue('recycleBin', []);
  const pdCached = await chrome.storage.session.get('permanentDeletes');
  permanentDeletes = pdCached.permanentDeletes || (await fsStorage.loadPermanentDeletes().catch(() => []));
  return recycleBin;
}

async function saveRecycleBin() {
  await saveSettingsValue('recycleBin', recycleBin);
  await chrome.runtime.sendMessage({ action: 'savePermanentDeletes', urls: permanentDeletes });
  await chrome.storage.session.set({ permanentDeletes });
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
    refreshCurrentView();
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

// Show chart frame + column headers immediately (bars and rows fill in after data loads)
function renderResultsSkeleton(opts = {}) {
  const { showRelevance = false } = opts;
  const chartEl = document.getElementById('attentionChart');
  chartEl.querySelector('.chart-bars').innerHTML = '';
  chartEl.classList.add('visible');

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = columnHeaderHtml('global', { hasDelete: isDeletableView(), hasPin: false, showRelevance });
  vs.setData([], () => '');
}

// Show collection chart frames + column headers immediately
function renderCollectionSkeleton() {
  // Pinned section: show column header
  const pinnedSection = document.querySelector('.collection-section[data-section="pinned"]');
  pinnedSection.style.display = '';
  const pinnedContainer = document.getElementById('pinnedResults');
  pinnedContainer.innerHTML = columnHeaderHtml('pinned', { hasDelete: true, hasPin: true });
  bindColumnHeaderClicks(pinnedContainer);

  // Explore section: show chart frame + column header
  const relatedChart = document.getElementById('relatedChart');
  relatedChart.querySelector('.chart-bars').innerHTML = '';
  relatedChart.classList.add('visible');
  const vs = getOrCreateRelatedScroller();
  vs._headerHtml = columnHeaderHtml('related', { hasDelete: true, hasPin: true, showRelevance: false });
  vs.setData([], () => '');
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

// Remove deleted/restored rows from the list without full view reload.
// For virtual scroller views, removes from the data array and re-renders incrementally.
// For recycle bin (no virtual scroller), removes DOM nodes directly.
function removeDeletedRows(container, urls, isRecycleBin) {
  const vs = container._virtualScroller;
  if (!isRecycleBin && vs && vs.data.length > 0) {
    vs.removeItems(urls);
  } else {
    // Recycle bin or non-scroller view: remove DOM nodes directly
    const urlSet = new Set(urls);
    for (const item of [...container.querySelectorAll('.result-item')]) {
      const row = item.querySelector('.result-row');
      if (row && urlSet.has(row.dataset.url)) item.remove();
    }
    if (isRecycleBin && container.querySelectorAll('.result-item').length === 0) {
      displayMessage('Recycle bin is empty');
    }
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
  if (gatewayDomainsLoaded) return;
  const result = await chrome.storage.session.get(['gatewayDomains']);
  gatewayDomainsCache = result.gatewayDomains || {};
  gatewayDomainsLoaded = true;
}

function isGatewayUrl(url) {
  try {
    const parsed = new URL(url);
    const entry = gatewayDomainsCache[parsed.origin];
    return !!(entry && entry.rootUrl === url && entry.childCount >= 2);
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
bindChartTooltip(document.getElementById('relatedChart'));

// Chart ↔ Results mapping: chartBarsId → resultsContainerId
const chartResultsPairs = [
  ['chartBars', 'results'],
  ['relatedChartBars', 'relatedResults'],
];

function syncChartHighlights() {
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

function applyDateFilter(chartEl, resultsContainer) {
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


// --- Display ---
async function showCategory(category) {
  activeView = { type: 'category', value: category };
  updateSidebarActive();
  updateMainTitle(categoryLabel(category));
  document.getElementById('pinSearchBtn').style.display = 'none';
  document.getElementById('queryBuilder').style.display = 'none';

  if (category === 'recycleBin') {
    showNormalLayout();
    document.getElementById('attentionChart').classList.remove('visible');
    if (recycleBin.length > 0) {
      document.getElementById('restoreAllBtn').style.display = '';
      document.getElementById('deleteAllBtn').style.display = '';
    }
    displayRecycleBinRows();
    return;
  }

  renderResultsSkeleton();
  showNormalLayout();

  if (category === 'gateways') await loadGatewayDomains();

  // Demand-load history
  await initHistoryFiles();
  await loadHistoryBatch();
  const interactions = Array.from(historyByUrl.values());
  interactions.sort((a, b) => b.timestamp - a.timestamp);
  const filtered = filterByCategory(interactions, category);
  renderAttentionChart(filtered);
  displayInteractionRows(filtered);

  // Wire up demand-loading on scroll
  const vs = getOrCreateGlobalScroller();
  vs.onLoadMore = async () => {
    const newItems = await loadHistoryBatch();
    if (newItems.length > 0) {
      const newFiltered = filterByCategory(newItems, activeView.value);
      if (newFiltered.length > 0) {
        vs.appendData(processInteractionsForDisplay(newFiltered));
      }
      // Re-render chart with all loaded history
      const allInteractions = Array.from(historyByUrl.values());
      const allFiltered = filterByCategory(allInteractions, activeView.value);
      renderAttentionChart(allFiltered);
    }
  };
}

async function showSearch(query) {
  if (!query.trim()) {
    if (activeView.type === 'category') showCategory(activeView.value);
    else showExplore();
    return;
  }

  activeView = { type: 'search', query };
  updateSidebarActive();
  updateMainTitle(`Search: ${query}`);
  document.getElementById('pinSearchBtn').style.display = 'flex';
  document.getElementById('queryBuilder').style.display = 'none';
  showNormalLayout();

  renderResultsSkeleton({ showRelevance: true });

  try {
    const results = await pipelinedSearch(query);

    if (results.length === 0) {
      displayMessage('No results found');
      return;
    }

    renderAttentionChart(results.map(r => ({ url: r.url, timestamp: r.timestamp, attention: '' })));
    displaySearchResults(results);
  } catch (error) {
    console.error('Search error:', error);
    displayMessage('Error performing search: ' + error.message);
  }
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

function prepareSeed(seed) {
  let hostname = '', origin = '';
  try { const u = new URL(seed.url); hostname = u.hostname; origin = u.origin; } catch {}
  return {
    hostname, origin,
    titleTokens: titleWords(seed.title),
    intentTokens: titleWords(seed.intent),
    timestamps: seed.timestamps || [],
  };
}

function scorePair(seedData, cand) {
  let candHostname = '', candOrigin = '';
  try { const u = new URL(cand.url); candHostname = u.hostname; candOrigin = u.origin; } catch {}
  let score = 0;
  if (candHostname && seedData.hostname === candHostname) {
    score += 0.30;
    if (candOrigin === seedData.origin) score += 0.10;
  }
  score += 0.30 * jaccardSimilarity(seedData.titleTokens, titleWords(cand.title));
  const candTs = cand.timestamps || [];
  if (seedData.timestamps.length > 0 && candTs.length > 0)
    score += 0.25 * scoreTemporalProximity(seedData.timestamps, candTs);
  score += 0.15 * jaccardSimilarity(seedData.intentTokens, titleWords(cand.intent));
  return score;
}

function findRelatedPages(seeds, candidates, poolLimit) {
  if (seeds.length === 0) return [];
  const pool = new Map(); // url → { item, relatedness }

  for (const seed of seeds) {
    if (pool.size >= poolLimit) break;

    const seedData = prepareSeed(seed);
    for (const cand of candidates) {
      if (pool.size >= poolLimit && !pool.has(cand.url)) continue;
      const score = scorePair(seedData, cand);
      if (score > 0) {
        const existing = pool.get(cand.url);
        if (!existing || score > existing.relatedness) {
          pool.set(cand.url, { ...cand, relatedness: score });
        }
      }
    }
  }

  return [...pool.values()]
    .sort((a, b) => b.relatedness - a.relatedness)
    .slice(0, poolLimit);
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
  if (fields.includes('captures')) {
    const trimmed = value.trim();
    if (capturesMatchCache && capturesMatchCache.has(trimmed)) {
      if (capturesMatchCache.get(trimmed).has(item.url)) return true;
    }
  }
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
  if (fields.includes('title') && textMatches(item.title, q, exact)) score += 2.0;
  if (fields.includes('url') && textMatches(item.url, q, exact)) score += 1.0;
  if (fields.includes('captures')) {
    const trimmed = value.trim();
    if (capturesMatchCache && capturesMatchCache.has(trimmed)) {
      if (capturesMatchCache.get(trimmed).has(item.url)) score += 1.0;
    }
  }
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

// --- Stream-evaluate a qbTree against all JSONL files ---
async function evaluateQueryStream(qbTree) {
  const files = await fsStorage.listInteractionFiles();
  const highlightsMap = treeNeedsHighlights(qbTree)
    ? await fsStorage.loadAllHighlights()
    : {};
  if (treeNeedsHighlights(qbTree)) cachedAllHighlights = highlightsMap;
  await loadGatewayDomains();

  const capturesQueries = extractCapturesQueries(qbTree);
  if (capturesQueries.size > 0) {
    capturesMatchCache = await precomputeCapturesMatches(capturesQueries);
  } else {
    capturesMatchCache = null;
  }

  // Merge write buffer
  const { writeBuffer = [] } = await chrome.storage.local.get(['writeBuffer']);
  const interactionBuffer = extractInteractionBuffer(writeBuffer);
  const seenUrls = new Set();
  const results = [];

  // Process buffer entries first (newest)
  for (const entry of interactionBuffer) {
    const item = entry.interaction;
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    const enriched = enrichSingle(item, highlightsMap);
    if (!isPermanentlyDeleted(enriched.url) && !isRecycled(enriched.url) && evaluateNode(qbTree, enriched)) results.push(enriched);
  }

  for (let fi = 0; fi < files.length; fi += 10) {
    const batchItems = await fsStorage.loadInteractionFiles(files.slice(fi, fi + 10));
    for (const item of batchItems) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      const enriched = enrichSingle(item, highlightsMap);
      if (!isPermanentlyDeleted(enriched.url) && !isRecycled(enriched.url) && evaluateNode(qbTree, enriched)) results.push(enriched);
    }
  }
  return results;
}

// Enrich a single interaction for QB evaluation
function enrichSingle(item, highlightsMap) {
  const slug = item.slug || '';
  const highlights = (slug && highlightsMap && highlightsMap[slug]) || [];
  const attParsed = parseAttention(item);
  return {
    url: item.url, title: item.title, slug, timestamps: [item.timestamp],
    attScore: attParsed ? attentionStrength(attParsed) : 0, attDetail: attParsed,
    highlights,
    visitCount: 1,
    lastVisit: item.timestamp,
    firstVisit: item.timestamp,
    timeOnPage: attParsed?.timeOnPage || 0,
    scrollDepth: attParsed?.scrollDepth || 0,
    clicks: attParsed?.clicks || 0,
    intent: item.intent || '',
  };
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

  if (!inCollection) renderResultsSkeleton();

  const matched = await evaluateQueryStream(qbRoot);

  if (inCollection) {
    // Save updated qbTree to collection storage
    saveCollectionQbTree();
    runCollectionExploreQuery(matched);
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

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = columnHeaderHtml('global', { hasDelete: true, hasPin: false, showRelevance: hasKeywords });
  vs.setData(normalized, (r) =>
    resultRowHtml(r.title, r.url, {
      deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      highlights: r.highlights, timestamps: r.timestamps, context: 'global', relevance: r.relevance
    })
  );

  // Render attention chart for matched results
  renderAttentionChart(matched.map(r => ({ url: r.url, timestamp: r.lastVisit || Date.now(), attention: '' })));

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

function runCollectionExploreQuery(matched) {
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

  const hasKeywords = treeHasKeyword(qbRoot);
  const results = exploreMatched.map(item => ({
    ...item,
    relevance: hasKeywords ? computeRelevance(qbRoot, item) : 0,
    highlights: item.highlights || [],
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
  vs._headerHtml = columnHeaderHtml('related', { hasDelete: true, hasPin: true, showRelevance: hasKeywords });
  vs.setData(normalized, (r) =>
    resultRowHtml(r.title, r.url, {
      pinned: isResultPinned(collectionId, r.url),
      deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      highlights: r.highlights, timestamps: r.timestamps, context: 'related', relevance: r.relevance,
    })
  );
  bindPinClicks(relatedContainer, collectionId);

  // Attention chart for explore results — use enriched data directly
  const chartData = exploreMatched.map(r => ({ url: r.url, timestamp: r.lastVisit || Date.now(), attention: '' }));
  renderAttentionChartInto(
    document.getElementById('relatedChart'),
    document.getElementById('relatedChartBars'),
    chartData,
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
  // In explore/collection view, always use block layout
  if (activeView.type === 'explore' || activeView.type === 'collection') {
    // Copy mutated qbRoot back to active block's tree
    const block = exploreBlocks.find(b => b.id === activeBlockId);
    if (block && block.type === 'manual') block.tree = qbRoot;
    renderExploreBlocks();
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
    // In explore/collection view, always use block query
    if (activeView.type === 'explore' || activeView.type === 'collection') {
      runExploreBlockQuery();
    } else {
      runQuery();
    }
  }, 300);
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
  document.getElementById('pinSearchBtn').style.display = 'none';

  // Always use collection layout with block-based explore
  showCollectionLayout();
  renderCollectionSkeleton();

  const pins = getExplorePins();
  const collectionId = EXPLORE_COLLECTION_ID;

  // Hide pinned section when no pins
  const pinnedSection = document.querySelector('.collection-section[data-section="pinned"]');
  if (pins.length === 0) {
    pinnedSection.style.display = 'none';
  } else {
    // Enrich pins with atom data from session
    const pinSlugs = pins.map(p => generateSlugFromUrl(p.url));
    const atomKeys = pinSlugs.map(s => 'atom:' + s);
    const atomData = atomKeys.length > 0 ? await chrome.storage.session.get(atomKeys) : {};
    const atomSnap = new Map();
    for (const slug of pinSlugs) {
      const atom = atomData['atom:' + slug];
      if (atom) atomSnap.set(slug, atom);
    }

    function enrichResult(r) {
      const slug = generateSlugFromUrl(r.url);
      const cached = atomSnap.get(slug);
      const source = (cached && cached.watermark > (r.watermark || 0)) ? cached : r;
      const attParsed = source.attDetail || (source.attention ? parseAttention({ attention: source.attention }) : null);
      const attScore = attParsed ? attentionStrength(attParsed) : (source.attScore || 0);
      const pin = pins.find(p => p.url === r.url);
      return {
        ...r, slug, attScore, attDetail: attParsed,
        highlights: source.highlights || r.highlights || [],
        timestamps: [source.watermark || r.watermark || r.pinnedAt || Date.now()],
        pinnedAt: pin ? pin.pinnedAt : (r.pinnedAt || null),
      };
    }

    const fullPinned = pins.map(enrichResult);
    renderPinnedSection(fullPinned, collectionId);
  }

  // Load history for block evaluation and fallback display
  await initHistoryFiles();
  await loadHistoryBatch();

  // Build auto-blocks from pins (empty array if no pins)
  exploreBlocks = pins.length > 0 ? await buildExploreAutoBlocks(pins) : [];
  renderExploreBlocks();
  runExploreBlockQuery();
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
  renderCollectionSkeleton();

  try {
    const collectionId = collection.id;

    // Lazy-load pins for this collection
    if (!allCollectionPins[collectionId]) {
      allCollectionPins[collectionId] = await fsStorage.loadCollectionPinsById(collectionId);
    }
    const pins = allCollectionPins[collectionId] || [];

    // Batch-read atoms from session for all pin slugs (one IPC call)
    const pinSlugs = pins.map(p => generateSlugFromUrl(p.url));
    const atomKeys = pinSlugs.map(s => 'atom:' + s);
    const atomData = atomKeys.length > 0 ? await chrome.storage.session.get(atomKeys) : {};
    const atomSnap = new Map();
    for (const slug of pinSlugs) {
      const atom = atomData['atom:' + slug];
      if (atom) atomSnap.set(slug, atom);
    }

    // Enrich from cached pin fields + session atom cache (no further I/O)
    function enrichResult(r) {
      const slug = generateSlugFromUrl(r.url);
      const cached = atomSnap.get(slug);
      // Use session atom if available and newer than pin's watermark, else use pin's cached fields
      const source = (cached && cached.watermark > (r.watermark || 0)) ? cached : r;
      const attParsed = source.attDetail || (source.attention ? parseAttention({ attention: source.attention }) : null);
      const attScore = attParsed ? attentionStrength(attParsed) : (source.attScore || 0);
      const pin = pins.find(p => p.url === r.url);
      return {
        ...r, slug, attScore, attDetail: attParsed,
        highlights: source.highlights || r.highlights || [],
        timestamps: [source.watermark || r.watermark || r.pinnedAt || Date.now()],
        pinnedAt: pin ? pin.pinnedAt : (r.pinnedAt || null),
      };
    }

    // --- Pinned+Related section: cache in session or async fetch ---
    const colCacheKey = 'colCache:' + collectionId;
    const cachedPinned = (await chrome.storage.session.get(colCacheKey))[colCacheKey] || null;
    if (cachedPinned) {
      renderPinnedSection(cachedPinned.fullPinned, collectionId);
    } else {
      renderPinnedSection(pins.map(enrichResult), collectionId);
      fetchCollectionResults(collection, collectionId, pins, enrichResult);
    }

    // --- Explore section: always immediate ---
    renderCollectionExplore(collection);

    // Fire-and-forget: refresh atoms in background and update pin file
    refreshCollectionAtoms(collectionId, pins);
  } catch (error) {
    console.error('Collection load error:', error);
    document.getElementById('pinnedResults').innerHTML = `<div class="no-results">${escapeHtml('Error: ' + error.message)}</div>`;
  }
}

// Background refresh: load fresh atoms and update pin file + cache
async function refreshCollectionAtoms(collectionId, pins) {
  try {
    const slugs = pins.map(p => generateSlugFromUrl(p.url));
    if (slugs.length === 0) return;
    // Read atoms: session cache (dirty/recent) → filesystem (cold)
    const atoms = {};
    const uncachedSlugs = [];
    const atomKeys = slugs.map(s => 'atom:' + s);
    const sessionAtoms = atomKeys.length > 0 ? await chrome.storage.session.get(atomKeys) : {};
    for (const slug of slugs) {
      const cached = sessionAtoms['atom:' + slug];
      if (cached) atoms[slug] = cached;
      else uncachedSlugs.push(slug);
    }
    if (uncachedSlugs.length > 0) {
      const fsAtoms = await fsStorage.loadAtomBatch(uncachedSlugs);
      Object.assign(atoms, fsAtoms);
    }
    let changed = false;
    for (const pin of pins) {
      const slug = generateSlugFromUrl(pin.url);
      const atom = atoms[slug];
      if (!atom) continue;
      if ((atom.watermark || 0) > (pin.watermark || 0)) {
        const attParsed = atom.attention ? parseAttention({ attention: atom.attention }) : null;
        pin.attScore = attParsed ? attentionStrength(attParsed) : 0;
        pin.attDetail = attParsed;
        pin.highlights = atom.highlights || [];
        pin.watermark = atom.watermark;
        changed = true;
      }
    }
    if (changed) {
      allCollectionPins[collectionId] = pins;
      saveCollectionPinsById(collectionId);
    }
  } catch (error) {
    console.debug('refreshCollectionAtoms failed:', error.message);
  }
}

// Async: fetch search results, compute pinned+related, cache, and render both sections
async function fetchCollectionResults(collection, collectionId, pins, enrichResult) {
  // Yield to browser so Phase 1 paints first
  await new Promise(resolve => setTimeout(resolve, 0));
  if (activeView.type !== 'collection' || activeView.id !== collectionId) return;

  try {
    let searchResults = [];

    if (collection.qbTree) {
      searchResults = await evaluateQueryStream(collection.qbTree);
    } else if (collection.query) {
      try {
        searchResults = await pipelinedSearch(collection.query);
      } catch (searchErr) {
        console.warn('Collection search failed:', searchErr.message);
      }
    }

    if (activeView.type !== 'collection' || activeView.id !== collectionId) return;

    // Enrich pinned pages with search result data where available
    const pinnedUrls = new Set(pins.map(p => p.url));
    const searchResultUrls = new Set(searchResults.map(r => r.url));
    const pinnedInResults = searchResults.filter(r => pinnedUrls.has(r.url)).map(enrichResult);
    const pinnedOnly = pins.filter(p => !searchResultUrls.has(p.url)).map(enrichResult);
    const fullPinned = [...pinnedInResults, ...pinnedOnly];

    // Cache pinned in session
    if (!colCacheKeys.includes(collectionId)) colCacheKeys.push(collectionId);
    chrome.storage.session.set({ ['colCache:' + collectionId]: { fullPinned } });

    renderPinnedSection(fullPinned, collectionId);
  } catch (error) {
    console.error('Collection fetch error:', error);
  }
}

// Render pinned rows (no related pages, no attention chart)
function renderPinnedSection(allPinned, collectionId) {
  const effectivePinnedSort = pinnedSortState.column ? pinnedSortState : { column: 'lastVisit', direction: 'desc' };
  const sortedPinned = applySortOrder(allPinned, effectivePinnedSort);
  const maxAtt = Math.max(...sortedPinned.map(r => r.attScore), 0.1);

  const pinnedSection = document.querySelector('.collection-section[data-section="pinned"]');
  const pinnedContainer = document.getElementById('pinnedResults');

  if (sortedPinned.length === 0) {
    pinnedSection.style.display = 'none';
  } else {
    pinnedSection.style.display = '';
    let html = columnHeaderHtml('pinned', { hasDelete: true, hasPin: true });
    html += sortedPinned.map(r =>
      resultRowHtml(r.title, r.url, { pinned: true, deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps, context: 'pinned', pinnedAt: r.pinnedAt })
    ).join('');
    pinnedContainer.innerHTML = html;
    bindColumnHeaderClicks(pinnedContainer);
    bindResultDelegation(pinnedContainer);
    bindPinClicks(pinnedContainer, collectionId);
  }
}

// renderPinnedWithRelated removed — pinned section only shows pinned rows

// recalculateRelatedResults removed — pinned section no longer has related pages

async function renderCollectionExplore(collection) {
  const collectionId = collection.id;
  const pins = allCollectionPins[collectionId] || [];

  // Load history for block evaluation
  await initHistoryFiles();
  await loadHistoryBatch();

  // Build auto-blocks from collection pins
  exploreBlocks = pins.length > 0 ? await buildExploreAutoBlocks(pins) : [];

  // Add saved qbTree as a manual block if present
  if (collection.qbTree) {
    exploreBlocks.push({
      id: ++exploreBlockIdCounter,
      type: 'manual',
      label: 'Saved query',
      enabled: true,
      tree: JSON.parse(JSON.stringify(collection.qbTree)),
    });
  }

  renderExploreBlocks();
  runExploreBlockQuery();
}

function displaySearchResults(results) {
  if (!results || results.length === 0) {
    displayMessage('No results found');
    return;
  }

  const total = results.length;
  const resultData = results.map((r, index) => {
    const timestamps = [r.timestamp || Date.now()];
    const relevance = total > 1 ? (total - index) / total : 1;
    return { ...r, attScore: 0, attDetail: null, highlights: [], timestamps, relevance };
  });

  // When sort is null, preserve WASM relevance order
  const sorted = applySortOrder(resultData, currentSortState);
  const maxAtt = Math.max(...sorted.map(r => r.attScore), 0.1);

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = columnHeaderHtml('global', { hasDelete: true, hasPin: false, showRelevance: true });
  vs.setData(sorted, (r) =>
    resultRowHtml(r.title, r.url, { deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps, context: 'global', relevance: r.relevance })
  );
}

// Convert raw interactions (already deduped by URL) to display entries
function processInteractionsForDisplay(interactions) {
  const byUrl = groupInteractionsByUrl(interactions);
  return [...byUrl.entries()].map(([url, group]) => {
    const latest = group.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    const agg = aggregateAttention(group);
    const highlights = [];
    const timestamps = group.map(i => i.timestamp);
    return { url, title: latest.title, attScore: agg.score, attDetail: agg.detail, highlights, timestamps, latestTs: latest.timestamp };
  });
}

function displayInteractionRows(interactions) {
  if (!interactions || interactions.length === 0) {
    displayMessage('No interactions found');
    return;
  }

  const entries = processInteractionsForDisplay(interactions);

  // When sort is null, default to lastVisit desc
  const effectiveSort = currentSortState.column ? currentSortState : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(entries, effectiveSort);
  const maxAtt = Math.max(...sorted.map(e => e.attScore), 0.1);

  const deletable = isDeletableView();
  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = columnHeaderHtml('global', { hasDelete: deletable, hasPin: false });
  vs.setData(sorted, (e) =>
    resultRowHtml(e.title, e.url, { deletable, attScore: e.attScore, maxAtt, attDetail: e.attDetail, highlights: e.highlights, timestamps: e.timestamps, context: 'global' })
  );
}

function displayRecycleBinRows() {
  const container = document.getElementById('results');
  if (recycleBin.length === 0) {
    displayMessage('Recycle bin is empty');
    return;
  }

  // Reset virtual scroller so scroll events don't overwrite recycle bin content
  if (globalVirtualScroller) {
    globalVirtualScroller.data = [];
    globalVirtualScroller.renderedRange = { start: -1, end: -1 };
  }

  // Use recycleBin array directly — guarantees count matches displayed list
  const entries = recycleBin
    .map(item => ({ url: item.url, title: item.title || 'Untitled', deletedAt: item.deletedAt }))
    .sort((a, b) => b.deletedAt - a.deletedAt);

  const RESTORE_SVG = '<svg viewBox="0 0 24 24"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18z"/></svg>';

  container.style.paddingTop = '0px';
  container.style.paddingBottom = '0px';
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

  // Bind expand delegation (shared handler — avoids double-toggle with recycle bin handler)
  bindResultDelegation(container);
  bindRecycleBinClicks(container);
}

function bindRecycleBinClicks(container) {
  if (container._recycleBinDelegationBound) return;
  container._recycleBinDelegationBound = true;

  container.addEventListener('click', async (e) => {
    // Expand, delete, and selection are handled by bindResultDelegation — only handle restore here
    const restoreBtn = e.target.closest('.result-restore');
    if (!restoreBtn) return;
    e.stopPropagation();
    const restoredUrls = [];
    const row = restoreBtn.closest('.result-row');
    if (row && row.classList.contains('selected')) {
      for (const r of container.querySelectorAll('.result-row.selected')) {
        restoredUrls.push(r.dataset.url);
        await restoreItem(r.dataset.url);
      }
    } else {
      restoredUrls.push(restoreBtn.dataset.restoreUrl);
      await restoreItem(restoreBtn.dataset.restoreUrl);
    }
    lastClickedRow = null;
    removeDeletedRows(container, restoredUrls, true);
  });
}

const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>';
const DELETE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const FOCUS_SVG = '<svg viewBox="0 0 24 24"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>';


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
  // Session atom cache has dirty highlights; filesystem has cold data
  let highlights = [];
  try {
    const cached = (await chrome.storage.session.get('atom:' + slug))['atom:' + slug];
    highlights = cached ? (cached.highlights || []) : await fsStorage.loadHighlights(slug);
  } catch (e) { /* filesystem not available */ }

  let snapshots = [];
  try {
    snapshots = await fsStorage.listSnapshots(slug);
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

  return { highlights, snapshots, belongedCollections, slug };
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

// opts: { pinned, deletable, attScore, maxAtt, attDetail, highlights, timestamps, context, pinnedAt, relevance, noFocusButton }
function resultRowHtml(title, url, opts = {}) {
  const safeTitle = escapeHtml(title || 'Untitled');
  const safeUrl = escapeHtml(url || '');
  const { pinned, deletable = false, attScore = 0, maxAtt = 1, attDetail = null, highlights = [], timestamps = [], context = 'global', pinnedAt, relevance, cssClass, noFocusButton = false } = opts;
  const extraCols = getExtraColumns(context);

  const lastVisit = timestamps.length > 0 ? formatTime(Math.max(...timestamps)) : '';
  const normalized = maxAtt > 0 ? attScore / maxAtt : 0;
  const dotColor = attentionColor(normalized);

  const isPinned = pinned !== undefined ? pinned : isResultPinned(getActivePinCollectionId(), url);
  const pinBtn = `<button class="result-pin${isPinned ? ' pinned' : ''}" data-pin-url="${safeUrl}" data-pin-title="${safeTitle}" title="${isPinned ? 'Unpin' : 'Pin'}">${PIN_SVG}</button>`;

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
            bindHighlightDeleteButtons(extraDiv);
          }
        }
        // Notify virtual scroller of height change
        if (container._virtualScroller) container._virtualScroller.onExpandToggle();
      }
      return;
    }

    const deleteBtn = e.target.closest('.result-delete');
    if (deleteBtn) {
      e.stopPropagation();
      const inRecycleBin = activeView.type === 'category' && activeView.value === 'recycleBin';
      const deletedUrls = [];
      const row = deleteBtn.closest('.result-row');
      if (row && row.classList.contains('selected')) {
        const selectedRows = container.querySelectorAll('.result-row.selected');
        for (const r of selectedRows) {
          deletedUrls.push(r.dataset.url);
          if (inRecycleBin) {
            await permanentlyDeleteItem(r.dataset.url);
          } else {
            await handleDelete(r.dataset.url, r.dataset.title);
          }
        }
      } else {
        const url = inRecycleBin ? deleteBtn.dataset.deleteUrl : deleteBtn.dataset.deleteUrl;
        deletedUrls.push(url);
        if (inRecycleBin) {
          await permanentlyDeleteItem(url);
        } else {
          await handleDelete(url, deleteBtn.dataset.deleteTitle);
        }
      }
      lastClickedRow = null;
      removeDeletedRows(container, deletedUrls, inRecycleBin);
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
    if (e.target.closest('.result-pin') || e.target.closest('.result-expand') || e.target.closest('.result-delete') || e.target.closest('.result-focus')) return;
    chrome.tabs.create({ url: row.dataset.url });
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

function bindPinClicks(container, collectionId) {
  // Use delegation — store collectionId on container for the handler
  container._pinCollectionId = collectionId;
  if (container._pinDelegationBound) return;
  container._pinDelegationBound = true;

  container.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('.result-pin');
    if (!pinBtn) return;
    e.stopPropagation();
    const url = pinBtn.dataset.pinUrl;
    const title = pinBtn.dataset.pinTitle;
    const cid = container._pinCollectionId;
    await toggleResultPin(cid, url, title);
    if (cid === EXPLORE_COLLECTION_ID) {
      showExplore();
    } else {
      const collection = { id: cid, query: activeView.query, qbTree: activeView.qbTree, name: activeView.name };
      showCollection(collection);
    }
  });
}

// --- Virtual Scroller ---
class VirtualScroller {
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

// Virtual scroller instances for main results and collection explore results
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
  bindPinClicks(containerEl, getActivePinCollectionId());
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
  document.getElementById('attentionChart').classList.remove('visible');
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

function categoryLabel(category) {
  const labels = { all: 'History', today: 'Today', week: 'This Week', highlighted: 'Highlighted', gateways: 'Gateways', recycleBin: 'Recycle Bin', explore: 'Explore' };
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
  return await loadSettingsValue('collections', []);
}

async function saveCollections(collections) {
  await saveSettingsValue('collections', collections);
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

    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-collection-reorder', collection.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.reorder-above, .reorder-below').forEach(el => {
        el.classList.remove('reorder-above', 'reorder-below');
      });
    });

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
      delete allCollectionPins[collection.id];
      chrome.storage.session.remove('colCache:' + collection.id);
      colCacheKeys = colCacheKeys.filter(id => id !== collection.id);
      await chrome.runtime.sendMessage({ action: 'saveCollectionPinsById', collectionId: collection.id, pins: [] });
      renderCollections();
      if (activeView.type === 'collection' && activeView.id === collection.id) {
        showExplore();
      }
    });

    // Drag-and-drop: collection as drop target (counter prevents child-triggered dragleave)
    let dragCounter = 0;
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer.types.includes('application/x-collection-reorder')) {
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
      if (!e.dataTransfer.types.includes('application/x-collection-reorder')) {
        dragCounter++;
        item.classList.add('drag-over');
      }
    });
    item.addEventListener('dragleave', (e) => {
      if (e.dataTransfer.types.includes('application/x-collection-reorder')) {
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

      if (e.dataTransfer.types.includes('application/x-collection-reorder')) {
        // --- Reorder ---
        const draggedId = e.dataTransfer.getData('application/x-collection-reorder');
        if (draggedId === collection.id) return;
        const collections = await loadCollections();
        const fromIdx = collections.findIndex(c => c.id === draggedId);
        if (fromIdx === -1) return;
        const [moved] = collections.splice(fromIdx, 1);
        let toIdx = collections.findIndex(c => c.id === collection.id);
        const rect = item.getBoundingClientRect();
        if (e.clientY >= rect.top + rect.height / 2) toIdx++;
        collections.splice(toIdx, 0, moved);
        await saveCollections(collections);
        await renderCollections();
      } else {
        // --- Pin drop (existing logic) ---
        dragCounter = 0;
        try {
          const data = JSON.parse(e.dataTransfer.getData('text/plain'));
          const items = data.items || [{ url: data.url, title: data.title }];
          if (!allCollectionPins[collection.id]) allCollectionPins[collection.id] = [];
          const pins = allCollectionPins[collection.id];
          let added = 0;
          for (const { url, title } of items) {
            if (url && !pins.some(p => p.url === url)) {
              pins.push({ url, title, pinnedAt: Date.now() });
              added++;
            }
          }
          if (added > 0) {
            await saveCollectionPinsById(collection.id);
            if (activeView.type === 'collection' && activeView.id === collection.id) {
              showCollection(collection);
            }
          }
        } catch (err) {
          console.error('Drop error:', err);
        }
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
    const deletedUrls = [...selectedRows].map(r => r.dataset.url);
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
    const container = document.getElementById('results');
    removeDeletedRows(container, deletedUrls, isRecycleBinView);
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
  const interactions = Array.from(historyByUrl.values());
  document.getElementById('totalInteractions').textContent = interactions.length;

  const today = new Date().setHours(0, 0, 0, 0);
  const todayCount = interactions.filter(i => i.timestamp >= today).length;
  document.getElementById('todayInteractions').textContent = todayCount;

  const result = await chrome.storage.local.get(['writeBuffer']);
  document.getElementById('bufferSize').textContent = (result.writeBuffer || []).length;

  updateCacheTable();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Session-cached keys live in chrome.storage.session; writeBuffer lives in chrome.storage.local
const SESSION_CACHE_KEYS = [
  { key: 'settings', label: 'Settings' },
  { key: 'workspace', label: 'Workspace' },
  { key: 'collections', label: 'Collections' },
  { key: 'urlBlacklist', label: 'URL Blacklist' },
  { key: 'titleTrimRules', label: 'Title Trim Rules' },
  { key: 'recycleBin', label: 'Recycle Bin' },
  { key: 'permanentDeletes', label: 'Permanent Deletes' },
  { key: 'gatewayDomains', label: 'Gateway Domains' },
];
const LOCAL_CACHE_KEYS = [
  { key: 'writeBuffer', label: 'Write Buffer' },
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

document.getElementById('clearCacheBtn').addEventListener('click', async () => {
  const btn = document.getElementById('clearCacheBtn');
  btn.disabled = true;
  btn.textContent = 'Reloading...';

  try {
    // Clear session cache keys (writeBuffer stays in local — it's a transient buffer for pending writes)
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
  const current = await loadSettingsValue('settings', {});
  current.relatedPagesLimit = relatedPagesLimit;
  await saveSettingsValue('settings', current);
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
    // New page visit — merge into historyByUrl immediately
    // The interaction is in the writeBuffer; read it on next refresh
    clearTimeout(mutationRefreshTimer);
    mutationRefreshTimer = setTimeout(async () => {
      // Reload writeBuffer overlay
      const { writeBuffer = [] } = await chrome.storage.local.get(['writeBuffer']);
      const interactionBuffer = extractInteractionBuffer(writeBuffer);
      let changed = false;
      for (const entry of interactionBuffer) {
        const item = entry.interaction;
        if (!historyByUrl.has(item.url) || item.timestamp > historyByUrl.get(item.url).timestamp) {
          historyByUrl.set(item.url, item);
          changed = true;
        }
      }
      if (changed && activeView.type === 'category') {
        const interactions = Array.from(historyByUrl.values());
        interactions.sort((a, b) => b.timestamp - a.timestamp);
        const filtered = filterByCategory(interactions, activeView.value);
        displayInteractionRows(filtered);
      }
    }, 500);
  } else if (type === 'pins') {
    // Collection pins changed — invalidate caches
    if (request.collectionId) {
      delete allCollectionPins[request.collectionId];
      chrome.storage.session.remove('colCache:' + request.collectionId);
      colCacheKeys = colCacheKeys.filter(id => id !== request.collectionId);
    } else {
      allCollectionPins = {};
      if (colCacheKeys.length > 0) {
        chrome.storage.session.remove(colCacheKeys.map(id => 'colCache:' + id));
        colCacheKeys = [];
      }
    }
  } else if (type === 'settings') {
    // Settings changed — re-render sidebar collections if collection list changed
    if (request.key === 'collections' || request.key === 'recycleBin') {
      renderCollections();
    }
  }
  // highlight, snapshot, permanentDeletes: session cache is already updated by background
});

// --- Visibility change: invalidate stale caches when tab regains focus ---
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;

  // Invalidate pin and collection caches (may have been modified in popup)
  allCollectionPins = {};
  if (colCacheKeys.length > 0) {
    chrome.storage.session.remove(colCacheKeys.map(id => 'colCache:' + id));
    colCacheKeys = [];
  }

  // Re-list history files and load any new ones
  try {
    const allFiles = await fsStorage.listInteractionFiles();
    const newFiles = allFiles.filter(f => !historyFiles.includes(f));
    if (newFiles.length > 0) {
      historyFiles = allFiles;
      const newInteractions = await fsStorage.loadInteractionFiles(newFiles);
      let changed = false;
      for (const item of newInteractions) {
        if (!historyByUrl.has(item.url) || item.timestamp > historyByUrl.get(item.url).timestamp) {
          historyByUrl.set(item.url, item);
          changed = true;
        }
      }
      if (changed && activeView.type === 'category') {
        const interactions = Array.from(historyByUrl.values());
        interactions.sort((a, b) => b.timestamp - a.timestamp);
        const filtered = filterByCategory(interactions, activeView.value);
        displayInteractionRows(filtered);
      }
    }
  } catch (error) {
    console.debug('visibilitychange refresh failed:', error.message);
  }
});

// --- Explore Pins ---

function getExplorePins() {
  return allCollectionPins[EXPLORE_COLLECTION_ID] || [];
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
  const pinnedUrls = new Set(pins.map(p => p.url));

  // Children of pins: URLs that appear in referrerIndex for each pin
  const { referrerIndex = {} } = await chrome.storage.session.get(['referrerIndex']);
  const childrenUrls = new Set();
  for (const pin of pins) {
    const children = referrerIndex[pin.url] || [];
    for (const childUrl of children) {
      if (!pinnedUrls.has(childUrl)) childrenUrls.add(childUrl);
    }
  }

  // Parents of pins: referrers from each pin's atom
  const pinSlugs = pins.map(p => generateSlugFromUrl(p.url));
  const atomKeys = pinSlugs.map(s => 'atom:' + s);
  const atomData = atomKeys.length > 0 ? await chrome.storage.session.get(atomKeys) : {};
  const parentUrls = new Set();
  for (const slug of pinSlugs) {
    const atom = atomData['atom:' + slug];
    if (atom && atom.referrers) {
      for (const ref of atom.referrers) {
        if (!pinnedUrls.has(ref)) parentUrls.add(ref);
      }
    }
  }

  // Similar to pins: use findRelatedPages
  const allEnriched = Array.from(historyByUrl.values()).map(r => ({
    ...r, timestamps: [r.timestamp || Date.now()], attScore: 0, attDetail: null, highlights: [],
  }));
  const seedEnriched = allEnriched.filter(e => pinnedUrls.has(e.url));
  const candidateEnriched = allEnriched.filter(e => !pinnedUrls.has(e.url));
  const similarResults = findRelatedPages(seedEnriched, candidateEnriched, relatedPagesLimit);
  const similarUrls = new Set(similarResults.map(r => r.url));

  const blocks = [];

  if (childrenUrls.size > 0) {
    blocks.push({
      id: ++exploreBlockIdCounter,
      type: 'auto',
      label: 'Children of pins',
      enabled: false,
      urls: childrenUrls,
    });
  }

  if (parentUrls.size > 0) {
    blocks.push({
      id: ++exploreBlockIdCounter,
      type: 'auto',
      label: 'Parents of pins',
      enabled: false,
      urls: parentUrls,
    });
  }

  if (similarUrls.size > 0) {
    blocks.push({
      id: ++exploreBlockIdCounter,
      type: 'auto',
      label: 'Similar to pins',
      enabled: false,
      urls: similarUrls,
    });
  }

  return blocks;
}

function renderExploreBlocks() {
  const container = document.getElementById('collectionQueryBuilder');
  container.style.display = 'block';

  let html = '<div class="explore-blocks">';

  const eyeOpenSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeClosedSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const removeSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  for (const block of exploreBlocks) {
    const enabledClass = block.enabled ? 'enabled' : 'disabled';
    const blockClass = block.enabled ? '' : ' disabled';
    const countLabel = block.urls ? `(${block.urls.size})` : '';

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

    // Right: full-height remove
    html += `<button class="explore-block-remove" data-block-id="${block.id}" title="Remove">${removeSvg}</button>`;

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
        tree: qbCreatePlaceholder(),
      };
      exploreBlocks.push(newBlock);
      renderExploreBlocks();
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
  if (activeView.type !== 'explore' && activeView.type !== 'collection') return;

  // Derive pinned URLs and collectionId from active view
  let pinnedUrls, collectionId;
  if (activeView.type === 'explore') {
    collectionId = EXPLORE_COLLECTION_ID;
    pinnedUrls = new Set(getExplorePins().map(p => p.url));
  } else {
    collectionId = activeView.id;
    pinnedUrls = new Set((allCollectionPins[collectionId] || []).map(p => p.url));
    // Auto-save the first manual block's tree back to the collection's qbTree
    const savedBlock = exploreBlocks.find(b => b.type === 'manual' && b.label === 'Saved query');
    if (savedBlock && savedBlock.tree) {
      qbRoot = savedBlock.tree;
      saveCollectionQbTree();
    }
  }

  const enabledBlocks = exploreBlocks.filter(b => b.enabled);
  let results;
  let showAllHistory = false;

  if (enabledBlocks.length === 0) {
    if (activeView.type === 'explore') {
      // Explore: show entire history when no blocks enabled
      showAllHistory = true;
      const allHistory = Array.from(historyByUrl.values());
      results = allHistory
        .filter(item => !pinnedUrls.has(item.url))
        .map(item => ({
          ...item,
          timestamps: [item.timestamp || Date.now()],
          attScore: 0,
          attDetail: null,
          highlights: [],
          relevance: 0,
        }));
    } else {
      // Collection: show empty state when no blocks enabled
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
          if (!pinnedUrls.has(url)) mergedUrls.add(url);
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
          if (!pinnedUrls.has(item.url)) mergedUrls.add(item.url);
        }
      }
    }

    // Build result items
    const allEnriched = Array.from(historyByUrl.values());
    results = [];
    for (const item of allEnriched) {
      if (pinnedUrls.has(item.url)) continue;
      if (matchAll || mergedUrls.has(item.url)) {
        results.push({
          ...item,
          timestamps: [item.timestamp || Date.now()],
          attScore: 0,
          attDetail: null,
          highlights: [],
          relevance: 0,
        });
      }
    }
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
  vs._headerHtml = columnHeaderHtml('related', { hasDelete: true, hasPin: true, showRelevance: false });
  vs.setData(sorted, (r) =>
    resultRowHtml(r.title, r.url, {
      pinned: isResultPinned(collectionId, r.url),
      deletable: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      highlights: r.highlights, timestamps: r.timestamps, context: 'related',
    })
  );
  bindPinClicks(relatedContainer, collectionId);

  // Demand-load more history when scrolling (for all-history mode)
  if (showAllHistory) {
    vs.onLoadMore = async () => {
      const newItems = await loadHistoryBatch();
      if (newItems.length > 0) {
        const newResults = newItems
          .filter(item => !pinnedUrls.has(item.url))
          .map(item => ({
            ...item,
            timestamps: [item.timestamp || Date.now()],
            attScore: 0, attDetail: null, highlights: [], relevance: 0,
          }));
        if (newResults.length > 0) vs.appendData(newResults);
      }
    };
  }

  // Attention chart for explore results
  const chartData = results.map(r => ({ url: r.url, timestamp: r.timestamps?.[0] || Date.now(), attention: '' }));
  renderAttentionChartInto(
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
      const seed = { ...seedInteraction, timestamps: [seedInteraction.timestamp || Date.now()], attScore: 0, attDetail: null, highlights: [] };
      const candidates = Array.from(historyByUrl.values())
        .filter(i => i.url !== url)
        .map(i => ({ ...i, timestamps: [i.timestamp || Date.now()], attScore: 0, attDetail: null, highlights: [] }));
      similar = findRelatedPages([seed], candidates, 20);
    }

    renderFocusWaterfall(content, url, title, resp.parents, resp.children, similar);
  } catch (error) {
    content.innerHTML = `<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">${escapeHtml('Error: ' + error.message)}</div></div></div>`;
  }
}

async function openCollectionFocusPanel(collectionId, collectionName) {
  const overlay = document.getElementById('focusOverlay');
  const content = document.getElementById('focusContent');

  content.innerHTML = '<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">Loading...</div></div></div>';
  overlay.classList.add('visible');

  try {
    let pins = allCollectionPins[collectionId];
    if (!pins) {
      pins = await fsStorage.loadCollectionPinsById(collectionId);
      allCollectionPins[collectionId] = pins;
    }

    let html = '';

    // Pinned pages section
    html += '<div class="focus-section"><div class="focus-section-label">Pinned</div><div class="focus-section-cards">';
    if (pins.length === 0) {
      html += '<div class="focus-empty">No pinned pages</div>';
    } else {
      const maxAtt = 0.1;
      html += pins.map(p =>
        resultRowHtml(p.title || 'Untitled', p.url, {
          deletable: false, attScore: 0, maxAtt, timestamps: [p.pinnedAt || Date.now()], context: 'global', noFocusButton: true
        })
      ).join('');
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
    const resolvedTitle = cardTitle || (hist ? hist.title : cardUrl);
    const timestamps = hist ? [hist.timestamp || Date.now()] : [Date.now()];
    const attScore = 0;
    return resultRowHtml(resolvedTitle, cardUrl, { ...focusOpts, attScore, timestamps, ...opts });
  }

  let html = '';

  // Parents section
  html += '<div class="focus-section"><div class="focus-section-label">Parents</div><div class="focus-section-cards">';
  const hasParents = (parents.referrers.length + parents.collections.length) > 0;
  if (!hasParents) {
    html += '<div class="focus-empty">No known parents</div>';
  } else {
    html += parents.referrers.map(ref => {
      let refTitle = ref;
      try { refTitle = new URL(ref).hostname + new URL(ref).pathname; } catch {}
      return makeCard(ref, refTitle);
    }).join('');
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
  // Re-use result delegation for expand/pin on focus cards
  bindResultDelegation(content);

  // Focus card row clicks (not on buttons) re-open focus for that URL
  if (content._focusDelegationBound) return;
  content._focusDelegationBound = true;

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
  // Load settings from filesystem
  const settings = await loadSettingsValue('settings', {});
  relatedPagesLimit = settings.relatedPagesLimit || 50;
  document.getElementById('relatedPagesLimit').value = relatedPagesLimit;

  // Initialize query builder
  qbRoot = qbCreatePlaceholder();

  // Render sidebar concurrently with heavy data (don't block on sidebar)
  renderCollections(); // fire-and-forget: updates sidebar when ready
  renderBlacklist();
  renderTrimRules();

  // Load metadata in parallel (history is demand-loaded in showCategory, pins loaded per-collection)
  await Promise.all([
    initHistoryFiles(), loadRecycleBin(), loadGatewayDomains(),
    fsStorage.loadCollectionPinsById(EXPLORE_COLLECTION_ID).then(pins => { allCollectionPins[EXPLORE_COLLECTION_ID] = pins; }).catch(() => { allCollectionPins[EXPLORE_COLLECTION_ID] = []; }),
  ]);
  updateRecycleSidebarCount();
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
        if (!allCollectionPins[EXPLORE_COLLECTION_ID]) allCollectionPins[EXPLORE_COLLECTION_ID] = [];
        const pins = allCollectionPins[EXPLORE_COLLECTION_ID];
        let added = 0;
        for (const item of data.items) {
          if (!pins.some(p => p.url === item.url)) {
            pins.push({ url: item.url, title: item.title, pinnedAt: Date.now() });
            added++;
          }
        }
        if (added > 0) {
          await saveCollectionPinsById(EXPLORE_COLLECTION_ID);
          updateExploreBadge();
          if (activeView.type === 'explore') showExplore();
        }
      }
    } catch {}
  });
}

initialize();
