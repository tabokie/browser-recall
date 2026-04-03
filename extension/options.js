// Options page for Portal extension
// Bookmark-manager style UI with sidebar navigation, search, and settings modal
import { FileSystemStorage } from './filesystem-storage.js';
import init, { HistoryEntry, SearchEngine, searchBatch, searchNotes, searchSnapshots } from './pkg/portal_extension.js';
import { mergeBufferIntoHistory, getBufferContentMap, buildHistoryForEngine, extractHistoryBuffer } from './search-helpers.js';
import { generateSlugFromUrl, generateSlugFromTitle, loadSettingsValue, saveSettingsValue, readCacheable, sendAction, escapeHtml, BODY_WORD_LIMIT } from './utils.js';
import { attentionStrength, attentionColor, aggregateAttention } from './attention-utils.js';
import { initCharts, renderTimeChart, renderTimeChartInto, bindChartBarClick, syncChartHighlights, applyDateFilter } from './time-chart.js';
import { VirtualScroller } from './virtual-scroller.js';
import { entityTypeLabel } from './entity-types.js';
import { requestDeviceCode, pollForToken, fetchGitHubUser, getGitHubRevokeUrl } from './github-oauth.js';
// parseBookmarkHtml imported dynamically inside the block below
const fsStorage = new FileSystemStorage();

// ─── Utility ─────────────────────────────────────────────────────────

function autoResizeTextarea(textarea) {
  textarea.style.height = '0';
  textarea.style.height = textarea.scrollHeight + 'px';
}

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
function showErrorBubble(message, { suffix = ' \u2014 please reload the extension.' } = {}) {
  let bubble = document.getElementById('errorBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'errorBubble';
    bubble.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(180,30,30,0.92);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;';
    document.body.appendChild(bubble);
  }
  bubble.textContent = message + suffix;
  bubble.style.opacity = '1';
  clearTimeout(_errorBubbleTimer);
  _errorBubbleTimer = setTimeout(() => { bubble.style.opacity = '0'; }, 4000);
}

let _blockedBubbleTimer = null;
function showBlockedBubble(message) {
  let bubble = document.getElementById('blockedBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'blockedBubble';
    bubble.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(120,120,120,0.88);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;';
    document.body.appendChild(bubble);
  }
  bubble.textContent = '\u2715 ' + message;
  bubble.style.opacity = '1';
  clearTimeout(_blockedBubbleTimer);
  _blockedBubbleTimer = setTimeout(() => { bubble.style.opacity = '0'; }, 2000);
}

let _infoBubbleTimer = null;
function showInfoBubble(message) {
  let bubble = document.getElementById('infoBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'infoBubble';
    bubble.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:var(--bg-surface-solid, rgba(255,255,255,0.75));color:var(--text-secondary, #5E4D3E);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;border:1px solid var(--border-glass, rgba(255,255,255,0.55));backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 2px 8px rgba(0,0,0,0.08);opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;';
    document.body.appendChild(bubble);
  }
  bubble.textContent = message;
  bubble.style.opacity = '1';
  clearTimeout(_infoBubbleTimer);
  _infoBubbleTimer = setTimeout(() => { bubble.style.opacity = '0'; }, 3000);
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
let historyByUrl = new Map();      // url → history entry (deduped, newest wins)
let historyAllEntries = [];        // all loaded entries (not deduped), for date-boundary rendering
let historyLoading = false;        // guard against concurrent loads
let historyFileSizes = {};         // filename → total byte size (for chart estimation)
const DEFAULT_AVG_ENTRY_SIZE = 200;
let avgEntrySize = DEFAULT_AVG_ENTRY_SIZE; // calibrated from loaded batches
let historyBatchRawCount = 0;      // total raw entries from loaded JSONL files
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
function computeFieldRanges(entries) {
  const byUrl = new Map();
  for (const i of entries) {
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
/**
 * Fetch a URL and extract body text (first BODY_WORD_LIMIT words).
 * Returns '' on timeout, network error, or non-HTML content.
 */
async function fetchPageBody(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok || !(resp.headers.get('content-type') || '').includes('text/html')) return '';
    const html = await resp.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+/).slice(0, BODY_WORD_LIMIT).join(' ');
  } catch { return ''; }
}

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

// --- Progressive search ---
let searchGeneration = 0;      // generation counter — stale phase callbacks are discarded
let searchResults = [];         // master result array, mutated by mergeSearchResults
let searchPendingPhases = 0;    // count of in-flight phases — spinner shown while > 0

// Run a limited-concurrency pool of async tasks, calling onResult after each completes.
async function runPool(tasks, concurrency, onResult) {
  let idx = 0;
  async function next() {
    while (idx < tasks.length) {
      const i = idx++;
      const result = await tasks[i]();
      await onResult(result);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(next());
  }
  await Promise.all(workers);
}

// Merge new results into searchResults. Dedup by URL, take max score, track sources.
function mergeSearchResults(newResults, source, gen) {
  if (gen !== searchGeneration) return; // stale generation — discard
  for (const r of newResults) {
    if (!r.url) continue;
    const idx = searchResults.findIndex(e => e.url === r.url);
    if (idx >= 0) {
      const existing = searchResults[idx];
      if ((r.score || 0) > (existing.score || 0)) existing.score = r.score;
      if (!existing.matchSources) existing.matchSources = new Set();
      existing.matchSources.add(source);
    } else {
      const entry = {
        url: r.url,
        title: r.title || '',
        user_title: r.user_title,
        slug: r.slug || generateSlugFromUrl(r.url),
        timestamp: r.timestamp || Date.now(),
        score: r.score || 0,
        attScore: r.attScore || 0,
        attDetail: r.attDetail || null,
        notes: r.notes || [],
        timestamps: r.timestamps || [r.timestamp || Date.now()],
        latestTs: r.timestamp || Date.now(),
        matchSources: new Set([source]),
      };
      searchResults.push(entry);
    }
  }
}

// Enrich new entries and render the current searchResults to the virtual scroller.
async function renderProgressiveResults(gen) {
  if (gen !== searchGeneration) return;
  // Enrich all entries that haven't been enriched yet
  const unenriched = searchResults.filter(r => !r._enriched);
  if (unenriched.length > 0) {
    await enrichFromEntityStorage(unenriched);
    for (const r of unenriched) r._enriched = true;
  }
  // Apply filters
  let results = searchResults;
  if (!isDefaultFilterState(filterState)) {
    const notFilterEnriched = results.filter(r => !r._filterEnriched);
    if (notFilterEnriched.length > 0) {
      await enrichForFilters(notFilterEnriched);
      for (const r of notFilterEnriched) r._filterEnriched = true;
    }
    results = await applyFilters([...results]);
  }

  const relatedContainer = document.getElementById('relatedResults');
  // Show "No results" when all phases are done and nothing matched
  if (results.length === 0 && searchPendingPhases <= 0) {
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
      childIds: r.childIds, parentIds: r.parentIds, likes: r.likes,
      matchSources: r.matchSources,
    })
  );
  // Update time chart
  const chartData = sorted.map(r => ({ url: r.url, timestamp: r.timestamps?.[0] || Date.now(), attention: '' }));
  renderTimeChartInto(
    document.getElementById('relatedChart'),
    document.getElementById('relatedChartBars'),
    chartData,
    'Explore results'
  );
  bindChartBarClick(document.getElementById('relatedChart'), document.getElementById('relatedResults'));
}

function showSearchSpinner() {
  const el = document.getElementById('contentSearchSpinner');
  if (el) el.style.display = '';
}
function hideSearchSpinner() {
  const el = document.getElementById('contentSearchSpinner');
  if (el) el.style.display = 'none';
}
function phaseComplete(gen) {
  if (gen !== searchGeneration) return;
  searchPendingPhases--;
  if (searchPendingPhases <= 0) hideSearchSpinner();
}

// Phase 1: WASM JSONL streaming search with limited concurrency.
// History files are in data/logs/{device}/ subdirectories. We iterate device dirs
// and pass each device subdir handle + its filenames to WASM searchBatch.
async function runPhase1(query, gen) {
  try {
    await initWasm();
    await fsStorage.loadDirectoryHandle();
    const rootDir = fsStorage.directoryHandle;
    if (!rootDir) return;
    const logsDir = await rootDir.getDirectoryHandle('data').then(d => d.getDirectoryHandle('logs'));
    const pagesDir = await rootDir.getDirectoryHandle('pages');

    // Dirty data: search logBuffer entries in JS
    const { logBuffer = [] } = await chrome.storage.local.get(['logBuffer']);
    const historyBuffer = extractHistoryBuffer(logBuffer);
    bufferContentMap = getBufferContentMap(historyBuffer);
    if (historyBuffer.length > 0) {
      const engine = new SearchEngine();
      buildHistoryForEngine(HistoryEntry, engine, historyBuffer, bufferContentMap);
      const bufferResults = await engine.search(query, 0);
      mergeSearchResults(bufferResults, 'history', gen);
      await renderProgressiveResults(gen);
    }

    // Collect device subdirectories and their .jsonl files
    const deviceTasks = []; // { dir: FileSystemDirectoryHandle, files: string[] }
    for await (const entry of logsDir.values()) {
      if (entry.kind !== 'directory') continue;
      const deviceDir = await logsDir.getDirectoryHandle(entry.name);
      const files = [];
      for await (const f of deviceDir.values()) {
        if (f.kind === 'file' && f.name.endsWith('.jsonl')) files.push(f.name);
      }
      if (files.length > 0) {
        files.sort().reverse(); // newest-first
        deviceTasks.push({ dir: deviceDir, files });
      }
    }

    // Chunk across all device/file pairs and search with limited concurrency
    const CHUNK = 10;
    const tasks = [];
    for (const { dir, files } of deviceTasks) {
      for (let i = 0; i < files.length; i += CHUNK) {
        const chunk = files.slice(i, i + CHUNK);
        tasks.push(() => searchBatch(dir, pagesDir, query, chunk));
      }
    }
    await runPool(tasks, 3, (results) => {
      if (gen !== searchGeneration) return;
      const formatted = results.map(r => ({
        url: r.url, title: r.title, slug: generateSlugFromUrl(r.url),
        timestamp: r.timestamp, score: r.score || 0,
        intent: r.intent, attention: r.attention,
        timestamps: [r.timestamp],
      }));
      mergeSearchResults(formatted, 'history', gen);
      renderProgressiveResults(gen);
    });
  } catch (e) {
    console.warn('[Phase1] WASM JSONL search failed:', e.message);
  } finally {
    phaseComplete(gen);
  }
}

// Phase 2a: WASM note search.
async function runPhase2a(query, gen) {
  try {
    await initWasm();
    await fsStorage.loadDirectoryHandle();
    const rootDir = fsStorage.directoryHandle;
    if (!rootDir) return;
    const notesDir = await rootDir.getDirectoryHandle('data').then(d => d.getDirectoryHandle('notes'));
    const matches = await searchNotes(notesDir, query);
    if (gen !== searchGeneration) return;
    // Convert note matches to result entries — need page metadata from slug
    const noteResults = [];
    for (const m of matches) {
      const slug = generateSlugFromUrl(m.url);
      noteResults.push({
        url: m.url, title: '', slug, timestamp: Date.now(),
        score: 1.0, timestamps: [Date.now()],
      });
    }
    mergeSearchResults(noteResults, 'note', gen);
    await renderProgressiveResults(gen);
  } catch (e) {
    console.warn('[Phase2a] Note search failed:', e.message);
  } finally {
    phaseComplete(gen);
  }
}

// Phase 2b: WASM snapshot search with limited concurrency.
async function runPhase2b(query, gen) {
  try {
    await initWasm();
    await fsStorage.loadDirectoryHandle();
    const rootDir = fsStorage.directoryHandle;
    if (!rootDir) return;
    const snapshotsDir = await rootDir.getDirectoryHandle('data').then(d => d.getDirectoryHandle('snapshots'));

    // List all .md files, group by slug, pick latest per slug
    const allFiles = [];
    for await (const entry of snapshotsDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.md')) {
        allFiles.push(entry.name);
      }
    }
    const latestBySlug = new Map(); // slug → filename
    const re = /^(.+)-(\d{13})\.md$/;
    for (const name of allFiles) {
      const m = name.match(re);
      if (!m) continue;
      const slug = m[1];
      const ts = parseInt(m[2], 10);
      const existing = latestBySlug.get(slug);
      if (!existing || ts > existing.ts) {
        latestBySlug.set(slug, { name, ts });
      }
    }
    const fileNames = Array.from(latestBySlug.values()).map(v => v.name);

    // Chunk and search with limited concurrency
    const CHUNK = 10;
    const chunks = [];
    for (let i = 0; i < fileNames.length; i += CHUNK) {
      chunks.push(fileNames.slice(i, i + CHUNK));
    }
    const tasks = chunks.map(chunk => () => searchSnapshots(snapshotsDir, query, chunk));
    await runPool(tasks, 2, async (matches) => {
      if (gen !== searchGeneration) return;
      // Load page entities to get URLs for matched slugs
      const slugs = matches.map(m => m.slug);
      const pages = await Promise.all(slugs.map(s => readCacheable('page:' + s)));
      const snapshotResults = [];
      for (let i = 0; i < matches.length; i++) {
        const page = pages[i];
        if (!page || !page.url) continue;
        snapshotResults.push({
          url: page.url, title: page.title || '', slug: matches[i].slug,
          timestamp: Date.now(), score: 0.5, timestamps: [Date.now()],
        });
      }
      mergeSearchResults(snapshotResults, 'snapshot', gen);
      await renderProgressiveResults(gen);
    });
  } catch (e) {
    console.warn('[Phase2b] Snapshot search failed:', e.message);
  } finally {
    phaseComplete(gen);
  }
}

// Four-phase progressive search orchestrator.
// Phase 0: instant in-memory matching. Phase 1: WASM JSONL streaming.
// Phase 2a: WASM notes. Phase 2b: WASM snapshots streaming.
async function runProgressiveSearch(allQueries) {
  const gen = ++searchGeneration;
  searchResults = [];
  const query = allQueries.join(' ');

  // Phase 0: instant in-memory matching (existing wordsMatchItem logic)
  const matchedUrls = new Set();
  for (const q of allQueries) {
    if (!q.trim()) continue;
    const words = parseSearchWords(q);
    for (const item of historyAllEntries) {
      if (!item.url) continue;
      if (wordsMatchItem(words, item)) matchedUrls.add(item.url);
    }
  }
  const phase0Entries = historyAllEntries.filter(item => item.url && matchedUrls.has(item.url));
  const phase0Results = processHistoryForDisplay(phase0Entries, { globalDedup: true })
    .map(item => ({ ...item, score: 0, matchSources: new Set(['title']) }));
  mergeSearchResults(phase0Results, 'title', gen);
  await renderProgressiveResults(gen);

  // Fire Phase 1, 2a, 2b concurrently (with per-type concurrency limits)
  searchPendingPhases = 3;
  showSearchSpinner();
  runPhase1(query, gen);
  runPhase2a(query, gen);
  runPhase2b(query, gen);
}


// --- Demand-loaded history ---

async function initHistoryFiles() {
  if (historyFiles.length > 0) return;

  // Always get file list from offscreen (no session cache for file list)
  try {
    const resp = await sendAction({ action: 'listHistoryFiles', includeSizes: true });
    historyFiles = resp.files;
    historyFileSizes = resp.sizes || {};
  } catch (error) {
    console.log('Filesystem not available:', error.message);
  }

  // Merge today's history — session cache has disk + undrained entries via addLog
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayEntries = await readCacheable('log:' + todayStr) || [];
  const historyBuffer = todayEntries.filter(e => (e.action === 'visit_page' || e.action === 'leave_page' || !e.action) && e.url);
  for (const entry of historyBuffer) {
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
  bufferContentMap = getBufferContentMap(historyBuffer);
}

async function loadHistoryBatch() {
  if (historyLoading || historyLoadedCount >= historyFiles.length
      || historyLoadedCount >= HISTORY_MAX_FILES) return [];
  historyLoading = true;
  const batch = historyFiles.slice(historyLoadedCount, historyLoadedCount + historyFileBatch);
  try {
    const t0 = performance.now();
    const resp = await sendAction({ action: 'loadHistoryBatch', files: batch });
    const batchEntries = resp.entries;
    const newItems = [];
    // Entries within a day file arrive oldest→newest. This isn't a full replay,
    // but we simulate replay semantics: newer values always win, and older
    // values are only kept when the newer entry omits the field (the "omit
    // unchanged fields" optimisation in background.js means later entries
    // often lack a title when it hasn't changed since the previous write).
    for (const item of batchEntries) {
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
    console.debug(`[I/O] loadHistoryBatch: ${batch.length} files, ${batchEntries.length} items, ${newItems.length} new in ${(performance.now() - t0).toFixed(1)}ms`);
    historyLoadedCount += batch.length;
    // Calibrate avg entry size from loaded file data
    historyBatchRawCount += batchEntries.length;
    const loadedSize = historyFiles.slice(0, historyLoadedCount)
      .reduce((sum, f) => sum + (historyFileSizes[f] || 0), 0);
    if (loadedSize > 0 && historyBatchRawCount > 0) {
      avgEntrySize = loadedSize / historyBatchRawCount;
    }
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
  historyFileSizes = {};
  avgEntrySize = DEFAULT_AVG_ENTRY_SIZE;
  historyBatchRawCount = 0;
  cachedFieldRanges = null;
  allListPins = {};

  bufferContentMap = {};
  searchGeneration++;    // invalidate any in-flight progressive search
  searchResults = [];
  searchPendingPhases = 0;
  hideSearchSpinner();
}

// Estimate visit counts for unloaded JSONL files from file sizes.
// Returns Map<dateStr, estimatedCount> for dates not yet loaded.
function getEstimatedByDay() {
  const estimated = new Map();
  const loadedSet = new Set(historyFiles.slice(0, historyLoadedCount));
  for (const filename of historyFiles) {
    if (loadedSet.has(filename)) continue;
    const dateStr = filename.replace('.jsonl', '');
    const size = historyFileSizes[filename] || 0;
    if (size > 0) {
      estimated.set(dateStr, Math.max(1, Math.round(size / avgEntrySize)));
    }
  }
  return estimated;
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
    return { ...p, url, title, user_title: ref?.user_title || null, isNote: ref?.isNote || false, childIds: ref?.childIds || [], parentIds: ref?.parentIds || [] };
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
  document.getElementById('rulesSection').style.display = 'none';
  cancelRuleEdit();
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
  const entries = orphaned?.entries || [];
  const itemsEl = document.getElementById('recycleBinItems');
  const emptyEl = document.getElementById('recycleBinEmpty');
  const headerEl = document.querySelector('.recycle-bin-header');
  itemsEl.innerHTML = '';

  if (entries.length === 0) {
    emptyEl.style.display = '';
    headerEl.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  headerEl.style.display = '';

  for (const { key } of entries) {
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
  const count = orphaned?.entries?.length || 0;
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

function matchesExactWithBoundary(text, q) {
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function wordsMatchItem(words, item) {
  if (words.length === 0) return true;
  return words.every(({ q, exact }) => {
    const fields = [item.user_title, item.title, item.url];
    return fields.some(f => {
      if (!f) return false;
      if (exact) return matchesExactWithBoundary(f, q);
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
      case 'totalVisits':
        av = a.visitCount || (a.timestamps ? a.timestamps.length : 0);
        bv = b.visitCount || (b.timestamps ? b.timestamps.length : 0);
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
function filterByCategory(entries, category) {
  const now = Date.now();
  switch (category) {
    case 'today': {
      const startOfDay = new Date().setHours(0, 0, 0, 0);
      return entries.filter(i => i.timestamp >= startOfDay);
    }
    case 'week': {
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      return entries.filter(i => i.timestamp >= weekAgo);
    }
    case 'highlighted':
      return entries.filter(i => (i.likes > 0));
    case 'all':
    default:
      return entries;
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
  const allEntries = [...historyAllEntries];
  allEntries.sort((a, b) => b.timestamp - a.timestamp);
  const filtered = filterByCategory(allEntries, category);
  const estimatedByDay = category === 'all' ? getEstimatedByDay() : undefined;
  renderTimeChart(filtered, estimatedByDay);
  await displayHistoryRows(filtered);

  // Wire up demand-loading on scroll
  const vs = getOrCreateGlobalScroller();
  vs.onLoadMore = async () => {
    const newItems = await loadHistoryBatch();
    if (newItems.length > 0) {
      const newFiltered = filterByCategory(newItems, activeView.value);
      if (newFiltered.length > 0) {
        const sort = currentSortState.column ? currentSortState : { column: 'lastVisit', direction: 'desc' };
        const newEntries = processHistoryForDisplay(newFiltered);
        await enrichFromEntityStorage(newEntries);
        vs.appendData(applySortOrder(newEntries, sort));
      }
      // Re-render chart with all loaded history + updated estimates
      const allLoaded = [...historyAllEntries];
      const allFiltered = filterByCategory(allLoaded, activeView.value);
      const updatedEstimates = activeView.value === 'all' ? getEstimatedByDay() : undefined;
      renderTimeChart(allFiltered, updatedEstimates);
    }
  };
}

// --- Query builder: Predicate matchers ---
function parseKeywordQuery(value) {
  const m = value.match(/^"(.+)"$/);
  if (m) return { q: m[1], exact: true };
  return { q: value, exact: false };
}

function textMatches(text, q, exact) {
  if (!text) return false;
  if (exact) return matchesExactWithBoundary(text, q);
  return text.toLowerCase().includes(q.toLowerCase());
}

function matchKeyword(item, field, value) {
  if (!value) return false;
  const { q, exact } = parseKeywordQuery(value);
  const fields = normalizeFieldToArray(field);
  if (fields.includes('title') && (textMatches(item.user_title, q, exact) || textMatches(item.title, q, exact))) return true;
  if (fields.includes('url') && textMatches(item.url, q, exact)) return true;
  // 'captures' field search is handled by Phase 2b (WASM snapshot search) in progressive search
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
    pinSource: pin?.source || r.pinSource || null,
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
      await renderListPinView(enriched, listId);
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

    await loadFilterState();

    // Always fetch pins from entity storage
    const listEntity = await readCacheable('list:' + listId);
    allListPins[listId] = listEntity?.pins || [];
    const pins = allListPins[listId];

    // Render rules section
    renderRulesSection(listId, listEntity?.rules || []);

    if (pins.length === 0) {
      listPinsData = [];
      listPinsListId = listId;
      await renderSearchPanel();
      document.getElementById('relatedResults').innerHTML = '<div class="no-results">No pinned pages</div>';
      document.getElementById('relatedChart').classList.remove('visible');
    } else {
      const { pinsResolved, pageSnap } = await resolvePinsForDisplay(pins);
      const enriched = pinsResolved.map(r => enrichPinResult(r, pins, pageSnap));
      await renderListPinView(enriched, listId);
    }
  } catch (error) {
    console.error('List load error:', error);
    document.getElementById('relatedResults').innerHTML = `<div class="no-results">${escapeHtml('Error: ' + error.message)}</div>`;
  }
}


// ─── Rules section ──────────────────────────────────────────────────

function ruleDescription(rule) {
  const c = rule.config || {};
  if (rule.type === 'keyword') {
    const fields = c.fields || ['title', 'url'];
    return `${c.pattern || ''} (${fields.join(', ')})`;
  } else if (rule.type === 'smart') {
    return c.description || '(custom function)';
  }
  return rule.type || 'unknown';
}

function renderRulesSection(listId, rules) {
  const section = document.getElementById('rulesSection');
  const countBadge = document.getElementById('rulesCount');
  const runBtn = document.getElementById('rulesRunBtn');

  // Only show for non-system lists
  if (listId.startsWith('system/')) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  if (rules.length > 0) {
    countBadge.textContent = rules.length;
    countBadge.style.display = '';
    runBtn.style.display = '';
  } else {
    countBadge.style.display = 'none';
    runBtn.style.display = 'none';
  }

  renderRulesList(listId, rules);
}

function renderRulesList(listId, rules) {
  const container = document.getElementById('rulesList');
  if (rules.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-style:italic;padding:2px 0">No rules</div>';
    return;
  }
  const typeLabel = (t) => t === 'smart' ? 'function' : t;
  container.innerHTML = rules.map(rule => {
    const fnBlock = rule.type === 'smart' && rule.config?.fnSource
      ? `<pre class="rule-fn-source">${escapeHtml(rule.config.fnSource)}</pre>` : '';
    return `<div class="rule-entry${fnBlock ? ' has-fn' : ''}" data-rule-id="${escapeHtml(rule.id)}">
      <div class="rule-header">
        <span class="rule-type-badge rule-type-${escapeHtml(rule.type)}">${escapeHtml(typeLabel(rule.type))}</span>
        <span class="rule-desc">${escapeHtml(ruleDescription(rule))}</span>
        <button class="rule-action-btn rule-edit" title="Edit">&#x270E;</button>
        <button class="rule-action-btn rule-remove" title="Remove">&times;</button>
      </div>
      ${fnBlock}
    </div>`;
  }).join('');

  container.querySelectorAll('.rule-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const entry = btn.closest('.rule-entry');
      const ruleId = entry.dataset.ruleId;
      const rule = rules.find(r => r.id === ruleId);
      if (rule) startRuleEdit(listId, ruleId, rule);
    });
  });

  container.querySelectorAll('.rule-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const entry = btn.closest('.rule-entry');
      const ruleId = entry.dataset.ruleId;
      try {
        await sendAction({ action: 'removeRule', listId, ruleId });
      } catch (err) {
        showErrorBubble('Failed to remove rule: ' + err.message);
      }
    });
  });
}

async function refreshRulesForActiveList() {
  if (activeView.type !== 'list') return;
  const listId = activeView.id;
  const listEntity = await readCacheable('list:' + listId);
  renderRulesSection(listId, listEntity?.rules || []);
}

// ─── Inline rule editing state ───
let previewResults = [];
let previewPinsResults = [];

function renderPreviewSection(results, listEl, countEl) {
  const matches = results.filter(r => r.score >= 0.5);
  countEl.textContent = `${matches.length} matches (${results.length} checked)`;
  if (matches.length === 0) {
    listEl.innerHTML = '<div class="rules-preview-empty">No matches</div>';
    return;
  }
  listEl.innerHTML = matches.map(r =>
    `<div class="rules-preview-item">
      <span class="rules-preview-title">${escapeHtml(r.title || r.url)}</span>
    </div>`
  ).join('');
}

function rerenderPreview() {
  if (previewResults.length > 0) {
    renderPreviewSection(previewResults,
      document.getElementById('rulesPreviewList'),
      document.getElementById('rulesPreviewCount'));
  }
  if (previewPinsResults.length > 0) {
    renderPreviewSection(previewPinsResults,
      document.getElementById('rulesPinsPreviewList'),
      document.getElementById('rulesPinsPreviewCount'));
  }
}

/** Build rule object from the currently active edit row. Returns { rule } or { error }. */
function buildRuleFromEditRow() {
  const editRow = document.querySelector('.rule-entry.rule-editing');
  if (!editRow) return { error: 'No edit row' };
  const activeType = editRow.querySelector('.rule-type-option.active')?.dataset.type || 'keyword';
  const inputVal = editRow.querySelector('.rule-edit-input').value.trim();
  if (activeType === 'keyword') {
    if (!inputVal) return { error: 'Pattern is required' };
    return { rule: { type: 'keyword', config: { pattern: inputVal, fields: ['title', 'url'] } } };
  } else if (activeType === 'smart') {
    const fnSource = editRow.querySelector('.rule-smart-fn-input')?.value.trim() || '';
    if (!fnSource) return { error: 'Function body is required' };
    return { rule: { type: 'smart', config: { description: inputVal || '(custom)', fnSource } } };
  }
  return { error: 'Unknown rule type' };
}

function cancelRuleEdit() {
  previewResults = [];
  previewPinsResults = [];
  document.getElementById('rulesPreview').style.display = 'none';
  document.getElementById('rulesPinsPreview').style.display = 'none';
  document.getElementById('rulesFormError').style.display = 'none';
  refreshRulesForActiveList();
}

function buildEditRowHTML(type, config) {
  const isKeyword = (type || 'keyword') === 'keyword';
  const inputValue = isKeyword ? (config?.pattern || '') : (config?.description || '');
  const inputPlaceholder = isKeyword ? 'keyword or /regex/' : 'description';
  const fnSource = config?.fnSource || '';
  return `<div class="rule-entry rule-editing">
    <div class="rule-edit-main">
      <div class="rule-type-toggle">
        <span class="rule-type-option ${isKeyword ? 'active' : ''}" data-type="keyword">Keyword</span>
        <span class="rule-type-option ${!isKeyword ? 'active' : ''}" data-type="smart">Function</span>
      </div>
      <input class="rule-edit-input" type="text" value="${escapeHtml(inputValue)}" placeholder="${inputPlaceholder}">
      <button class="rule-preview-btn">Preview</button>
      <button class="rule-cancel-btn" title="Cancel">&times;</button>
      <button class="rule-save-btn" title="Save (Enter)">OK</button>
    </div>
    <textarea class="rule-smart-fn-input" rows="3" placeholder="// page = { title, url, body }\nreturn page.title.length > 50 ? 1 : 0;" style="${isKeyword ? 'display:none' : ''}">${escapeHtml(fnSource)}</textarea>
  </div>`;
}

function attachEditRowHandlers(editRow, listId, existingRuleId) {
  // Type toggle
  editRow.querySelectorAll('.rule-type-option').forEach(opt => {
    opt.addEventListener('click', () => {
      editRow.querySelectorAll('.rule-type-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      const type = opt.dataset.type;
      const input = editRow.querySelector('.rule-edit-input');
      input.placeholder = type === 'keyword' ? 'keyword or /regex/' : 'description';
      editRow.querySelector('.rule-smart-fn-input').style.display = type === 'smart' ? '' : 'none';
    });
  });

  // Save handler (shared by button click and Enter key)
  async function saveCurrentRule() {
    const errorEl = document.getElementById('rulesFormError');
    errorEl.style.display = 'none';
    const built = buildRuleFromEditRow();
    if (built.error) {
      errorEl.textContent = built.error;
      errorEl.style.display = '';
      return;
    }
    try {
      if (existingRuleId) {
        await sendAction({ action: 'removeRule', listId, ruleId: existingRuleId });
      }
      await sendAction({ action: 'addRule', listId, rule: built.rule });
      cancelRuleEdit();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = '';
    }
  }

  editRow.querySelector('.rule-save-btn').addEventListener('click', saveCurrentRule);

  // Cancel
  editRow.querySelector('.rule-cancel-btn').addEventListener('click', () => cancelRuleEdit());

  // Preview
  editRow.querySelector('.rule-preview-btn').addEventListener('click', () => runPreview());

  // Enter key saves
  editRow.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveCurrentRule();
    }
  });

  // Focus input
  editRow.querySelector('.rule-edit-input').focus();
}

function startRuleEdit(listId, ruleId, rule) {
  // Close any existing edit row (synchronous — no async refresh)
  const existing = document.querySelector('.rule-entry.rule-editing');
  if (existing) existing.remove();
  previewResults = [];
  previewPinsResults = [];
  document.getElementById('rulesPreview').style.display = 'none';
  document.getElementById('rulesPinsPreview').style.display = 'none';
  document.getElementById('rulesFormError').style.display = 'none';

  const container = document.getElementById('rulesList');
  if (ruleId) {
    // Replace existing display row with edit row
    const displayRow = container.querySelector(`.rule-entry[data-rule-id="${ruleId}"]`);
    if (displayRow) {
      displayRow.insertAdjacentHTML('afterend', buildEditRowHTML(rule.type, rule.config));
      displayRow.remove();
    }
  } else {
    // Append new edit row
    container.insertAdjacentHTML('beforeend', buildEditRowHTML('keyword', {}));
  }
  const editRow = container.querySelector('.rule-entry.rule-editing');
  attachEditRowHandlers(editRow, listId, ruleId);
}

async function runPreview() {
  const MAX_CHECKED = 100;
  const MAX_MATCHES = 20;
  const BATCH_SIZE = 20;

  const errorEl = document.getElementById('rulesFormError');
  const previewEl = document.getElementById('rulesPreview');
  const previewListEl = document.getElementById('rulesPreviewList');
  const previewCountEl = document.getElementById('rulesPreviewCount');
  const pinsPreviewEl = document.getElementById('rulesPinsPreview');
  const pinsPreviewListEl = document.getElementById('rulesPinsPreviewList');
  errorEl.style.display = 'none';
  previewEl.style.display = 'none';
  previewListEl.innerHTML = '';
  pinsPreviewEl.style.display = 'none';
  pinsPreviewListEl.innerHTML = '';

  const built = buildRuleFromEditRow();
  if (built.error) {
    errorEl.textContent = built.error;
    errorEl.style.display = '';
    return;
  }

  const previewBtn = document.querySelector('.rule-preview-btn');
  if (previewBtn) { previewBtn.disabled = true; previewBtn.textContent = 'Running…'; }
  previewEl.style.display = '';

  previewResults = [];
  previewPinsResults = [];
  let matchCount = 0;
  let checked = 0;
  const seenUrls = new Set();

  try {
    const today = new Date();
    for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
      if (checked >= MAX_CHECKED || matchCount >= MAX_MATCHES) break;
      const d = new Date(today);
      d.setDate(d.getDate() - dayOffset);
      const dateKey = d.toISOString().slice(0, 10);
      const dayEntries = await readCacheable('log:' + dateKey) || [];
      const visits = dayEntries
        .filter(e => e.action === 'visit_page' && e.url && e.title && !seenUrls.has(e.url))
        .reverse();
      const uniqueVisits = [];
      for (const v of visits) {
        if (!seenUrls.has(v.url)) {
          seenUrls.add(v.url);
          uniqueVisits.push(v);
        }
      }
      if (uniqueVisits.length === 0) continue;

      for (let i = 0; i < uniqueVisits.length; i += BATCH_SIZE) {
        if (checked >= MAX_CHECKED || matchCount >= MAX_MATCHES) break;
        const remaining = Math.min(BATCH_SIZE, MAX_CHECKED - checked);
        const batch = uniqueVisits.slice(i, i + remaining);
        const bodies = await Promise.all(batch.map(e =>
          e.bodyPreview ? Promise.resolve(e.bodyPreview) : fetchPageBody(e.url)
        ));
        const entries = [];
        for (let j = 0; j < batch.length; j++) {
          if (!bodies[j]) continue;
          entries.push({
            timestamp: batch[j].timestamp, action: batch[j].action, url: batch[j].url,
            title: batch[j].title || '', bodyPreview: bodies[j],
          });
        }
        if (entries.length === 0) continue;
        const resp = await sendAction({ action: 'previewRule', rule: built.rule, entries });
        for (const r of resp.results || []) {
          previewResults.push(r);
          checked++;
          if (r.match) matchCount++;
        }
        rerenderPreview();
      }
    }
    if (checked === 0) {
      previewCountEl.textContent = '';
      previewListEl.innerHTML = '<div class="rules-preview-empty">No visits found to match against</div>';
    } else {
      rerenderPreview();
    }

    // ── Pass 2: Pinned pages ──
    const listId = activeView.id;
    if (listId && activeView.type === 'list') {
      const listEntity = await readCacheable('list:' + listId);
      const pins = listEntity?.pins || [];
      if (pins.length > 0) {
        pinsPreviewEl.style.display = '';
        const pinEntries = [];
        for (const pin of pins) {
          const page = await readCacheable(pin.id);
          if (!page?.url) continue;
          const title = page.user_title || page.title || '';
          if (!title) continue;
          const body = await fetchPageBody(page.url);
          if (!body) continue;
          pinEntries.push({ url: page.url, title, bodyPreview: body });
        }
        if (pinEntries.length > 0) {
          const resp = await sendAction({ action: 'previewRule', rule: built.rule, entries: pinEntries });
          previewPinsResults = resp.results || [];
          rerenderPreview();
        } else {
          document.getElementById('rulesPinsPreviewCount').textContent = '';
          pinsPreviewListEl.innerHTML = '<div class="rules-preview-empty">No pinned pages with fetchable content</div>';
        }
      }
    }
  } catch (err) {
    previewEl.style.display = '';
    previewListEl.innerHTML = `<div class="rules-preview-error">${escapeHtml(err.message)}</div>`;
    previewCountEl.textContent = '';
    pinsPreviewEl.style.display = 'none';
  } finally {
    if (previewBtn) { previewBtn.disabled = false; previewBtn.textContent = 'Preview'; }
  }
}

function initRulesPanel() {
  // Add button → inline edit row
  document.getElementById('rulesAddBtn').addEventListener('click', () => {
    if (activeView.type !== 'list') return;
    startRuleEdit(activeView.id, null, null);
  });

  // Run button
  document.getElementById('rulesRunBtn').addEventListener('click', async () => {
    if (activeView.type !== 'list') return;
    const listId = activeView.id;
    const runBtn = document.getElementById('rulesRunBtn');
    runBtn.disabled = true;
    runBtn.textContent = 'Running…';
    try {
      const todayKey = new Date().toISOString().slice(0, 10);
      const todayEntries = await readCacheable('log:' + todayKey) || [];
      const visits = todayEntries.filter(e => e.action === 'visit_page' && e.url);
      if (visits.length === 0) {
        showInfoBubble('No visits today to match');
        return;
      }
      const bodies = await Promise.all(visits.map(e =>
        e.bodyPreview ? Promise.resolve(e.bodyPreview) : fetchPageBody(e.url)
      ));
      const entries = [];
      for (let j = 0; j < visits.length; j++) {
        entries.push({
          timestamp: visits[j].timestamp, action: visits[j].action, url: visits[j].url,
          title: visits[j].title || '', bodyPreview: bodies[j] || '',
        });
      }
      const resp = await sendAction({ action: 'runRuleBatch', listIds: [listId], entries });
      const results = resp.results || [];
      const matched = results.reduce((n, r) => n + (r.matches?.length || 0), 0);
      showInfoBubble(matched > 0 ? `Matched ${matched} page${matched !== 1 ? 's' : ''}` : 'No matches');
    } catch (err) {
      showErrorBubble('Run rules failed: ' + err.message);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = 'Run';
    }
  });
}

// Module-level storage for list pin data (used by search filtering)
let listPinsData = [];
let listPinsListId = null;

// Render all pins into #relatedResults with search filtering support
async function renderListPinView(allPins, listId) {
  listPinsData = allPins;
  listPinsListId = listId;
  await renderSearchPanel();
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

// Filter list pins by current queries + draft input, then apply filters
async function runListPinFilter() {
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

  // Apply structured filters (same as explore)
  if (!isDefaultFilterState(filterState)) {
    await enrichForFilters(filtered);
  }
  filtered = await applyFilters(filtered);

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
  vs.onLoadMore = null; // Clear stale explore demand-loader
  vs.updateData(sorted, (r) =>
    resultRowHtml(r.user_title || r.title, r.url, {
      pinned: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail,
      notes: r.notes, timestamps: r.timestamps, context: 'related',
      pinnedAt: r.pinnedAt, pinSource: r.pinSource, childIds: r.childIds, parentIds: r.parentIds, excludeListId: listId, likes: r.likes,
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
  await renderSearchPanel();
  runSearchFilterPipeline();
}

// Convert raw history entries to display entries with date-boundary dedup.
// Each URL appears at most once per calendar day, sorted newest-first.
function processHistoryForDisplay(entries, { globalDedup = false } = {}) {
  // Sort newest first
  const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);

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
    if (page.parentIds) entry.parentIds = page.parentIds;
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

async function displayHistoryRows(entries) {
  if (!entries || entries.length === 0) {
    displayMessage('No history entries found');
    return;
  }

  const displayEntries = processHistoryForDisplay(entries);
  await enrichFromEntityStorage(displayEntries);

  // When sort is null, default to lastVisit desc
  const effectiveSort = currentSortState.column ? currentSortState : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(displayEntries, effectiveSort);
  const maxAtt = Math.max(...sorted.map(e => e.attScore), 0.1);

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = '';
  vs.setData(sorted, (e) =>
    resultRowHtml(e.user_title || e.title, e.url, { attScore: e.attScore, maxAtt, attDetail: e.attDetail, notes: e.notes, timestamps: e.timestamps, context: 'global', childIds: e.childIds, parentIds: e.parentIds, likes: e.likes })
  );
}

const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>';
const DELETE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';


// Group history entries by URL, return Map<url, entry[]>
function groupHistoryByUrl(entries) {
  const map = new Map();
  for (const i of entries) {
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

  return { notes, snapshots, belongedLists, slug, likes, visitDates: pageEntity?.visitDates || [] };
}

const TIMELINE_INITIAL_LIMIT = 30;

function collectTimelineEvents(visitDates, notes, snapshots) {
  const events = [];

  // Visits from visitDates (YYYYMMDD ints → midnight timestamps)
  for (const yyyymmdd of visitDates) {
    const y = Math.floor(yyyymmdd / 10000);
    const m = Math.floor((yyyymmdd % 10000) / 100) - 1;
    const d = yyyymmdd % 100;
    events.push({ type: 'visit', timestamp: new Date(y, m, d).getTime() });
  }

  // Highlight notes (skip global page notes)
  for (const n of notes) {
    if (n.excerpt === null || n.deleted) continue;
    const ts = n.timestamps ? Math.min(...Object.values(n.timestamps)) : 0;
    if (!ts) continue;
    const raw = Array.isArray(n.excerpt) ? n.excerpt.join(' ') : (n.excerpt || '');
    events.push({ type: 'note', timestamp: ts, label: raw.substring(0, 60) + (raw.length > 60 ? '...' : '') });
  }

  // Snapshots
  for (const s of snapshots) {
    const formats = [s.hasHtml && 'html', s.hasMd && 'md'].filter(Boolean).join(', ');
    events.push({ type: 'snapshot', timestamp: s.timestamp, label: formats });
  }

  events.sort((a, b) => b.timestamp - a.timestamp);
  return events;
}

function renderTimelineHtml(events, limit = TIMELINE_INITIAL_LIMIT) {
  if (events.length === 0) return '';

  const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const typeLabels = { visit: 'Visited', note: 'Note', snapshot: 'Snapshot' };
  const shown = events.slice(0, limit);
  const remaining = events.length - shown.length;

  // Group by date string
  const groups = [];
  let lastDate = null;
  for (const ev of shown) {
    const dateStr = fmtDate(ev.timestamp);
    if (dateStr !== lastDate) {
      groups.push({ date: dateStr, events: [] });
      lastDate = dateStr;
    }
    groups[groups.length - 1].events.push(ev);
  }

  let html = '<div class="detail-timeline"><span class="detail-section-label">Timeline</span>';
  for (const g of groups) {
    html += `<div class="timeline-date-group"><div class="timeline-date-label">${escapeHtml(g.date)}</div>`;
    for (const ev of g.events) {
      const label = ev.type === 'visit' ? typeLabels.visit
        : ev.type === 'note' ? `${typeLabels.note}: "${escapeHtml(ev.label)}"`
        : `${typeLabels.snapshot} (${escapeHtml(ev.label)})`;
      html += `<div class="timeline-event"><span class="timeline-dot ${ev.type}"></span><span class="timeline-event-label">${label}</span></div>`;
    }
    html += '</div>';
  }

  if (remaining > 0) {
    html += `<button class="timeline-show-more">${remaining} more events</button>`;
  }
  html += '</div>';
  return html;
}

function renderExtraDetailHtml(extra) {
  let html = '';

  // Page note textarea (global note = excerpt is null)
  const globalNote = extra.notes.find(n => n.excerpt === null);
  html += `<div class="detail-section"><span class="detail-section-label">Page Note:</span>
    <textarea class="detail-page-note" data-note-slug="${escapeHtml(globalNote?.slug || '')}" data-page-slug="${escapeHtml(extra.slug)}" placeholder="Add a page note...">${escapeHtml(globalNote?.note || '')}</textarea>
  </div>`;

  if (extra.likes > 0) {
    html += `<div class="detail-section"><span class="detail-section-label">Liked:</span> <strong>${extra.likes}</strong></div>`;
  }

  if (extra.belongedLists.length > 0) {
    html += '<div class="detail-section"><span class="detail-section-label">Lists:</span> ';
    html += extra.belongedLists.map(t => `<span class="detail-list-tag">${escapeHtml(t)}</span>`).join(' ');
    html += '</div>';
  }

  const highlightNotes = extra.notes.filter(n => n.excerpt !== null);
  if (highlightNotes.length > 0) {
    html += `<div class="detail-section detail-notes-section" data-slug="${escapeHtml(extra.slug)}"><span class="detail-section-label">Notes:</span>`;
    for (const n of highlightNotes.slice(0, 20)) {
      const rawQuote = Array.isArray(n.excerpt) ? n.excerpt.join(' ') : (n.excerpt || '');
      const noteText = n.note || '';
      const noteSlug = n.slug || '';
      const label = escapeHtml(rawQuote.substring(0, 100)) + (rawQuote.length > 100 ? '...' : '');
      const noteHtml = noteText ? ` <span class="detail-note-text">${escapeHtml(noteText)}</span>` : '';
      html += `<div class="detail-note-entry" data-note-slug="${escapeHtml(noteSlug)}">
        <span class="detail-note-content">"${label}"${noteHtml}</span>
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

  // Event timeline
  const timelineEvents = collectTimelineEvents(extra.visitDates, extra.notes, extra.snapshots);
  html += renderTimelineHtml(timelineEvents);

  return html;
}

function bindTimelineShowMore(container, extra) {
  const btn = container.querySelector('.timeline-show-more');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const allEvents = collectTimelineEvents(extra.visitDates, extra.notes, extra.snapshots);
    const timeline = container.querySelector('.detail-timeline');
    if (timeline) {
      timeline.outerHTML = renderTimelineHtml(allEvents, Infinity);
    }
  });
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

function bindPageNoteHandler(container, url) {
  const textarea = container.querySelector('.detail-page-note');
  if (!textarea) return;

  requestAnimationFrame(() => autoResizeTextarea(textarea));

  let saveTimeout = null;
  textarea.addEventListener('input', () => {
    autoResizeTextarea(textarea);
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      const note = textarea.value;
      const noteSlug = textarea.dataset.noteSlug;
      const pageSlug = textarea.dataset.pageSlug;
      try {
        if (noteSlug) {
          const unResp = await sendAction({ action: 'updateNote', noteSlug, note });
          if (unResp?.noteSlug && unResp.noteSlug !== noteSlug) {
            textarea.dataset.noteSlug = unResp.noteSlug;
          }
        } else if (note) {
          const resp = await sendAction({ action: 'createNote', pageSlug, url, excerpt: null, note, cssPath: null });
          if (resp?.noteSlug) {
            textarea.dataset.noteSlug = resp.noteSlug;
          }
        }
      } catch (err) {
        console.error('[options] Page note save error:', err);
      }
    }, 500);
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
  const { pinned, deletable = false, attScore = 0, maxAtt = 1, attDetail = null, notes = [], timestamps = [], context = 'global', pinnedAt, pinSource, cssClass, childIds = [], parentIds = [], excludeListId, likes = 0, matchSources } = opts;

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
  for (const pid of parentIds) {
    if (!pid.startsWith('list:') || pid.startsWith('list:system/')) continue;
    const listSlug = pid.slice(5);
    if (excludeListId && listSlug === excludeListId) continue;
    const name = listNameById.get(listSlug);
    if (name) belongedListNames.push(name);
  }
  const attLvl = attentionLevel(normalized);
  if (url) cardDataByUrl.set(url, {
    attDetail: attDetail ? { timeOnPage: attDetail.timeOnPage, scrollDepth: attDetail.scrollDepth, clicks: attDetail.clicks } : null,
    timestamps,
  });
  const attCtrlHtml = `<div class="att-ctrl${attLvl ? ' ' + attLvl : ''}" data-url="${safeUrl}" data-title="${safeTitle}"><span class="att-ctrl-dot"></span><button class="att-ctrl-btn" title="View details">···</button></div>`;
  const listTagsHtml = belongedListNames.map(n => `<span class="card-tag card-tag-list">${escapeHtml(n)}</span>`).join('');
  const isLiked = likes > 0;
  const isAuto = pinSource === 'auto';
  const matchNoteHit = matchSources && matchSources.has('note');
  const matchSnapHit = matchSources && matchSources.has('snapshot');
  const hasExtras = hasNotes || hasSnaps || isLiked || isAuto || listTagsHtml || matchNoteHit || matchSnapHit;
  const extrasHtml = hasExtras ? `<div class="card-extras">${isAuto ? '<span class="card-tag card-tag-auto">auto</span>' : ''}${isLiked ? '<span class="card-tag card-tag-liked">liked</span>' : ''}${hasNotes ? '<span class="card-tag card-tag-note">note</span>' : ''}${hasSnaps ? '<span class="card-tag card-tag-snap">snapshot</span>' : ''}${matchNoteHit ? '<span class="card-tag card-tag-match-note">matched in note</span>' : ''}${matchSnapHit ? '<span class="card-tag card-tag-match-snap">matched in snapshot</span>' : ''}${listTagsHtml}</div>` : '';
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
      container._virtualScroller?.clearSelection?.();
      row.classList.add('selected');
      lastClickedRow = row;
    }
  });

  container.addEventListener('dblclick', (e) => {
    if (e.target.closest('.result-pin') || e.target.closest('.card-actions') || e.target.closest('.att-ctrl')) return;
    const item = e.target.closest('.result-item');
    if (!item) return;
    const row = item.querySelector('.result-row');
    if (!row) return;
    chrome.tabs.create({ url: row.dataset.url });
  });

  container.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.result-row');
    if (!row) return;
    // Include all selected rows if the dragged row is part of a selection
    const selected = container.querySelectorAll('.result-row.selected');
    const items = (selected.length > 0 && row.classList.contains('selected'))
      ? [...selected].map(r => ({ url: r.dataset.url, title: r.dataset.title }))
      : [{ url: row.dataset.url, title: row.dataset.title }];
    e.dataTransfer.setData('text/plain', JSON.stringify({ items }));
    e.dataTransfer.effectAllowed = 'copy';
  });
}

function openPageDetailCard(url, title, attDetail = null, timestamps = []) {
  closePageDetailCard();

  const overlay = document.createElement('div');
  overlay.id = 'pageDetailOverlay';
  overlay.className = 'page-detail-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePageDetailCard(); });

  const card = document.createElement('div');
  card.className = 'page-detail-card';
  card.innerHTML = `
    <div class="page-detail-header">
      <div class="page-detail-title">${escapeHtml(title || url)}</div>
      <button class="page-detail-close" title="Close">×</button>
    </div>
    <div class="page-detail-body"><div class="page-detail-loading"><span class="spinner"></span></div></div>
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
    bindPageNoteHandler(body, url);
    bindTimelineShowMore(body, extra);
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
  const order = await readCacheable('manifest:list-order');
  return buildTreeFromManifest(order?.tree || []);
}
async function buildTreeFromManifest(treeNodes) {
  const nodes = [];
  for (const treeNode of treeNodes) {
    const key = treeNode.id;
    const entity = await readCacheable(key);
    if (!entity || entity.deleted) continue;
    const slug = entity.slug || key.slice(5);
    const children = treeNode.children?.length ? await buildTreeFromManifest(treeNode.children) : [];
    const node = { slug, name: entity.name || slug, children };
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

async function renderLists() {
  const tree = await loadListTree();
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
  item.setAttribute('role', 'button');
  item.tabIndex = 0;
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
      if (draggedId === lst.slug) {
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
      if (draggedId === lst.slug) return;

      // Determine drop zone
      const rect = item.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;

      // Read current tree, apply the move, send full tree to background
      const order = await readCacheable('manifest:list-order');
      let tree = JSON.parse(JSON.stringify(order?.tree || []));

      // Remove dragged node from tree (keeping its subtree)
      let draggedNode = null;
      function extractNode(nodes) {
        for (let i = 0; i < nodes.length; i++) {
          if (nodes[i].id === 'list:' + draggedId) {
            draggedNode = nodes.splice(i, 1)[0];
            return true;
          }
          if (nodes[i].children && extractNode(nodes[i].children)) return true;
        }
        return false;
      }
      extractNode(tree);
      if (!draggedNode) draggedNode = { id: 'list:' + draggedId };

      if (relY >= 0.25 && relY <= 0.75) {
        // --- Nest as child of target ---
        function appendToTarget(nodes) {
          for (const n of nodes) {
            if (n.id === 'list:' + lst.slug) {
              if (!n.children) n.children = [];
              n.children.push(draggedNode);
              return true;
            }
            if (n.children && appendToTarget(n.children)) return true;
          }
          return false;
        }
        if (!appendToTarget(tree)) tree.push(draggedNode);
      } else {
        // --- Reorder above/below sibling ---
        function insertNear(nodes) {
          for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].id === 'list:' + lst.slug) {
              const idx = relY < 0.25 ? i : i + 1;
              nodes.splice(idx, 0, draggedNode);
              return true;
            }
            if (nodes[i].children && insertNear(nodes[i].children)) return true;
          }
          return false;
        }
        if (!insertNear(tree)) tree.push(draggedNode);
      }

      await chrome.runtime.sendMessage({ action: 'updateListTree', tree });
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
        const titles = {};
        for (const { url, title } of items) {
          const pinId = 'page:' + generateSlugFromUrl(url);
          if (url && !pins.some(p => p.id === pinId)) {
            pins.push({ id: pinId, pinnedAt: Date.now() });
            newUrls.push(url);
            if (title) titles[url] = title;
          }
        }
        if (newUrls.length > 0) {
          const msg = { action: 'addListPins', listId: lst.slug, urls: newUrls };
          if (Object.keys(titles).length > 0) msg.titles = titles;
          await chrome.runtime.sendMessage(msg);
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
  const allPages = Array.from(historyByUrl.values());
  document.getElementById('totalHistory').textContent = allPages.length;

  const today = new Date().setHours(0, 0, 0, 0);
  const todayCount = allPages.filter(i => i.timestamp >= today).length;
  document.getElementById('todayHistory').textContent = todayCount;

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

// Sync settings
document.getElementById('syncEnabled').addEventListener('change', () => {
  document.getElementById('syncConfigFields').style.display =
    document.getElementById('syncEnabled').checked ? 'block' : 'none';
});

function syncShowMethodFields(method) {
  document.getElementById('syncGithubFields').style.display = method === 'github' ? 'block' : 'none';
  document.getElementById('syncFilesystemFields').style.display = method === 'filesystem' ? 'block' : 'none';
  document.getElementById('syncWebdavFields').style.display = method === 'webdav' ? 'block' : 'none';
}

document.getElementById('syncMethod').addEventListener('change', () => {
  syncShowMethodFields(document.getElementById('syncMethod').value);
});

document.getElementById('selectSyncDirBtn').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
    // Store handle in IndexedDB (same DB as main data directory).
    const dbReq = indexedDB.open('PortalFS', 1);
    dbReq.onsuccess = () => {
      const db = dbReq.result;
      const tx = db.transaction(['handles'], 'readwrite');
      tx.objectStore('handles').put(handle, 'syncDirectory');
      tx.oncomplete = async () => {
        document.getElementById('syncFolderLabel').textContent = handle.name;
        await saveSettingsValue('syncFolderName', handle.name);
      };
    };
  } catch (e) {
    if (e.name !== 'AbortError') showStatus('Failed to select folder: ' + e.message, 'error');
  }
});

document.getElementById('syncSaveBtn').addEventListener('click', async () => {
  const enabled = document.getElementById('syncEnabled').checked;
  const method = document.getElementById('syncMethod').value;
  const interval = parseInt(document.getElementById('syncIntervalMinutes').value) || 5;
  const retention = parseInt(document.getElementById('syncRetentionDays').value) || 7;

  if (enabled) {
    if (method === 'github') {
      const repoUrl = document.getElementById('syncRepoUrl').value.trim();
      if (!repoUrl) { showStatus('Repository URL is required', 'error'); return; }
      const authState = await sendAction({ action: 'getSyncAuthState' });
      if (!authState.hasToken) { showStatus('GitHub not connected — click "Connect with GitHub" first', 'error'); return; }
      await saveSettingsValue('syncRepoUrl', repoUrl);
    } else if (method === 'filesystem') {
      const folderName = await loadSettingsValue('syncFolderName', '');
      if (!folderName) { showStatus('Please select a sync folder first', 'error'); return; }
    } else if (method === 'webdav') {
      const url = document.getElementById('syncWebdavUrl').value.trim();
      if (!url) { showStatus('WebDAV URL is required', 'error'); return; }
      await saveSettingsValue('syncWebdavUrl', url);
      await saveSettingsValue('syncWebdavUser', document.getElementById('syncWebdavUser').value.trim());
      await saveSettingsValue('syncWebdavPass', document.getElementById('syncWebdavPass').value.trim());
    }
  }

  await saveSettingsValue('syncEnabled', enabled);
  await saveSettingsValue('syncMethod', method);
  await saveSettingsValue('syncIntervalMinutes', Math.max(1, interval));
  await saveSettingsValue('syncRetentionDays', Math.max(1, retention));
  await sendAction('updateSyncSettings');
  showStatus('Sync settings saved', 'success');
});

document.getElementById('syncNowBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('syncStatus');
  statusEl.innerHTML = '<span class="spinner spinner-sm"></span> Syncing...';
  try {
    const result = await sendAction('syncNow');
    if (result.skipped) {
      statusEl.textContent = result.error || 'Sync skipped (not configured or already running)';
    } else if (result.error) {
      statusEl.style.color = '#c62828';
      if (result.authExpired) {
        statusEl.textContent = 'GitHub authorization expired — please reconnect in Settings.';
        syncShowAuthState('disconnected');
      } else if (result.disabled) {
        statusEl.textContent = `Sync disabled: ${result.error}. Fix settings and save again.`;
      } else {
        statusEl.textContent = `Error (will retry): ${result.error}`;
      }
    } else {
      statusEl.style.color = '#2e7d32';
      const parts = [];
      if (result.pushed) parts.push('pushed');
      if (result.pulled) parts.push(`pulled ${result.entriesReplayed} entries`);
      const time = new Date(result.timestamp).toLocaleTimeString();
      statusEl.textContent = (parts.length ? parts.join(', ') : 'No changes') + ` at ${time}`;
    }
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
  }
});

// ─── GitHub Auth UI ──────────────────────────────────────────────────

let deviceFlowAbort = null; // AbortController for cancelling device flow

function syncShowAuthState(state, detail) {
  document.getElementById('syncAuthDisconnected').style.display = state === 'disconnected' ? '' : 'none';
  document.getElementById('syncAuthDeviceFlow').style.display = state === 'device-flow' ? '' : 'none';
  document.getElementById('syncAuthConnected').style.display = state === 'connected' ? '' : 'none';
  if (state === 'connected' && detail) {
    document.getElementById('syncAuthDetail').textContent = detail;
  }
}

document.getElementById('syncGithubConnectBtn').addEventListener('click', async () => {
  try {
    const { user_code, device_code, verification_uri, interval, expires_in } = await requestDeviceCode();
    document.getElementById('syncDeviceCode').textContent = user_code;
    syncShowAuthState('device-flow');

    deviceFlowAbort = new AbortController();

    document.getElementById('syncOpenGithubBtn').href = verification_uri;
    document.getElementById('syncOpenGithubBtn').onclick = (e) => {
      e.preventDefault();
      window.open(verification_uri, '_blank');
    };

    const token = await pollForToken(device_code, interval, expires_in, deviceFlowAbort.signal);
    const { login } = await fetchGitHubUser(token);
    const remember = document.getElementById('syncRememberToken').checked;
    await sendAction({ action: 'setSyncToken', token, remember, authMethod: 'oauth', githubUser: login });
    syncShowAuthState('connected', `as @${login} via GitHub OAuth`);
    deviceFlowAbort = null;
  } catch (e) {
    deviceFlowAbort = null;
    if (!e.message.includes('cancel')) {
      showStatus(`GitHub auth failed: ${e.message}`, 'error');
    }
    syncShowAuthState('disconnected');
  }
});

document.getElementById('syncCopyCodeBtn').addEventListener('click', () => {
  const code = document.getElementById('syncDeviceCode').textContent;
  navigator.clipboard.writeText(code).then(() => {
    document.getElementById('syncCopyCodeBtn').textContent = 'Copied!';
    setTimeout(() => { document.getElementById('syncCopyCodeBtn').textContent = 'Copy'; }, 1500);
  });
});

document.getElementById('syncCancelAuthBtn').addEventListener('click', () => {
  if (deviceFlowAbort) { deviceFlowAbort.abort(); deviceFlowAbort = null; }
  syncShowAuthState('disconnected');
});

document.getElementById('syncPatToggle').addEventListener('click', (e) => {
  e.preventDefault();
  const fields = document.getElementById('syncPatFields');
  fields.style.display = fields.style.display === 'none' ? '' : 'none';
});

document.getElementById('syncPatSaveBtn').addEventListener('click', async () => {
  const token = document.getElementById('syncPatInput').value.trim();
  if (!token) { showStatus('Token is required', 'error'); return; }
  try {
    const { login } = await fetchGitHubUser(token);
    const remember = document.getElementById('syncRememberToken').checked;
    await sendAction({ action: 'setSyncToken', token, remember, authMethod: 'pat', githubUser: login });
    syncShowAuthState('connected', `as @${login} via personal access token`);
    document.getElementById('syncPatInput').value = '';
    document.getElementById('syncPatFields').style.display = 'none';
  } catch (e) {
    showStatus(`Invalid token: ${e.message}`, 'error');
  }
});

document.getElementById('syncDisconnectBtn').addEventListener('click', async () => {
  await sendAction({ action: 'clearSyncToken' });
  syncShowAuthState('disconnected');
  const revokeUrl = getGitHubRevokeUrl();
  showStatus(`Disconnected. <a href="${revokeUrl}" target="_blank" style="color:#1a73e8;">Revoke on GitHub</a>`, 'success');
});

document.getElementById('syncRememberToken').addEventListener('change', async () => {
  const remember = document.getElementById('syncRememberToken').checked;
  await sendAction({ action: 'toggleSyncRemember', remember });
});

// Clear all data
document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('WARNING: This will DELETE ALL FILES in your storage directory!\n\nThis cannot be undone. Are you absolutely sure?')) {
    return;
  }
  if (!confirm('Final confirmation: Delete all history files?')) {
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

// --- Import Bookmarks ---
{
  const fileInput = document.getElementById('bookmarkFileInput');
  const treeContainer = document.getElementById('bookmarkTreeContainer');
  const importBtn = document.getElementById('importBookmarksBtn');
  const progressEl = document.getElementById('importProgress');
  const failuresEl = document.getElementById('importFailures');

  let parsedTree = null;
  let parseBookmarkHtml = null;

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!parseBookmarkHtml) {
      const mod = await import('./bookmark-parser.js');
      parseBookmarkHtml = mod.parseBookmarkHtml;
    }
    const text = await file.text();
    parsedTree = parseBookmarkHtml(text);
    renderBookmarkTree(parsedTree);
    importBtn.disabled = true; // nothing checked yet
    progressEl.textContent = '';
    failuresEl.innerHTML = '';
  });

  function renderBookmarkTree(root) {
    treeContainer.innerHTML = '';
    treeContainer._items = [];
    if (root.bookmarks.length > 0) {
      const rootItem = createTreeItem({ title: '(Root bookmarks)', bookmarks: root.bookmarks, skipped: root.skipped || [], children: [], bookmarkCount: root.bookmarks.length, subfolderCount: 0 }, 0);
      treeContainer.appendChild(rootItem.el);
      treeContainer._items.push(rootItem);
    }
    for (const folder of root.children) {
      const item = createTreeItem(folder, 0);
      treeContainer.appendChild(item.el);
      treeContainer._items.push(item);
    }
  }

  function createTreeItem(folder, depth) {
    const wrapper = document.createElement('div');

    const row = document.createElement('div');
    row.className = 'bookmark-tree-item';
    row.style.paddingLeft = (depth * 16) + 'px';

    // Toggle arrow
    const toggle = document.createElement('button');
    toggle.className = 'bm-toggle' + (folder.children.length === 0 ? ' leaf' : '');
    row.appendChild(toggle);

    // Checkbox
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    row.appendChild(cb);

    // Label
    const label = document.createElement('span');
    label.className = 'bm-label';
    label.textContent = folder.title;
    row.appendChild(label);

    // Count
    const count = document.createElement('span');
    count.className = 'bm-count';
    const parts = [];
    if (folder.bookmarkCount > 0) parts.push(`${folder.bookmarkCount} bookmark${folder.bookmarkCount !== 1 ? 's' : ''}`);
    if (folder.subfolderCount > 0) parts.push(`${folder.subfolderCount} subfolder${folder.subfolderCount !== 1 ? 's' : ''}`);
    count.textContent = parts.length > 0 ? `(${parts.join(', ')})` : '(empty)';
    row.appendChild(count);

    wrapper.appendChild(row);

    // Children container
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'bookmark-tree-children' + (depth >= 1 ? ' collapsed' : '');
    const childItems = [];
    for (const child of folder.children) {
      const childItem = createTreeItem(child, depth + 1);
      childrenContainer.appendChild(childItem.el);
      childItems.push(childItem);
    }
    wrapper.appendChild(childrenContainer);

    // Toggle expand/collapse
    if (folder.children.length > 0) {
      toggle.classList.toggle('expanded', depth < 1);
      toggle.addEventListener('click', () => {
        const collapsed = childrenContainer.classList.toggle('collapsed');
        toggle.classList.toggle('expanded', !collapsed);
      });
    }

    // Checkbox: tri-state propagation
    cb.addEventListener('change', () => {
      // Propagate down: check/uncheck all descendants
      setSubtreeChecked(childItems, cb.checked);
      updateImportButton();
    });

    function getChecked() { return cb.checked; }
    function getIndeterminate() { return cb.indeterminate; }
    function setChecked(val) { cb.checked = val; cb.indeterminate = false; }
    function setIndeterminate() { cb.indeterminate = true; cb.checked = false; }

    function updateFromChildren() {
      if (childItems.length === 0) return;
      const allChecked = childItems.every(c => c.getChecked() && !c.getIndeterminate());
      const noneChecked = childItems.every(c => !c.getChecked() && !c.getIndeterminate());
      if (allChecked) setChecked(true);
      else if (noneChecked) setChecked(false);
      else setIndeterminate();
    }

    // Wire children to update parent
    for (const child of childItems) {
      child.onchange = () => {
        updateFromChildren();
        updateImportButton();
      };
    }

    // Notify parent on change
    let onchange = null;
    cb.addEventListener('change', () => { if (item.onchange) item.onchange(); });

    const item = {
      el: wrapper,
      folder,
      getChecked,
      getIndeterminate,
      setChecked,
      children: childItems,
      get onchange() { return onchange; },
      set onchange(fn) { onchange = fn; },
    };
    return item;
  }

  function setSubtreeChecked(items, checked) {
    for (const item of items) {
      item.setChecked(checked);
      setSubtreeChecked(item.children, checked);
    }
  }

  function updateImportButton() {
    const items = treeContainer.querySelectorAll('.bookmark-tree-item input[type="checkbox"]');
    const anyChecked = Array.from(items).some(cb => cb.checked);
    importBtn.disabled = !anyChecked;
  }

  function collectCheckedTree(items) {
    const result = [];
    for (const item of items) {
      if (item.getChecked() || item.getIndeterminate()) {
        // Include this folder — collect its selected children recursively
        const childSelected = collectCheckedTree(item.children);
        result.push({
          title: item.folder.title,
          bookmarks: item.getChecked() ? item.folder.bookmarks : [],
          skipped: item.getChecked() ? (item.folder.skipped || []) : [],
          children: childSelected,
        });
      }
    }
    return result;
  }

  importBtn.addEventListener('click', async () => {
    const selected = collectCheckedTree(treeContainer._items || []);
    if (selected.length === 0) return;

    importBtn.disabled = true;
    importBtn.textContent = 'Importing...';
    progressEl.textContent = 'Starting import...';
    failuresEl.innerHTML = '';

    const port = chrome.runtime.connect({ name: 'import-bookmarks' });
    port.postMessage({ action: 'importBookmarks', tree: selected });

    port.onMessage.addListener((msg) => {
      if (msg.type === 'progress') {
        progressEl.textContent = msg.text;
      } else if (msg.type === 'done') {
        progressEl.textContent = `Done! Imported ${msg.listCount} list${msg.listCount !== 1 ? 's' : ''} with ${msg.bookmarkCount} bookmark${msg.bookmarkCount !== 1 ? 's' : ''}.`;
        if (msg.failures && msg.failures.length > 0) {
          const details = document.createElement('details');
          const summary = document.createElement('summary');
          summary.textContent = `${msg.failures.length} item${msg.failures.length !== 1 ? 's' : ''} skipped`;
          details.appendChild(summary);
          const list = document.createElement('ul');
          list.style.cssText = 'margin:4px 0;padding-left:20px;';
          for (const f of msg.failures) {
            const li = document.createElement('li');
            li.textContent = `${f.title || f.url} — ${f.reason}`;
            list.appendChild(li);
          }
          details.appendChild(list);
          failuresEl.innerHTML = '';
          failuresEl.appendChild(details);
        }
        importBtn.textContent = 'Import Selected';
        importBtn.disabled = false;
      } else if (msg.type === 'error') {
        progressEl.textContent = 'Import failed: ' + msg.message;
        importBtn.textContent = 'Import Selected';
        importBtn.disabled = false;
      }
    });

    port.onDisconnect.addListener(() => {
      if (importBtn.textContent === 'Importing...') {
        importBtn.textContent = 'Import Selected';
        importBtn.disabled = false;
      }
    });
  });
}

// --- URL Blacklist ---
const DEFAULT_BLACKLIST = ['chrome://', 'edge://'];

async function loadBlacklist() {
  const list = await loadSettingsValue('urlBlacklist', null);
  return list ?? [...DEFAULT_BLACKLIST];
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

  if (type === 'history') {
    // New page visit — merge into historyByUrl and historyAllEntries
    clearTimeout(mutationRefreshTimer);
    mutationRefreshTimer = setTimeout(async () => {
      const todayEntries = await readCacheable('log:' + new Date().toISOString().slice(0, 10)) || [];
      const historyBuffer = todayEntries.filter(e => (e.action === 'visit_page' || e.action === 'leave_page' || !e.action) && e.url);
      let changed = false;
      for (const entry of historyBuffer) {
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
  } else if (type === 'rules') {
    // Rules changed — refresh rules panel if viewing the affected list
    if (activeView.type === 'list' && request.listId === activeView.id) {
      refreshRulesForActiveList();
    }
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
    const filesResp = await sendAction({ action: 'listHistoryFiles' });
    const allFiles = filesResp.files;
    const newFiles = allFiles.filter(f => !historyFiles.includes(f));
    if (newFiles.length > 0) {
      historyFiles = allFiles;
      const batchResp = await sendAction({ action: 'loadHistoryBatch', files: newFiles });
      const newEntries = batchResp.entries;
      for (const item of newEntries) {
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
  // handle re-rendering for pin/list/history changes. A full re-render would
  // destroy scroll position, block enable/disable state, and expanded details.
});

// --- Explore Search ---


async function renderSearchPanel() {
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
  html += `<button class="filter-toggle-btn${filterVisible ? ' active' : ''}${!isDefaultFilterState(filterState) ? ' has-filters' : ''}" id="filterToggleBtn" title="Filters">${filterSvg}</button>`;
  html += '</div>';

  html += `<div class="filter-panel" id="filterPanel" style="display:${filterVisible ? 'flex' : 'none'}">`;
  html += await renderFilterPanelHtml();
  html += '</div>';

  html += '</div>';

  container.innerHTML = html;
  bindSearchEvents(container);
  if (filterVisible) bindFilterEvents(container);
}

async function renderFilterPanelHtml() {
  let html = '';
  const isListView = activeView.type === 'list';

  // Sort toggle (list view only)
  if (isListView) {
    const sortOptions = [
      { key: 'lastVisit', label: 'Last visit' },
      { key: 'firstVisit', label: 'First visit' },
      { key: 'pinTime', label: 'Pin time' },
      { key: 'title', label: 'Title' },
      { key: 'totalVisits', label: 'Visits' },
    ];
    const currentSort = relatedSortState.column || 'lastVisit';
    html += '<div class="filter-section"><div class="filter-section-label">Sort by</div>';
    html += '<div class="sort-toggle">';
    for (const opt of sortOptions) {
      html += `<button class="sort-toggle-option${currentSort === opt.key ? ' active' : ''}" data-sort="${opt.key}">${escapeHtml(opt.label)}</button>`;
    }
    html += '</div></div>';
  }

  // List membership bubbles
  const lists = await collectFilterLists();
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
async function collectFilterLists() {
  const tree = await loadListTree();
  const lists = [];
  function walk(nodes) {
    for (const node of nodes) {
      lists.push({ slug: node.slug, name: node.name });
      if (node.children) walk(node.children);
    }
  }
  walk(tree);
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
  const lists = await collectFilterLists();
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
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index);
      savedSearches.splice(idx, 1);
      await renderSearchPanel();
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
    draftInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && draftInput.value.trim()) {
        savedSearches.push(draftInput.value.trim());
        currentSearchInput = '';
        await renderSearchPanel();
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
        panel.style.display = filterVisible ? 'flex' : 'none';
        filterBtn.classList.toggle('active', filterVisible);
        if (filterVisible) bindFilterEvents(container);
      }
    });
  }
}

function bindFilterEvents(container) {
  // Sort toggle (list view)
  container.querySelectorAll('.sort-toggle-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const sortKey = btn.dataset.sort;
      // Toggle direction if clicking the already-active sort
      if (relatedSortState.column === sortKey) {
        relatedSortState.direction = relatedSortState.direction === 'desc' ? 'asc' : 'desc';
      } else {
        relatedSortState.column = sortKey;
        relatedSortState.direction = sortKey === 'title' ? 'asc' : 'desc';
      }
      // Update active class
      container.querySelectorAll('.sort-toggle-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      runActiveSearchPipeline();
    });
  });

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

  if (allQueries.length > 0 && allQueries.some(q => q.trim())) {
    // Progressive multi-phase search: Phase 0 (in-memory) renders instantly,
    // then Phase 1 (WASM JSONL), 2a (notes), 2b (snapshots) fire concurrently.
    await runProgressiveSearch(allQueries);
    return;
  }

  // No search queries → show all history (demand-loaded)
  let results = processHistoryForDisplay(
    historyAllEntries.filter(item => item.url && !pinnedSlugs.has(generateSlugFromUrl(item.url)))
  ).map(item => ({ ...item, relevance: 0 }));
  await enrichFromEntityStorage(results);

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
      childIds: r.childIds, parentIds: r.parentIds, likes: r.likes,
    })
  );

  // Demand-load more history when scrolling (for all-history mode)
  vs.onLoadMore = async () => {
    const newItems = await loadHistoryBatch();
    if (newItems.length > 0) {
      const filtered = newItems.filter(item => item.url && !pinnedSlugs.has(generateSlugFromUrl(item.url)));
      const newResults = processHistoryForDisplay(filtered).map(item => ({ ...item, relevance: 0 }));
      await enrichFromEntityStorage(newResults);
      if (newResults.length > 0) {
        const sort = relatedSortState.column ? relatedSortState : { column: 'lastVisit', direction: 'desc' };
        vs.appendData(applySortOrder(newResults, sort));
      }
    }
  };

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

  content.innerHTML = '<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty"><span class="spinner"></span></div></div></div>';
  overlay.classList.add('visible');

  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getPageRelations', url });
    if (!resp?.success) {
      content.innerHTML = '<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">Could not load relations</div></div></div>';
      return;
    }

    // Compute similar pages from loaded history
    const seedEntry = historyByUrl.get(url);
    let similar = [];
    if (seedEntry) {
      const seed = { ...seedEntry, timestamps: [seedEntry.timestamp || Date.now()], attScore: 0, attDetail: null, notes: [] };
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

  content.innerHTML = '<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty"><span class="spinner"></span></div></div></div>';
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
          deletable: false, attScore: 0, maxAtt, timestamps: [r.pinnedAt || Date.now()], context: 'global', pinSource: r.source || null, childIds: r.childIds, parentIds: r.parentIds
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

// --- Sidebar responsive toggle ---
function initSidebarToggle() {
  const toggle = document.getElementById('sidebarToggle');
  const overlay = document.getElementById('sidebarOverlay');
  const sidebar = document.querySelector('.sidebar');
  if (!toggle || !overlay || !sidebar) return;
  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('sidebar-open');
  });
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('sidebar-open');
  });
  // Close sidebar on narrow screens when navigating
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('.sidebar-item') || e.target.closest('.explore-btn')) {
      sidebar.classList.remove('sidebar-open');
    }
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

  // Verify device identity — CURRENT file must be readable
  const deviceResp = await chrome.runtime.sendMessage({ action: 'getDeviceId' });
  if (!deviceResp?.deviceId) {
    throw new Error('Device identity unavailable — the CURRENT file may be missing or corrupted. Try reloading the extension.');
  }

  // Load settings from filesystem
  relatedPagesLimit = await loadSettingsValue('relatedPagesLimit', 50);
  document.getElementById('relatedPagesLimit').value = relatedPagesLimit;
  historyFileBatch = await loadSettingsValue('historyFileBatch', 10);
  document.getElementById('historyFileBatch').value = historyFileBatch;
  document.getElementById('captureSnapshotVideo').checked = await loadSettingsValue('captureSnapshotVideo', false);
  // Sync settings
  const syncEnabled = await loadSettingsValue('syncEnabled', false);
  document.getElementById('syncEnabled').checked = syncEnabled;
  document.getElementById('syncConfigFields').style.display = syncEnabled ? 'block' : 'none';
  const syncMethod = await loadSettingsValue('syncMethod', 'github');
  document.getElementById('syncMethod').value = syncMethod;
  syncShowMethodFields(syncMethod);
  document.getElementById('syncRepoUrl').value = await loadSettingsValue('syncRepoUrl', '');
  // Load GitHub auth state from background (token lives in session, not settings)
  try {
    const authState = await sendAction({ action: 'getSyncAuthState' });
    if (authState.hasToken) {
      const method = authState.authMethod === 'pat' ? 'personal access token' : 'GitHub OAuth';
      const user = authState.githubUser ? `as @${authState.githubUser} ` : '';
      syncShowAuthState('connected', `${user}via ${method}`);
    } else {
      syncShowAuthState('disconnected');
    }
    document.getElementById('syncRememberToken').checked = authState.rememberToken;
  } catch { syncShowAuthState('disconnected'); }
  document.getElementById('syncFolderLabel').textContent = await loadSettingsValue('syncFolderName', '');
  document.getElementById('syncWebdavUrl').value = await loadSettingsValue('syncWebdavUrl', '');
  document.getElementById('syncWebdavUser').value = await loadSettingsValue('syncWebdavUser', '');
  document.getElementById('syncWebdavPass').value = await loadSettingsValue('syncWebdavPass', '');
  document.getElementById('syncIntervalMinutes').value = await loadSettingsValue('syncIntervalMinutes', 5);
  document.getElementById('syncRetentionDays').value = await loadSettingsValue('syncRetentionDays', 7);
  _timer('loadSettings');

  // Initialize chart tooltips
  initCharts();
  _timer('initCharts');

  // Load fold state and restore sidebar width before rendering lists
  await loadFoldState();
  restoreSidebarWidth();
  initSidebarResize();
  initSidebarToggle();
  _timer('sidebarInit');

  // Render sidebar concurrently with heavy data (don't block on sidebar)
  renderLists().catch(err => showFatalError(err.message));
  renderBlacklist();
  renderTrimRules();
  initRulesPanel();
  _timer('renderSidebar (fire-and-forget)');

  // Load metadata (history is demand-loaded in showCategory, pins loaded per-list)
  await initHistoryFiles();
  _timer('parallel metadata load');
  updateRecycleBinBadge();
  showExplore();
}

initialize().catch(err => showFatalError(err.message));
// --- Keyboard delete for selected result rows ---
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // Don't intercept when typing in an input/textarea
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  // Determine which container has selected rows
  const isListView = activeView.type === 'list';
  const container = activeView.type === 'category'
    ? document.getElementById('results')
    : document.getElementById('relatedResults');
  const selected = container?.querySelectorAll('.result-row.selected');
  if (!selected || selected.length === 0) return;

  e.preventDefault();

  if (!isListView) {
    showInfoBubble('Cannot delete history');
    return;
  }

  // Unpin each selected row from the active list
  const listId = activeView.id;
  for (const row of selected) {
    const url = row.dataset.url;
    const title = row.dataset.title;
    if (url) await toggleResultPin(listId, url, title);
  }
  refreshPins();
});

// --- Ctrl+C / Ctrl+V for page copy-paste ---
document.addEventListener('keydown', async (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  if (e.key === 'c') {
    // Copy selected rows as readable text with angle-bracket URLs
    const container = activeView.type === 'category'
      ? document.getElementById('results')
      : document.getElementById('relatedResults');
    const selected = container?.querySelectorAll('.result-row.selected');
    if (!selected || selected.length === 0) return;

    e.preventDefault();
    const lines = [...selected].map(r => {
      const title = (r.dataset.title || '').replace(/[<>]/g, '');
      const url = r.dataset.url || '';
      return title ? `${title} <${url}>` : `<${url}>`;
    });
    await navigator.clipboard.writeText(lines.join('\n'));
  }

  if (e.key === 'v') {
    if (activeView.type !== 'list') {
      e.preventDefault();
      showInfoBubble('Can only paste into a list');
      return;
    }

    e.preventDefault();
    let text;
    try { text = await navigator.clipboard.readText(); } catch { return; }
    // Extract URLs from angle-bracket format: <url>
    const urls = [];
    for (const m of text.matchAll(/<([^>]+)>/g)) {
      const candidate = m[1].trim();
      if (candidate.includes('://')) urls.push(candidate);
    }
    if (urls.length === 0) return;

    const listId = activeView.id;
    await chrome.runtime.sendMessage({ action: 'addListPins', listId, urls: urls });
    refreshPins();
  }

  if (e.key === 'a') {
    e.preventDefault();
    if (activeView.type === 'list') {
      relatedVirtualScroller?.selectAll();
    } else if (activeView.type === 'explore' && searchResults.length > 0) {
      if (searchResults.length > 100) {
        showErrorBubble('Too many results to select (limit: 100)', { suffix: '' });
      } else {
        relatedVirtualScroller?.selectAll();
      }
    } else {
      showBlockedBubble('Select all is not available here');
    }
  }
});
