// Options page for Portal extension
// Bookmark-manager style UI with sidebar navigation, search, and settings modal
import { FileSystemStorage } from './filesystem-storage.js';
import init, { Interaction, SearchEngine, searchBatch } from './pkg/portal_extension.js';
import { mergeBufferIntoInteractions, getBufferContentMap, buildInteractionsForEngine, extractInteractionBuffer } from './search-helpers.js';
import { generateSlugFromUrl, generateSlugFromTitle, loadSettingsValue, saveSettingsValue, readCacheable, sendAction, escapeHtml } from './utils.js';
import { attentionStrength, attentionColor, aggregateAttention } from './attention-utils.js';
import { initCharts, renderTimeChart, renderTimeChartInto, bindChartBarClick, syncChartHighlights, applyDateFilter } from './time-chart.js';
import { VirtualScroller } from './virtual-scroller.js';
import { entityTypeLabel } from './entity-types.js';

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
const cardDataByUrl = new Map(); // url → { attDetail, timestamps } for detail overlay
const listNameById = new Map(); // listId → display name, populated by renderLists()
let marqueeActive = false; // suppress click during marquee drag
let bufferContentMap = {}; // slug → markdown from write buffer (small, kept in memory)
// pinnedFilterCtx removed — pinned section no longer has related pages
// Page data cached in chrome.storage.session (managed by background).
// Keys: 'page:{slug}' for pages.

// --- Search/filter state ---
let savedSearches = [];           // string[] — session-only, per-view UI state
let currentSearchInput = '';      // unsaved draft (also participates in live search)
let filterState = {
  firstSeen: { lo: null, hi: null },  // null = unbounded (days ago)
  lastSeen: { lo: null, hi: null },
  lists: {},                      // { listSlug: true } — only stores enabled lists; empty = show all (no filter)
  hasHighlights: null,            // null=any, true=require
  visitedMultipleTimes: null,
  hasChildren: null,
  attentionRange: { lo: null, hi: null },
};
let filterVisible = false;
let exploreDebounceTimer = null;

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
  const todayEntries = await readCacheable('log:' + todayStr) || [];
  const interactionBuffer = todayEntries.filter(e => (e.action === 'visit_page' || e.action === 'leave_page' || !e.action) && e.url);
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
      // Skip non-visit entries (settings, list ops, etc.)
      if (item.action && item.action !== 'visit_page' && item.action !== 'leave_page') continue;
      if (!item.url) continue;
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
  allListPins = {};

  bufferContentMap = {};
}


function getActivePinListId() {
  if (activeView.type === 'list') return activeView.id;
  return null;
}

function pinIdToUrl(id) {
  // All page pins are page:<slug> — need to resolve via page entity. Return null if can't resolve here.
  return null;
}

function slugFromPinId(id) {
  if (id.startsWith('page:')) return id.slice(5);
  if (id.startsWith('note:')) return id.slice(5);
}

// Resolve an array of pins to display-ready objects with title/url populated.
// Loads entity context, resolves each pin via resolvePageRef, falls back to
// historyByUrl for pins with null entity title.
// Returns { pinsResolved, pageSnap } — pageSnap is needed by enrichPinResult.
async function resolvePinsForDisplay(pins) {
  const { pageSnap, noteSnap } = await loadPinContext(pins);
  const pinsResolved = pins.map(p => {
    const ref = resolvePageRef(p.id, pageSnap, noteSnap);
    let url = ref?.url || null;
    let title = ref?.title || null;
    if (!title && url) {
      const hist = historyByUrl.get(url);
      if (hist?.title) title = hist.title;
    }
    return { ...p, url, title, user_title: ref?.user_title || null, isNote: ref?.isNote || false, childIds: ref?.childIds || [] };
  });
  return { pinsResolved, pageSnap };
}

// Resolve a typed page reference to entity-like data, or null.
// page:<slug> → page entity from pageSnap. note:<slug> → note entity.
function resolvePageRef(refId, pageSnap, noteSnap) {
  if (!refId) return null;
  if (refId.startsWith('page:')) {
    return pageSnap?.get(refId.slice(5)) || null;
  }
  if (refId.startsWith('note:')) {
    const note = noteSnap?.get(refId.slice(5));
    if (!note) return null;
    return { url: null, title: note.excerpt || 'Note', user_title: null, isNote: true, note };
  }
  return null;
}

// Load page entities for a set of pins.
// Session cache first, filesystem fallback for page: slugs not in session.
async function loadPinContext(pins) {
  const pagePinSlugs = [];
  const notePinSlugs = [];
  for (const p of pins) {
    if (p.id?.startsWith('page:')) pagePinSlugs.push(p.id.slice(5));
    else if (p.id?.startsWith('note:')) notePinSlugs.push(p.id.slice(5));
  }
  const sessionKeys = [...pagePinSlugs.map(s => 'page:' + s), ...notePinSlugs.map(s => 'note:' + s)];
  const sessionBatch = sessionKeys.length > 0 ? await chrome.storage.session.get(sessionKeys) : {};
  const pageSnap = new Map();
  const missingSlugs = [];
  for (const slug of pagePinSlugs) {
    const page = sessionBatch['page:' + slug];
    if (page) pageSnap.set(slug, page);
    else missingSlugs.push(slug);
  }
  if (missingSlugs.length > 0) {
    const pages = await Promise.all(missingSlugs.map(s => readCacheable('page:' + s)));
    for (let i = 0; i < missingSlugs.length; i++) {
      if (pages[i]) pageSnap.set(missingSlugs[i], pages[i]);
    }
  }
  const noteSnap = new Map();
  const missingNoteSlugs = [];
  for (const slug of notePinSlugs) {
    const note = sessionBatch['note:' + slug];
    if (note) noteSnap.set(slug, note);
    else missingNoteSlugs.push(slug);
  }
  if (missingNoteSlugs.length > 0) {
    const notes = await Promise.all(missingNoteSlugs.map(s => readCacheable('note:' + s)));
    for (let i = 0; i < missingNoteSlugs.length; i++) {
      if (notes[i]) noteSnap.set(missingNoteSlugs[i], notes[i]);
    }
  }
  return { pageSnap, noteSnap };
}

function isResultPinned(listId, url) {
  const pins = allListPins[listId] || [];
  const pageId = 'page:' + generateSlugFromUrl(url);
  return pins.some(p => p.id === pageId);
}

async function toggleResultPin(listId, url, title) {
  await chrome.runtime.sendMessage({ action: 'toggleListPin', listId, url });
  // Invalidate local cache — the entity now has the authoritative pin state.
  // The mutation notification will also invalidate, but callers that call
  // refreshPins() inline need the cache cleared before that runs.
  delete allListPins[listId];
}

// --- Layout switching (list vs normal vs recycle bin) ---
function showListLayout() {
  document.getElementById('timeChart').classList.remove('visible');
  document.getElementById('resultsWrapper').style.display = 'none';
  document.getElementById('listLayout').classList.add('visible');
  document.getElementById('recycleBinLayout').classList.remove('visible');
  document.getElementById('queryBuilder').style.display = 'none';
}

function showNormalLayout() {
  document.getElementById('resultsWrapper').style.display = '';
  document.getElementById('listLayout').classList.remove('visible');
  document.getElementById('recycleBinLayout').classList.remove('visible');
}

function showRecycleBinLayout() {
  document.getElementById('timeChart').classList.remove('visible');
  document.getElementById('resultsWrapper').style.display = 'none';
  document.getElementById('listLayout').classList.remove('visible');
  document.getElementById('recycleBinLayout').classList.add('visible');
  document.getElementById('queryBuilder').style.display = 'none';
}

// --- Recycle Bin ---

async function showRecycleBin() {
  activeView = { type: 'recycle-bin' };
  updateSidebarActive();
  updateMainTitle('Recycle Bin');
  showRecycleBinLayout();

  const orphaned = await readCacheable('manifest:orphaned');
  const keys = orphaned?.keys || [];
  const itemsEl = document.getElementById('recycleBinItems');
  const emptyEl = document.getElementById('recycleBinEmpty');
  const headerEl = document.querySelector('.recycle-bin-header');
  itemsEl.innerHTML = '';

  if (keys.length === 0) {
    emptyEl.style.display = '';
    headerEl.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  headerEl.style.display = '';

  for (const key of keys) {
    const typeLabel = entityTypeLabel(key);
    const typeCls = 'type-' + typeLabel.toLowerCase();

    // Load entity to get display name
    let displayName = key;
    if (key.startsWith('snapshot:')) {
      // snapshot:<pageSlug>-<timestamp> — derive display name from key
      const snapStem = key.slice('snapshot:'.length);
      const lastDash = snapStem.lastIndexOf('-');
      const pageSlug = snapStem.slice(0, lastDash);
      const ts = parseInt(snapStem.slice(lastDash + 1), 10);
      displayName = `${pageSlug} — ${new Date(ts).toLocaleString()}`;
    } else {
      try {
        const entity = await sendAction({ action: 'readCacheable', key, includeDeleted: true });
        if (entity) {
          displayName = entity.name || entity.excerpt || entity.title || entity.slug || key;
        }
      } catch {}
    }

    const card = document.createElement('div');
    card.className = 'recycle-card';
    card.dataset.key = key;
    card.innerHTML = `
      <span class="entity-type-badge ${typeCls}">${escapeHtml(typeLabel)}</span>
      <div class="recycle-card-info">
        <div class="recycle-card-name">${escapeHtml(displayName)}</div>
        <div class="recycle-card-key">${escapeHtml(key)}</div>
      </div>
      <button class="restore-btn">Restore</button>
    `;
    card.querySelector('.restore-btn').addEventListener('click', async () => {
      if (key.startsWith('snapshot:')) {
        const snapSlug = key.slice('snapshot:'.length);
        await sendAction({ action: 'restoreSnapshot', snapSlug });
      } else if (key.startsWith('note:')) {
        const slug = key.slice('note:'.length);
        await sendAction({ action: 'restoreNote', noteSlug: slug });
      } else if (key.startsWith('list:')) {
        const id = key.slice('list:'.length);
        await sendAction({ action: 'restoreList', listId: id });
      }
    });
    itemsEl.appendChild(card);
  }

  // Empty bin button
  const emptyBtn = document.querySelector('.empty-bin-btn');
  // Clone to remove old listeners
  const newBtn = emptyBtn.cloneNode(true);
  emptyBtn.parentNode.replaceChild(newBtn, emptyBtn);
  newBtn.addEventListener('click', async () => {
    await sendAction({ action: 'permanentDeleteAll' });
  });
}

async function updateRecycleBinBadge() {
  const orphaned = await readCacheable('manifest:orphaned');
  const count = orphaned?.keys?.length || 0;
  const badge = document.getElementById('recycleBinCount');
  badge.textContent = count > 0 ? String(count) : '';
}

// Search parsing and matching functions

function parseSearchWords(query) {
  if (!query || !query.trim()) return [];
  const words = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(query)) !== null) {
    if (m[1]) words.push({ q: m[1], exact: true });
    else words.push({ q: m[2], exact: false });
  }
  return words;
}

function wordsMatchItem(words, item) {
  if (words.length === 0) return true;
  return words.every(({ q, exact }) => {
    const fields = [item.user_title, item.title, item.url];
    return fields.some(f => {
      if (!f) return false;
      if (exact) return f.includes(q);
      return f.toLowerCase().includes(q.toLowerCase());
    });
  });
}

function isDefaultFilterState(state) {
  return state.firstSeen.lo === null && state.firstSeen.hi === null
    && state.lastSeen.lo === null && state.lastSeen.hi === null
    && Object.keys(state.lists || {}).length === 0
    && state.hasHighlights === null && state.visitedMultipleTimes === null
    && state.hasChildren === null
    && state.attentionRange.lo === null && state.attentionRange.hi === null;
}

async function applyFilters(results) {
  if (isDefaultFilterState(filterState)) return results;
  const now = Date.now();
  // Build list membership index if any list bubbles are enabled
  const enabledLists = Object.entries(filterState.lists || {}).filter(([, v]) => v === true).map(([k]) => k);
  let listIndex = null;
  if (enabledLists.length > 0) {
    listIndex = await buildListMembershipIndex();
  }
  return results.filter(item => {
    // List membership filter: when bubbles are active, only show items in at least one enabled list
    if (listIndex && enabledLists.length > 0) {
      const memberOf = listIndex.get(item.slug);
      if (!memberOf || !enabledLists.some(ls => memberOf.has(ls))) return false;
    }
    // Time filters (days ago)
    if (filterState.lastSeen.lo !== null || filterState.lastSeen.hi !== null) {
      const lastTs = item.timestamps?.[0] || now;
      const daysAgo = (now - lastTs) / 86400000;
      if (filterState.lastSeen.lo !== null && daysAgo < filterState.lastSeen.lo) return false;
      if (filterState.lastSeen.hi !== null && daysAgo > filterState.lastSeen.hi) return false;
    }
    if (filterState.firstSeen.lo !== null || filterState.firstSeen.hi !== null) {
      const firstTs = item.firstTimestamp || item.timestamps?.[item.timestamps.length - 1] || now;
      const daysAgo = (now - firstTs) / 86400000;
      if (filterState.firstSeen.lo !== null && daysAgo < filterState.firstSeen.lo) return false;
      if (filterState.firstSeen.hi !== null && daysAgo > filterState.firstSeen.hi) return false;
    }
    // Page-specific booleans
    if (filterState.hasHighlights === true) {
      if (!item.notes || !item.notes.some(n => n.excerpt !== null)) return false;
    }
    if (filterState.visitedMultipleTimes === true) {
      if (!item.visitCount || item.visitCount <= 1) return false;
    }
    if (filterState.hasChildren === true) {
      if (!item.childIds || item.childIds.length === 0) return false;
    }
    // Attention range (timeOnPage in seconds)
    if (filterState.attentionRange.lo !== null || filterState.attentionRange.hi !== null) {
      const tp = item.attDetail?.timeOnPage || item.timeOnPage || 0;
      if (filterState.attentionRange.lo !== null && tp < filterState.attentionRange.lo) return false;
      if (filterState.attentionRange.hi !== null && tp > filterState.attentionRange.hi) return false;
    }
    return true;
  });
}

function saveFilterState() {
  const key = activeView.type === 'explore' ? 'exploreFilterState' : 'listFilterState:' + activeView.id;
  chrome.storage.session.set({ [key]: filterState });
}

async function loadFilterState() {
  const key = activeView.type === 'explore' ? 'exploreFilterState' : 'listFilterState:' + activeView.id;
  try {
    const data = await chrome.storage.session.get(key);
    if (data[key]) {
      filterState = data[key];
      return;
    }
  } catch { /* session miss */ }
  filterState = {
    firstSeen: { lo: null, hi: null },
    lastSeen: { lo: null, hi: null },
    lists: {},
    hasHighlights: null,
    visitedMultipleTimes: null,
    hasChildren: null,
    attentionRange: { lo: null, hi: null },
  };
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


// Show chart frame immediately (rows fill in after data loads)
function renderResultsSkeleton(opts = {}) {
  const chartEl = document.getElementById('timeChart');
  chartEl.querySelector('.chart-bars').innerHTML = '';
  chartEl.classList.add('visible');

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = '';
  vs.setData([], () => '');
}

// Show list chart frames immediately
function renderListSkeleton() {
  const relatedChart = document.getElementById('relatedChart');
  relatedChart.querySelector('.chart-bars').innerHTML = '';
  relatedChart.classList.add('visible');
  const vs = getOrCreateRelatedScroller();
  vs._headerHtml = '';
  vs.setData([], () => '');
}

function refreshCurrentView() {
  if (activeView.type === 'category') {
    showCategory(activeView.value);
  } else if (activeView.type === 'list') {
    showList({ slug: activeView.id, name: activeView.name });
  } else if (activeView.type === 'explore') {
    showExplore();
  } else if (activeView.type === 'recycle-bin') {
    showRecycleBin();
  }
}

function resortActiveScroller(context) {
  if (context === 'pinned') { refreshCurrentView(); return; }
  const vs = context === 'related' ? relatedVirtualScroller : globalVirtualScroller;
  if (!vs || vs.data.length === 0) { refreshCurrentView(); return; }

  const sortState = getSortState(context);
  const effectiveSort = sortState.column ? sortState : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder([...vs._fullData], effectiveSort);

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
    case 'all':
    default:
      return interactions;
  }
}

// Time chart tooltips initialized via initCharts() in initialize()


// --- Display ---
async function showCategory(category) {
  activeView = { type: 'category', value: category };
  updateSidebarActive();
  const categoryLabels = { all: 'History', today: 'Today', week: 'This Week', highlighted: 'Highlighted', explore: 'Explore' };
  updateMainTitle(categoryLabels[category] || category);
  document.getElementById('queryBuilder').style.display = 'none';

  renderResultsSkeleton();
  showNormalLayout();

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


// --- Query builder: Tree manipulation (n-ary operators) ---

// --- Stream-evaluate a qbTree against all JSONL files ---
// Deduplicates per-day: the same URL visited on different days produces separate
// results. Consumers must not assume results are unique by URL/slug.


// Save search queries to session storage (per-view, ephemeral)
function saveSearchQueries() {
  const viewKey = activeView.type === 'explore' ? 'explore'
    : activeView.type === 'list' ? `list:${activeView.id}` : null;
  if (!viewKey) return;
  chrome.storage.session.set({ [`searchQueries:${viewKey}`]: savedSearches }).catch(() => {});
}

// Load search queries from session storage for the current view
async function loadSearchQueries() {
  const viewKey = activeView.type === 'explore' ? 'explore'
    : activeView.type === 'list' ? `list:${activeView.id}` : null;
  if (!viewKey) return [];
  const data = await chrome.storage.session.get(`searchQueries:${viewKey}`);
  return data[`searchQueries:${viewKey}`] || [];
}


// --- Query builder: Rendering ---

// Shared pin enrichment: merges cached page data, attention scores, and pin timestamps.
// Uses historyByUrl fallback for attention when page entity lacks it (showList behavior).
function enrichPinResult(r, pins, pageSnap) {
  if (!r.url && !r.slug) return r;
  const slug = r.slug || generateSlugFromUrl(r.url);
  const cached = pageSnap.get(slug);
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






// Summarize a query tree into a short display name for lists

async function showExplore() {
  const _t0 = performance.now();
  const _timer = (label) => console.debug(`[explore-timer] ${label}: ${(performance.now() - _t0).toFixed(0)}ms`);

  activeView = { type: 'explore', name: null };
  updateSidebarActive();
  updateMainTitle('Explore');

  showListLayout();
  renderListSkeleton();

  try {
    savedSearches = await loadSearchQueries();
    currentSearchInput = '';

    await renderListSearchFilters();
    _timer('renderListSearchFilters');
  } catch (error) {
    console.error('Explore load error:', error);
    document.getElementById('relatedResults').innerHTML = `<div class="no-results">${escapeHtml('Error: ' + error.message)}</div>`;
  }
  document.body.dataset.ready = 'true';
}

// Incremental refresh after pin toggle — preserves scroll position and search state.
async function refreshPins() {
  if (activeView.type === 'explore') {
    runSearchFilterPipeline();
  } else if (activeView.type === 'list') {
    const listId = activeView.id;
    if (!allListPins[listId]) {
      const entity = await readCacheable('list:' + listId);
      allListPins[listId] = entity?.pins || [];
    }
    const pins = allListPins[listId];
    if (pins.length === 0) {
      document.getElementById('relatedResults').innerHTML = '<div class="no-results">No pinned pages</div>';
      document.getElementById('relatedChart').classList.remove('visible');
    } else {
      const { pinsResolved, pageSnap } = await resolvePinsForDisplay(pins);
      const enriched = pinsResolved.map(r => enrichPinResult(r, pins, pageSnap));
      renderListPinView(enriched, listId);
    }
  }
}

async function showList(list) {
  const displayName = listDisplayName(list);
  activeView = { type: 'list', id: list.slug, name: list.name || null };
  savedSearches = await loadSearchQueries();
  currentSearchInput = '';
  updateSidebarActive();
  updateMainTitle(displayName);

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
    const listEntity = await readCacheable('list:' + listId);
    allListPins[listId] = listEntity?.pins || [];
    const pins = allListPins[listId];

    if (pins.length === 0) {
      listPinsData = [];
      listPinsListId = listId;
      renderSearchPanel();
      document.getElementById('relatedResults').innerHTML = '<div class="no-results">No pinned pages</div>';
      document.getElementById('relatedChart').classList.remove('visible');
    } else {
      const { pinsResolved, pageSnap } = await resolvePinsForDisplay(pins);
      const enriched = pinsResolved.map(r => enrichPinResult(r, pins, pageSnap));
      renderListPinView(enriched, listId);
    }
  } catch (error) {
    console.error('List load error:', error);
    document.getElementById('relatedResults').innerHTML = `<div class="no-results">${escapeHtml('Error: ' + error.message)}</div>`;
  }
}


// Module-level storage for list pin data (used by search filtering)
let listPinsData = [];
let listPinsListId = null;

// Render all pins into #relatedResults with search filtering support
function renderListPinView(allPins, listId) {
  listPinsData = allPins;
  listPinsListId = listId;
  renderSearchPanel();
  runListPinFilter();
}

// Run the active view's search pipeline (debounced for explore, immediate for list)
function runActiveSearchPipeline() {
  if (activeView.type === 'explore') {
    if (exploreDebounceTimer) clearTimeout(exploreDebounceTimer);
    exploreDebounceTimer = setTimeout(() => runSearchFilterPipeline(), 300);
  } else if (activeView.type === 'list') {
    runListPinFilter();
  }
}

// Filter list pins by current queries + draft input
function runListPinFilter() {
  const allQueries = [...savedSearches];
  if (currentSearchInput.trim()) allQueries.push(currentSearchInput.trim());

  let filtered;
  if (allQueries.length === 0 || allQueries.every(q => !q.trim())) {
    filtered = listPinsData;
  } else {
    filtered = listPinsData.filter(r => {
      return allQueries.some(query => {
        const words = parseSearchWords(query);
        return wordsMatchItem(words, r);
      });
    });
  }
  renderFilteredPins(filtered, listPinsListId, allQueries.join(' '));
}

// Render filtered pin results into the virtual scroller + time chart
function renderFilteredPins(pins, listId, searchQuery) {
  const relatedContainer = document.getElementById('relatedResults');

  if (pins.length === 0) {
    relatedContainer.innerHTML = searchQuery.trim()
      ? '<div class="no-results">No matching pins</div>'
      : '<div class="no-results">No pinned pages</div>';
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  const effectiveSort = relatedSortState.column ? relatedSortState : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder([...pins], effectiveSort);
  const maxAtt = Math.max(...sorted.map(r => r.attScore), 0.1);

  const vs = getOrCreateRelatedScroller();
  vs._headerHtml = '';
  vs.updateData(sorted, (r) =>
    resultRowHtml(r.user_title || r.title, r.url, {
      pinned: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      notes: r.notes, timestamps: r.timestamps, context: 'related',
      pinnedAt: r.pinnedAt, childIds: r.childIds, excludeListId: listId, likes: r.likes,
    })
  );
  bindPinClicks(relatedContainer, listId);

  // Time chart for pins
  const chartData = sorted.map(r => ({ url: r.url, timestamp: r.timestamps?.[0] || r.pinnedAt || Date.now(), attention: '' }));
  renderTimeChartInto(
    document.getElementById('relatedChart'),
    document.getElementById('relatedChartBars'),
    chartData,
    'Pinned pages'
  );
  bindChartBarClick(document.getElementById('relatedChart'), relatedContainer);
}

// renderPinnedWithRelated removed — pinned section only shows pinned rows

// recalculateRelatedResults removed — pinned section no longer has related pages

async function renderListSearchFilters() {
  await initHistoryFiles();
  await loadHistoryBatch();

  await loadFilterState();
  renderSearchPanel();
  runSearchFilterPipeline();
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
async function enrichFromEntityStorage(entries) {
  const allSlugs = [...new Set(entries.map(r => r.slug).filter(Boolean))];
  if (allSlugs.length === 0) return;
  const loaded = await Promise.all(allSlugs.map(s => readCacheable('page:' + s)));
  const pages = {};
  for (let i = 0; i < allSlugs.length; i++) {
    if (loaded[i]) pages[allSlugs[i]] = loaded[i];
  }
  for (const entry of entries) {
    const page = pages[entry.slug];
    if (!page) continue;
    if (!entry.title && page.title) entry.title = page.title;
    if (!entry.user_title && page.user_title) entry.user_title = page.user_title;
    if (page.childIds) entry.childIds = page.childIds;
    if (page.likes) entry.likes = page.likes;
  }
}

// Enrich results with page entity fields needed by filters (notes, childIds, visitCount).
// Only called when non-default filters are active.
async function enrichForFilters(entries) {
  const slugs = [...new Set(entries.map(r => r.slug).filter(Boolean))];
  if (slugs.length === 0) return;
  const loaded = await Promise.all(slugs.map(s => readCacheable('page:' + s)));
  const pages = {};
  for (let i = 0; i < slugs.length; i++) {
    if (loaded[i]) pages[slugs[i]] = loaded[i];
  }
  for (const entry of entries) {
    const page = pages[entry.slug];
    if (!page) continue;
    if (page.notes && page.notes.length > 0) entry.notes = page.notes;
    if (page.childIds) entry.childIds = page.childIds;
    // visitCount: count from historyAllEntries
    if (entry.visitCount === undefined) {
      const count = historyAllEntries.filter(h => h.url === entry.url).length;
      entry.visitCount = count;
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
  vs._headerHtml = '';
  vs.setData(sorted, (e) =>
    resultRowHtml(e.user_title || e.title, e.url, { attScore: e.attScore, maxAtt, attDetail: e.attDetail, notes: e.notes, timestamps: e.timestamps, context: 'global', childIds: e.childIds, likes: e.likes })
  );
}

const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>';
const DELETE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';


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

  // Load page entity for likes
  const pageEntity = await readCacheable('page:' + slug);
  const likes = pageEntity?.likes || 0;

  // Find belonged lists (reverse lookup)
  const lists = await loadLists();
  const belongedLists = [];
  for (const lst of lists) {
    const pins = allListPins[lst.slug] || [];
    const pageId = 'page:' + generateSlugFromUrl(url);
    if (pins.some(p => p.id === pageId)) {
      belongedLists.push(listDisplayName(lst));
    }
  }

  return { notes, snapshots, belongedLists, slug, likes };
}

function renderExtraDetailHtml(extra) {
  let html = '';

  if (extra.likes > 0) {
    html += `<div class="detail-section"><span class="detail-section-label">Liked:</span> <strong>${extra.likes}</strong></div>`;
  }

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
      await chrome.runtime.sendMessage({ action: 'openSnapshot', slug, timestamp: ts });
    });
  });
}

function attentionLevel(normalized) {
  if (!normalized || normalized <= 0) return '';
  if (normalized >= 0.75) return 'high';
  if (normalized >= 0.4) return 'med';
  return 'low';
}

function resultRowHtml(title, url, opts = {}) {
  const safeUrl = escapeHtml(url || '<unknown>');
  const { pinned, deletable = false, attScore = 0, maxAtt = 1, attDetail = null, notes = [], timestamps = [], context = 'global', pinnedAt, cssClass, childIds = [], excludeListId, likes = 0 } = opts;

  const lastVisit = timestamps.length > 0 ? formatTime(Math.max(...timestamps)) : '';
  const normalized = maxAtt > 0 ? attScore / maxAtt : 0;

  let site = '';
  try {
    const parsed = new URL(url);
    site = parsed.protocol === 'file:' ? 'file' : parsed.hostname.replace(/^www\./, '');
  } catch {}

  const safeTitle = escapeHtml(title || site || url || '<unknown>');

  const dates = [...new Set(timestamps.map(ts => new Date(ts).toISOString().slice(0, 10)))].join(',');

  const hasNotes = childIds.some(id => id.startsWith('note:'));
  const hasSnaps = childIds.some(id => id.startsWith('snapshot:'));
  const belongedListNames = [];
  if (url) {
    const pageId = 'page:' + generateSlugFromUrl(url);
    for (const [listId, pins] of Object.entries(allListPins)) {
      if (excludeListId && listId === excludeListId) continue;
      if (Array.isArray(pins) && pins.some(p => p.id === pageId)) {
        const name = listNameById.get(listId);
        if (name) belongedListNames.push(name);
      }
    }
  }
  const attLvl = attentionLevel(normalized);
  if (url) cardDataByUrl.set(url, {
    attDetail: attDetail ? { timeOnPage: attDetail.timeOnPage, scrollDepth: attDetail.scrollDepth, clicks: attDetail.clicks } : null,
    timestamps,
  });
  const attCtrlHtml = `<div class="att-ctrl${attLvl ? ' ' + attLvl : ''}" data-url="${safeUrl}" data-title="${safeTitle}"><span class="att-ctrl-dot"></span><button class="att-ctrl-btn" title="View details">···</button></div>`;
  const listTagsHtml = belongedListNames.map(n => `<span class="card-tag card-tag-list">${escapeHtml(n)}</span>`).join('');
  const isLiked = likes > 0;
  const hasExtras = hasNotes || hasSnaps || isLiked || listTagsHtml;
  const extrasHtml = hasExtras ? `<div class="card-extras">${isLiked ? '<span class="card-tag card-tag-liked">liked</span>' : ''}${hasNotes ? '<span class="card-tag card-tag-note">note</span>' : ''}${hasSnaps ? '<span class="card-tag card-tag-snap">snapshot</span>' : ''}${listTagsHtml}</div>` : '';
  const cardActionsHtml = deletable ? `<div class="card-actions"><button class="result-delete" data-delete-url="${safeUrl}" data-delete-title="${safeTitle}" title="Delete">${DELETE_SVG}</button></div>` : '';

  return `<div class="result-item${cssClass ? ' ' + cssClass : ''}">
    <div class="result-row" data-url="${safeUrl}" data-title="${safeTitle}" data-dates="${dates}" draggable="true">
      <div class="card-row">
        <div class="result-title">${safeTitle}</div>
        <span class="result-site">${escapeHtml(site)}</span>
        <span class="result-time">${escapeHtml(lastVisit)}</span>
        ${attCtrlHtml}
      </div>
      ${cardActionsHtml}
    </div>
    ${extrasHtml}
  </div>`;
}

function bindResultDelegation(container) {
  if (container._resultDelegationBound) return;
  container._resultDelegationBound = true;

  container.addEventListener('click', (e) => {
    if (e.target.closest('.att-ctrl-btn')) {
      e.stopPropagation();
      const ctrl = e.target.closest('.att-ctrl');
      if (ctrl) {
        const { attDetail = null, timestamps = [] } = cardDataByUrl.get(ctrl.dataset.url) || {};
        openPageDetailCard(ctrl.dataset.url, ctrl.dataset.title, attDetail, timestamps);
      }
      return;
    }
    if (e.target.closest('.card-actions') || e.target.closest('.att-ctrl')) {
      e.stopPropagation();
      return;
    }

    const item = e.target.closest('.result-item');
    if (!item || marqueeActive) return;
    const row = item.querySelector('.result-row');
    if (!row) return;

    const allRows = [...container.querySelectorAll('.result-row')];
    if (e.shiftKey && lastClickedRow) {
      const anchorIdx = allRows.indexOf(lastClickedRow);
      const curIdx = allRows.indexOf(row);
      if (anchorIdx !== -1 && curIdx !== -1) {
        const [lo, hi] = anchorIdx < curIdx ? [anchorIdx, curIdx] : [curIdx, anchorIdx];
        if (!e.ctrlKey && !e.metaKey) allRows.forEach(r => r.classList.remove('selected'));
        for (let i = lo; i <= hi; i++) allRows[i].classList.add('selected');
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

  container.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.result-row');
    if (!row) return;
    if (e.target.closest('.result-pin') || e.target.closest('.card-actions') || e.target.closest('.att-ctrl')) return;
    chrome.tabs.create({ url: row.dataset.url });
  });

  container.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.result-row');
    if (!row) return;
    const items = [{ url: row.dataset.url, title: row.dataset.title }];
    e.dataTransfer.setData('text/plain', JSON.stringify({ items }));
    e.dataTransfer.effectAllowed = 'copy';
  });
}

function openPageDetailCard(url, title, attDetail = null, timestamps = []) {
  closePageDetailCard();

  const overlay = document.createElement('div');
  overlay.id = 'pageDetailOverlay';
  overlay.className = 'page-detail-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePageDetailCard(); });

  const card = document.createElement('div');
  card.className = 'page-detail-card';
  card.innerHTML = `
    <div class="page-detail-header">
      <div class="page-detail-title">${escapeHtml(title || url)}</div>
      <button class="page-detail-close" title="Close">×</button>
    </div>
    <div class="page-detail-body"><div class="page-detail-loading">Loading…</div></div>
  `;
  card.querySelector('.page-detail-close').addEventListener('click', closePageDetailCard);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  loadExtraDetail(url).then(extra => {
    const body = card.querySelector('.page-detail-body');
    let html = buildDetailHtml(url, attDetail, []);
    if (timestamps.length > 0) {
      const latest = Math.max(...timestamps);
      const fmt = new Date(latest).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', second: '2-digit',
      });
      html += `<div class="detail-visit-time">Last visited: <strong>${fmt}</strong></div>`;
    }
    const extraHtml = renderExtraDetailHtml(extra);
    body.innerHTML = html + (extraHtml ? `<div class="detail-extra">${extraHtml}</div>` : '');
    bindNoteDeleteButtons(body);
    bindSnapshotClickHandlers(body);
  });

  const onEsc = (e) => { if (e.key === 'Escape') closePageDetailCard(); };
  overlay._escHandler = onEsc;
  document.addEventListener('keydown', onEsc);
}

function closePageDetailCard() {
  const overlay = document.getElementById('pageDetailOverlay');
  if (overlay) {
    if (overlay._escHandler) document.removeEventListener('keydown', overlay._escHandler);
    overlay.remove();
  }
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
    refreshPins();
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

  titleEl.style.display = 'none';
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
  } else if (activeView.type === 'recycle-bin') {
    document.getElementById('recycleBinBtn').classList.add('active');
  }
}

// --- Lists (pinned searches) ---
async function loadListTree() {
  const root = await readCacheable('list:system/root');
  return buildTreeLevel(root?.childLists || []);
}
async function buildTreeLevel(keys) {
  const nodes = [];
  for (const key of keys) {
    const entity = await readCacheable(key);
    if (!entity || entity.deleted) continue;
    const slug = entity.slug || key.slice(5);
    const children = entity.childLists?.length ? await buildTreeLevel(entity.childLists) : [];
    const node = { slug, name: entity.name || slug, children, parentList: entity.parentList || 'list:system/root' };
    if (entity.auto) node.auto = true;
    nodes.push(node);
  }
  return nodes;
}
// Flatten tree for backward-compatible usage
async function loadLists() {
  const tree = await loadListTree();
  const flat = [];
  function walk(nodes) {
    for (const n of nodes) {
      flat.push({ slug: n.slug, name: n.name });
      walk(n.children);
    }
  }
  walk(tree);
  return flat;
}

// saveLists removed — use saveListMeta/deleteList messages instead

// Fold state: slug → boolean (true = expanded). Persisted in session storage.
let listFoldState = {};

async function loadFoldState() {
  try {
    const { listFoldState: saved } = await chrome.storage.session.get(['listFoldState']);
    if (saved) listFoldState = saved;
  } catch (e) { /* ignore */ }
}

function saveFoldState() {
  chrome.storage.session.set({ listFoldState }).catch(() => {});
}

// Cached tree for isDescendant lookups during drag-drop
let lastRenderedTree = [];

function isDescendant(ancestorSlug, targetSlug) {
  function search(nodes) {
    for (const n of nodes) {
      if (n.slug === ancestorSlug) return findInSubtree(n.children, targetSlug);
      if (search(n.children)) return true;
    }
    return false;
  }
  function findInSubtree(nodes, slug) {
    for (const n of nodes) {
      if (n.slug === slug) return true;
      if (findInSubtree(n.children, slug)) return true;
    }
    return false;
  }
  return search(lastRenderedTree);
}

async function renderLists() {
  const tree = await loadListTree();
  lastRenderedTree = tree;
  listNameById.clear();
  (function walkTree(nodes) {
    for (const n of nodes) {
      listNameById.set(n.slug, n.name);
      if (n.children?.length) walkTree(n.children);
    }
  })(tree);
  const listEl = document.getElementById('listsList');
  const empty = document.getElementById('listsEmpty');

  // Remove existing list items and children containers (keep the empty placeholder)
  listEl.querySelectorAll('.sidebar-item, .sidebar-children').forEach(el => el.remove());

  if (tree.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  renderTreeLevel(listEl, tree, 0);
  updateSidebarActive();
}

function renderTreeLevel(container, nodes, depth) {
  for (const node of nodes) {
    const item = createSidebarItem(node, depth);
    container.appendChild(item);

    if (node.children.length > 0) {
      const childContainer = document.createElement('div');
      childContainer.className = 'sidebar-children';
      childContainer.dataset.parentSlug = node.slug;
      const expanded = listFoldState[node.slug] !== false; // default expanded
      childContainer.style.display = expanded ? '' : 'none';
      renderTreeLevel(childContainer, node.children, depth + 1);
      container.appendChild(childContainer);
    }
  }
}

function createSidebarItem(node, depth) {
  const lst = node;
  const item = document.createElement('div');
  item.className = 'sidebar-item';
  item.dataset.listId = lst.slug;
  item.style.paddingLeft = (20 + depth * 16) + 'px';

  const hasChildren = node.children.length > 0;
  const expanded = listFoldState[node.slug] !== false;

  item.innerHTML = `
    ${hasChildren
      ? `<button class="fold-toggle" title="${expanded ? 'Collapse' : 'Expand'}">${expanded ? '\u25BE' : '\u25B8'}</button>`
      : '<span class="fold-spacer"></span>'}
    <span class="icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg></span>
    <span class="label">${escapeHtml(listDisplayName(lst))}</span>
    <button class="remove-list" title="Remove list">&times;</button>
  `;

  // Hide remove button for auto lists
  if (node.auto) {
    const removeBtn = item.querySelector('.remove-list');
    if (removeBtn) removeBtn.style.display = 'none';
  }

  // Fold/unfold toggle
  if (hasChildren) {
    item.querySelector('.fold-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const newExpanded = listFoldState[node.slug] === false; // toggle
      listFoldState[node.slug] = newExpanded;
      saveFoldState();
      const childContainer = item.nextElementSibling;
      if (childContainer?.classList.contains('sidebar-children')) {
        childContainer.style.display = newExpanded ? '' : 'none';
      }
      const btn = item.querySelector('.fold-toggle');
      btn.textContent = newExpanded ? '\u25BE' : '\u25B8';
      btn.title = newExpanded ? 'Collapse' : 'Expand';
    });
  }

  if (!node.auto) {
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-list-reorder', lst.slug);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      document.querySelectorAll('.reorder-above, .reorder-below, .nest-target').forEach(el => {
        el.classList.remove('reorder-above', 'reorder-below', 'nest-target');
      });
    });
  }

  item.addEventListener('click', (e) => {
    if (e.target.closest('.remove-list') || e.target.closest('.fold-toggle')) return;
    showList(lst);
  });

  item.querySelector('.remove-list').addEventListener('click', async (e) => {
    e.stopPropagation();
    await chrome.runtime.sendMessage({ action: 'deleteList', listId: lst.slug });
    delete allListPins[lst.slug];
    renderLists();
    if (activeView.type === 'list' && activeView.id === lst.slug) {
      showExplore();
    }
  });

  // Three-zone drag-and-drop
  let dragCounter = 0;
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('application/x-list-reorder')) {
      const draggedId = e.dataTransfer.getData('application/x-list-reorder');
      // Prevent dropping into own subtree
      if (draggedId === lst.slug || isDescendant(draggedId, lst.slug)) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.dataTransfer.dropEffect = 'move';
      const rect = item.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;
      item.classList.remove('reorder-above', 'reorder-below', 'nest-target');
      if (relY < 0.25) {
        item.classList.add('reorder-above');
      } else if (relY > 0.75) {
        item.classList.add('reorder-below');
      } else {
        item.classList.add('nest-target');
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
      item.classList.remove('reorder-above', 'reorder-below', 'nest-target');
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
    item.classList.remove('drag-over', 'reorder-above', 'reorder-below', 'nest-target');

    if (e.dataTransfer.types.includes('application/x-list-reorder')) {
      const draggedId = e.dataTransfer.getData('application/x-list-reorder');
      if (draggedId === lst.slug || isDescendant(draggedId, lst.slug)) return;

      // Determine drop zone
      const rect = item.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;

      // Get dragged entity's current parent
      const draggedEntity = await readCacheable('list:' + draggedId);
      const fromParent = draggedEntity?.parentList || 'list:system/root';
      const fromParentSlug = fromParent.startsWith('list:') ? fromParent.slice(5) : fromParent;

      if (relY >= 0.25 && relY <= 0.75) {
        // --- Nest as child ---
        const toParent = 'list:' + lst.slug;
        const toEntity = await readCacheable(toParent);
        const targetChildLists = toEntity?.childLists || [];
        await chrome.runtime.sendMessage({
          action: 'reparentList', listId: draggedId,
          fromParent: fromParentSlug, toParent: lst.slug,
          index: targetChildLists.length
        });
      } else {
        // --- Reorder above/below ---
        const targetParent = node.parentList || 'list:system/root';
        const targetParentSlug = targetParent.startsWith('list:') ? targetParent.slice(5) : targetParent;
        const parentEntity = await readCacheable(targetParent);
        const siblings = parentEntity?.childLists || [];
        let toIdx = siblings.indexOf('list:' + lst.slug);
        if (toIdx === -1) toIdx = siblings.length;
        if (relY >= 0.75) toIdx++;
        // Adjust if dragged is already a sibling and comes before target
        if (fromParentSlug === targetParentSlug) {
          const fromIdx = siblings.indexOf('list:' + draggedId);
          if (fromIdx !== -1 && fromIdx < toIdx) toIdx--;
        }
        await chrome.runtime.sendMessage({
          action: 'reparentList', listId: draggedId,
          fromParent: fromParentSlug, toParent: targetParentSlug,
          index: toIdx
        });
      }
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
          if (url && !pins.some(p => p.id === pinId)) {
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

  return item;
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

// --- Event listeners: Recycle Bin button ---
document.getElementById('recycleBinBtn').addEventListener('click', () => {
  showRecycleBin();
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
// Init marquee for list results
initMarqueeForElements(
  document.getElementById('relatedResultsWrapper'),
  document.getElementById('relatedResults')
);

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
  { key: 'manifest:settings', label: 'Settings' },
  { key: 'list:auto/gateways', label: 'Auto Gateways' },
  { key: 'manifest:name-to-id', label: 'List Name Map' },
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

document.getElementById('captureSnapshotVideo').addEventListener('change', async () => {
  await saveSettingsValue('captureSnapshotVideo', document.getElementById('captureSnapshotVideo').checked);
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
      const todayEntries = await readCacheable('log:' + new Date().toISOString().slice(0, 10)) || [];
      const interactionBuffer = todayEntries.filter(e => (e.action === 'visit_page' || e.action === 'leave_page' || !e.action) && e.url);
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
          runSearchFilterPipeline();
        } else {
          refreshCurrentView();
        }
      }
    }, 500);
  } else if (type === 'pins') {
    // List pins changed — invalidate caches and re-render active list.
    const activeListId = activeView.type === 'list' ? activeView.id : null;
    if (request.listId) {
      delete allListPins[request.listId];
      if (request.listId === activeListId) refreshCurrentView();
    } else {
      allListPins = {};
      if (activeListId) refreshCurrentView();
    }
  } else if (type === 'lists') {
    renderLists();
  } else if (type === 'settings') {
    // Settings changes that need UI updates handled here if needed
  } else if (type === 'note') {
    // Note created/deleted — invalidate cached notes and refresh view
  
    refreshCurrentView();
  } else if (type === 'orphaned') {
    // Orphaned list changed — refresh recycle bin if active, update badge
    updateRecycleBinBadge();
    if (activeView.type === 'recycle-bin') showRecycleBin();
  }
  // highlight, snapshot: session cache is already updated by background
});

// --- Visibility change: invalidate stale caches when tab regains focus ---
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;

  // Invalidate pin caches (may have been modified in popup)
  allListPins = {};

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

// --- Explore Search ---


function renderSearchPanel() {
  const container = document.getElementById('listQueryBuilder');
  container.style.display = 'block';
  const isExplore = activeView.type === 'explore';
  const placeholder = isExplore ? 'Search...' : 'Filter pins...';

  const removeSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  const filterSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';

  let html = '<div class="search-filters-panel" id="searchFiltersPanel">';
  if (savedSearches.length > 0) {
    html += '<div class="search-rows" id="searchRows">';
    for (let i = 0; i < savedSearches.length; i++) {
      html += `<div class="search-row" data-index="${i}">`;
      html += `<input type="text" class="search-row-input" value="${escapeHtml(savedSearches[i])}" data-index="${i}">`;
      html += `<button class="search-row-remove" data-index="${i}" title="Remove">${removeSvg}</button>`;
      html += `</div>`;
    }
    html += '</div>';
  }
  html += '<div class="search-draft">';
  html += `<input type="text" class="search-draft-input" id="searchDraftInput" placeholder="${placeholder}" value="${escapeHtml(currentSearchInput)}">`;
  if (isExplore) {
    html += `<button class="filter-toggle-btn${filterVisible ? ' active' : ''}${!isDefaultFilterState(filterState) ? ' has-filters' : ''}" id="filterToggleBtn" title="Filters">${filterSvg}</button>`;
  }
  html += '</div>';

  if (isExplore) {
    html += `<div class="filter-panel" id="filterPanel" style="display:${filterVisible ? 'block' : 'none'}">`;
    html += renderFilterPanelHtml();
    html += '</div>';
  }

  html += '</div>';

  container.innerHTML = html;
  bindSearchEvents(container);
  if (isExplore && filterVisible) bindFilterEvents(container);
}

function renderFilterPanelHtml() {
  let html = '';

  // List membership bubbles
  const lists = collectFilterLists();
  if (lists.length > 0) {
    html += '<div class="filter-section"><div class="filter-section-label">Lists</div>';
    html += '<div class="filter-bubbles">';
    for (const { slug, name } of lists) {
      const active = filterState.lists?.[slug] === true;
      html += `<button class="filter-bubble${active ? ' active' : ''}" data-list-slug="${escapeHtml(slug)}">${escapeHtml(name)}</button>`;
    }
    html += '</div></div>';
  }

  // Time filters
  html += '<div class="filter-section"><div class="filter-section-label">Time</div>';
  html += renderDualRangeFilter('lastSeen', 'Last seen', filterState.lastSeen);
  html += renderDualRangeFilter('firstSeen', 'First seen', filterState.firstSeen);
  html += '</div>';

  // Page-specific booleans
  html += '<div class="filter-section"><div class="filter-section-label">Page properties</div>';
  html += '<div class="filter-checkboxes">';
  html += renderCheckboxFilter('hasHighlights', 'Has highlights', filterState.hasHighlights);
  html += renderCheckboxFilter('visitedMultipleTimes', 'Visited multiple times', filterState.visitedMultipleTimes);
  html += renderCheckboxFilter('hasChildren', 'Has child pages', filterState.hasChildren);
  html += '</div>';
  html += '</div>';

  // Attention range
  html += '<div class="filter-section"><div class="filter-section-label">Attention</div>';
  html += renderDualRangeFilter('attentionRange', 'Time on page', filterState.attentionRange, 'timeOnPage');
  html += '</div>';

  return html;
}

// Collect list names for filter bubbles. In list context, exclude the current list.
function collectFilterLists() {
  const lists = [];
  function walk(nodes) {
    for (const node of nodes) {
      lists.push({ slug: node.slug, name: node.name });
      if (node.children) walk(node.children);
    }
  }
  walk(lastRenderedTree);
  // In list view, exclude the active list
  if (activeView.type === 'list') {
    return lists.filter(l => l.slug !== activeView.id);
  }
  return lists;
}

// Build reverse index: slug → Set of list slugs.
// Loads all list entities to get pins (allListPins may not have them all).
async function buildListMembershipIndex() {
  const index = new Map(); // slug → Set<listSlug>
  const lists = collectFilterLists();
  // Load entities for any lists not already in allListPins
  const toLoad = lists.filter(l => !allListPins[l.slug]);
  if (toLoad.length > 0) {
    const loaded = await Promise.all(toLoad.map(l => readCacheable('list:' + l.slug)));
    for (let i = 0; i < toLoad.length; i++) {
      if (loaded[i]?.pins) allListPins[toLoad[i].slug] = loaded[i].pins;
    }
  }
  for (const { slug: listSlug } of lists) {
    const pins = allListPins[listSlug] || [];
    for (const pin of pins) {
      const slug = slugFromPinId(pin.id);
      if (!slug) continue;
      if (!index.has(slug)) index.set(slug, new Set());
      index.get(slug).add(listSlug);
    }
  }
  return index;
}

function renderDualRangeFilter(stateKey, label, state, rangeField) {
  const field = rangeField || (stateKey === 'lastSeen' ? 'lastVisit' : stateKey === 'firstSeen' ? 'firstVisit' : 'timeOnPage');
  const cfg = getRangeConfig(field);
  const lo = state.lo !== null ? state.lo : cfg.min;
  const hi = state.hi !== null ? state.hi : cfg.max;
  const range = cfg.max - cfg.min;
  const loPercent = range > 0 ? ((lo - cfg.min) / range) * 100 : 0;
  const hiPercent = range > 0 ? ((cfg.max - hi) / range) * 100 : 0;

  let html = `<div class="filter-range" data-key="${stateKey}">`;
  html += `<span class="filter-range-label">${escapeHtml(label)}</span>`;
  html += `<div class="qb-dual-range">`;
  html += `<span class="qb-dual-range-label qb-dual-range-lo-label">${cfg.format(lo)}</span>`;
  html += `<div class="qb-dual-range-track">`;
  html += `<div class="qb-dual-range-fill" style="left:${loPercent}%;right:${hiPercent}%"></div>`;
  html += `<input type="range" class="filter-range-lo" data-key="${stateKey}" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${lo}">`;
  html += `<input type="range" class="filter-range-hi" data-key="${stateKey}" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${hi}">`;
  html += `</div>`;
  html += `<span class="qb-dual-range-label qb-dual-range-hi-label">${cfg.format(hi)}</span>`;
  html += `</div></div>`;
  return html;
}

function renderCheckboxFilter(stateKey, label, value) {
  const checked = value === true ? ' checked' : '';
  return `<label class="filter-checkbox"><input type="checkbox" data-key="${stateKey}"${checked}> ${escapeHtml(label)}</label>`;
}

function bindSearchEvents(container) {
  // Saved search row inputs — edit inline
  container.querySelectorAll('.search-row-input').forEach(input => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.index);
      savedSearches[idx] = input.value;
      runActiveSearchPipeline();
    });
    input.addEventListener('change', () => {
      saveSearchQueries();
    });
  });

  // Remove buttons
  container.querySelectorAll('.search-row-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      savedSearches.splice(idx, 1);
      renderSearchPanel();
      saveSearchQueries();
      runActiveSearchPipeline();
    });
  });

  // Draft input — live search
  const draftInput = container.querySelector('#searchDraftInput');
  if (draftInput) {
    draftInput.addEventListener('input', () => {
      currentSearchInput = draftInput.value;
      runActiveSearchPipeline();
    });
    draftInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && draftInput.value.trim()) {
        savedSearches.push(draftInput.value.trim());
        currentSearchInput = '';
        renderSearchPanel();
        saveSearchQueries();
        runActiveSearchPipeline();
        // Focus the new draft input
        document.querySelector('#searchDraftInput')?.focus();
      }
    });
  }

  // Filter toggle
  const filterBtn = container.querySelector('#filterToggleBtn');
  if (filterBtn) {
    filterBtn.addEventListener('click', () => {
      filterVisible = !filterVisible;
      const panel = container.querySelector('#filterPanel');
      if (panel) {
        panel.style.display = filterVisible ? 'block' : 'none';
        filterBtn.classList.toggle('active', filterVisible);
        if (filterVisible) bindFilterEvents(container);
      }
    });
  }
}

function bindFilterEvents(container) {
  // Dual-range sliders
  container.querySelectorAll('.filter-range-lo, .filter-range-hi').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.dataset.key;
      const rangeDiv = input.closest('.filter-range');
      const loInput = rangeDiv.querySelector('.filter-range-lo');
      const hiInput = rangeDiv.querySelector('.filter-range-hi');
      let lo = parseFloat(loInput.value);
      let hi = parseFloat(hiInput.value);
      // Prevent crossover
      if (lo > hi) {
        if (input.classList.contains('filter-range-lo')) { lo = hi; loInput.value = lo; }
        else { hi = lo; hiInput.value = hi; }
      }
      const field = key === 'lastSeen' ? 'lastVisit' : key === 'firstSeen' ? 'firstVisit' : 'timeOnPage';
      const cfg = getRangeConfig(field);
      // Update fill bar
      const fill = rangeDiv.querySelector('.qb-dual-range-fill');
      if (fill) {
        fill.style.left = ((lo - cfg.min) / (cfg.max - cfg.min)) * 100 + '%';
        fill.style.right = (100 - ((hi - cfg.min) / (cfg.max - cfg.min)) * 100) + '%';
      }
      // Update labels
      const loLabel = rangeDiv.querySelector('.qb-dual-range-lo-label');
      const hiLabel = rangeDiv.querySelector('.qb-dual-range-hi-label');
      if (loLabel) loLabel.textContent = cfg.format(lo);
      if (hiLabel) hiLabel.textContent = cfg.format(hi);
      // Update state: null if at boundary (= unbounded)
      filterState[key] = {
        lo: lo > cfg.min ? lo : null,
        hi: hi < cfg.max ? hi : null,
      };
      saveFilterState();
      runActiveSearchPipeline();
    });
  });

  // Checkbox filters
  container.querySelectorAll('.filter-checkbox input').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.key;
      filterState[key] = input.checked ? true : null;
      saveFilterState();
      // Update filter-toggle-btn indicator
      const btn = container.querySelector('#filterToggleBtn');
      if (btn) btn.classList.toggle('has-filters', !isDefaultFilterState(filterState));
      runActiveSearchPipeline();
    });
  });

  // List bubble toggles — default off (show all); click to enable (restrict to enabled lists)
  container.querySelectorAll('.filter-bubble').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.listSlug;
      if (!filterState.lists) filterState.lists = {};
      if (filterState.lists[slug] === true) {
        delete filterState.lists[slug]; // deactivate
        btn.classList.remove('active');
      } else {
        filterState.lists[slug] = true; // activate
        btn.classList.add('active');
      }
      saveFilterState();
      const toggleBtn = container.querySelector('#filterToggleBtn');
      if (toggleBtn) toggleBtn.classList.toggle('has-filters', !isDefaultFilterState(filterState));
      runActiveSearchPipeline();
    });
  });
}


async function runSearchFilterPipeline() {
  if (activeView.type !== 'explore') return;

  const pinnedSlugs = new Set();

  // Collect all queries: saved searches + current draft
  const allQueries = [...savedSearches];
  if (currentSearchInput.trim()) allQueries.push(currentSearchInput.trim());

  let results;
  let showAllHistory = false;

  if (allQueries.length === 0 || allQueries.every(q => !q.trim())) {
    // No search queries → show all history
    showAllHistory = true;
    results = processInteractionsForDisplay(
      historyAllEntries.filter(item => item.url && !pinnedSlugs.has(generateSlugFromUrl(item.url)))
    ).map(item => ({ ...item, relevance: 0 }));
    await enrichFromEntityStorage(results);
  } else {
    // OR across queries: item matches if ANY query matches (AND within each query)
    const matchedUrls = new Set();
    for (const query of allQueries) {
      if (!query.trim()) continue;
      const words = parseSearchWords(query);
      for (const item of historyAllEntries) {
        if (!item.url || pinnedSlugs.has(generateSlugFromUrl(item.url))) continue;
        if (wordsMatchItem(words, item)) {
          matchedUrls.add(item.url);
        }
      }
    }

    const filteredEntries = historyAllEntries.filter(item =>
      item.url && matchedUrls.has(item.url)
    );
    results = processInteractionsForDisplay(filteredEntries, { globalDedup: true }).map(item => ({ ...item, relevance: 0 }));
    await enrichFromEntityStorage(results);
  }

  // Enrich with page entity data when filters need it, then apply filters
  if (!isDefaultFilterState(filterState)) {
    await enrichForFilters(results);
  }
  results = await applyFilters(results);

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
  vs._headerHtml = '';
  vs.updateData(sorted, (r) =>
    resultRowHtml(r.user_title || r.title, r.url, {
      attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      notes: r.notes, timestamps: r.timestamps, context: 'related',
      childIds: r.childIds, likes: r.likes,
    })
  );

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
      const fpEntity = await readCacheable('list:' + listId);
      pins = fpEntity?.pins || [];
      allListPins[listId] = pins;
    }

    let html = '';

    // Pinned pages section
    html += '<div class="focus-section"><div class="focus-section-label">Pinned</div><div class="focus-section-cards">';
    if (pins.length === 0) {
      html += '<div class="focus-empty">No pinned pages</div>';
    } else {
      const maxAtt = 0.1;
      const { pinsResolved } = await resolvePinsForDisplay(pins);
      html += pinsResolved.map(r => {
        const title = r.user_title || r.title || '<unknown>';
        return resultRowHtml(title, r.url, {
          deletable: false, attScore: 0, maxAtt, timestamps: [r.pinnedAt || Date.now()], context: 'global', deletable: false, childIds: r.childIds
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
  const focusOpts = { deletable: false, maxAtt, context: 'global', deletable: false };

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
      refreshPins();
      return;
    }
  });

  content.addEventListener('click', (e) => {
    // Skip if click was on a button or handled by result delegation
    if (e.target.closest('.result-expand') || e.target.closest('.result-delete') ||
        e.target.closest('.result-pin') ||
        e.target.closest('.result-focus') || e.target.closest('.card-actions')) return;

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
// --- Sidebar resize ---
function initSidebarResize() {
  const handle = document.getElementById('sidebarResizeHandle');
  if (!handle) return;
  const sidebar = document.querySelector('.sidebar');
  let startX, startWidth;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add('active');
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      sidebar.style.width = Math.max(180, Math.min(500, startWidth + ev.clientX - startX)) + 'px';
      sidebar.style.minWidth = sidebar.style.width;
    };
    const onUp = () => {
      handle.classList.remove('active');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      chrome.storage.session.set({ sidebarWidth: sidebar.offsetWidth }).catch(() => {});
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

async function restoreSidebarWidth() {
  try {
    const { sidebarWidth } = await chrome.storage.session.get(['sidebarWidth']);
    if (sidebarWidth) {
      const sidebar = document.querySelector('.sidebar');
      sidebar.style.width = sidebarWidth + 'px';
      sidebar.style.minWidth = sidebarWidth + 'px';
    }
  } catch (e) { /* ignore */ }
}

async function initialize() {
  const _t0 = performance.now();
  const _timer = (label) => console.debug(`[init-timer] ${label}: ${(performance.now() - _t0).toFixed(0)}ms`);

  // Load settings from filesystem
  relatedPagesLimit = await loadSettingsValue('relatedPagesLimit', 50);
  document.getElementById('relatedPagesLimit').value = relatedPagesLimit;
  historyFileBatch = await loadSettingsValue('historyFileBatch', 10);
  document.getElementById('historyFileBatch').value = historyFileBatch;
  document.getElementById('captureSnapshotVideo').checked = await loadSettingsValue('captureSnapshotVideo', false);
  _timer('loadSettings');

  // Initialize chart tooltips
  initCharts();
  _timer('initCharts');

  // Load fold state and restore sidebar width before rendering lists
  await loadFoldState();
  restoreSidebarWidth();
  initSidebarResize();
  _timer('sidebarInit');

  // Render sidebar concurrently with heavy data (don't block on sidebar)
  renderLists().catch(err => showFatalError(err.message));
  renderBlacklist();
  renderTrimRules();
  _timer('renderSidebar (fire-and-forget)');

  // Load metadata (history is demand-loaded in showCategory, pins loaded per-list)
  await initHistoryFiles();
  _timer('parallel metadata load');
  updateRecycleBinBadge();
  showExplore();
}

initialize().catch(err => showFatalError(err.message));
