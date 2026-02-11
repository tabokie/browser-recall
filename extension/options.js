// Options page for Portal extension
// Bookmark-manager style UI with sidebar navigation, search, and settings modal
import { FileSystemStorage } from './filesystem-storage.js';
import init, { Interaction, SearchEngine } from './pkg/portal_extension.js';
import { mergeBufferIntoInteractions, buildInteractionsForEngine } from './search-helpers.js';
import { generateSlugFromUrl } from './utils.js';

const fsStorage = new FileSystemStorage();

// --- State ---
let currentAlgorithm = 0;   // for category/search views
let pinnedAlgorithm = 0;    // topic pinned section
let relatedAlgorithm = 0;   // topic related section
let currentSort = 'lastVisit';  // for category/search views
let pinnedSort = 'lastVisit';   // topic pinned section
let relatedSort = 'lastVisit';  // topic related section
let wasmInitialized = false;
let cachedData = null; // { interactions, contentMap }
let activeView = { type: 'category', value: 'all' }; // or { type: 'search', query: '...' } or { type: 'topic', query: '...', id: '...' }
let allTopicPins = {}; // topicId -> [{ url, title, pinnedAt }]
let recycleBin = []; // [{ url, title, deletedAt }] — global recycle bin
let permanentDeletes = []; // [url, ...] — permanently deleted URLs
let localHides = []; // [{ url, viewKey }] — per-category local hides
let lastClickedRow = null; // for shift-click range select
let marqueeActive = false; // suppress click during marquee drag

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

// --- Topic pins (filesystem) ---
async function loadAllTopicPins() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'loadTopicPins' });
    if (response && response.success) {
      allTopicPins = response.pins || {};
    }
  } catch (error) {
    console.log('Could not load topic pins:', error.message);
  }
  return allTopicPins;
}

async function saveAllTopicPins() {
  try {
    await chrome.runtime.sendMessage({ action: 'saveTopicPins', pins: allTopicPins });
  } catch (error) {
    console.log('Could not save topic pins:', error.message);
  }
}

function isResultPinned(topicId, url) {
  const pins = allTopicPins[topicId] || [];
  return pins.some(p => p.url === url);
}

async function toggleResultPin(topicId, url, title) {
  if (!allTopicPins[topicId]) allTopicPins[topicId] = [];
  const pins = allTopicPins[topicId];
  const idx = pins.findIndex(p => p.url === url);
  if (idx !== -1) {
    pins.splice(idx, 1);
  } else {
    pins.push({ url, title, pinnedAt: Date.now() });
  }
  await saveAllTopicPins();
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

// --- Local hides (per-category) ---
async function loadLocalHides() {
  const result = await chrome.storage.local.get(['localHides']);
  localHides = result.localHides || [];
  return localHides;
}

async function saveLocalHides() {
  await chrome.storage.local.set({ localHides });
}

function isLocallyHidden(url, viewKey) {
  return localHides.some(item => item.url === url && item.viewKey === viewKey);
}

async function locallyHideItem(url, viewKey) {
  if (isLocallyHidden(url, viewKey)) return;
  localHides.push({ url, viewKey });
  await saveLocalHides();
  updateLocalRecycleBadge();
}

async function locallyRestoreItem(url, viewKey) {
  localHides = localHides.filter(item => !(item.url === url && item.viewKey === viewKey));
  await saveLocalHides();
  updateLocalRecycleBadge();
}

function getLocalHidesForCurrentView() {
  const viewKey = activeViewKey();
  return localHides.filter(item => item.viewKey === viewKey);
}

function updateLocalRecycleBadge() {
  const badge = document.getElementById('localRecycleBadge');
  const count = getLocalHidesForCurrentView().length;
  badge.textContent = count > 0 ? count : '';
}

function renderLocalRecyclePanel() {
  const list = document.getElementById('localRecyclePanelList');
  const viewKey = activeViewKey();
  const items = localHides.filter(item => item.viewKey === viewKey);

  if (items.length === 0) {
    list.innerHTML = '<div class="local-recycle-empty">No hidden items</div>';
    return;
  }

  // Try to find titles from cached data
  const data = cachedData || { interactions: [] };
  const titleMap = new Map();
  for (const i of data.interactions) {
    if (!titleMap.has(i.url)) titleMap.set(i.url, i.title);
  }

  const RESTORE_SVG = '<svg viewBox="0 0 24 24"><path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18z"/></svg>';

  list.innerHTML = items.map(item => {
    const title = titleMap.get(item.url) || item.url;
    return `<div class="local-recycle-item" data-url="${escapeHtml(item.url)}" data-view-key="${escapeHtml(item.viewKey)}">
      <div class="local-recycle-item-title" title="${escapeHtml(item.url)}">${escapeHtml(title)}</div>
      <div class="local-recycle-item-actions">
        <button class="local-restore-btn" title="Restore">${RESTORE_SVG}</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.local-restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.local-recycle-item');
      await locallyRestoreItem(row.dataset.url, row.dataset.viewKey);
      await refreshCurrentView();
      renderLocalRecyclePanel();
      document.getElementById('localRecyclePanel').classList.add('open');
    });
  });
}

function activeViewKey() {
  if (activeView.type === 'category') return `category:${activeView.value}`;
  if (activeView.type === 'topic') return `topic:${activeView.id}`;
  if (activeView.type === 'search') return `search:${activeView.query}`;
  return 'unknown';
}

// --- Layout switching (topic vs normal) ---
function showTopicLayout() {
  document.getElementById('globalRanking').style.display = 'none';
  document.getElementById('attentionChart').classList.remove('visible');
  document.getElementById('attentionChartSecondary').classList.remove('visible');
  document.getElementById('resultsWrapper').style.display = 'none';
  document.getElementById('topicLayout').classList.add('visible');
  syncAllRankingButtons();
  syncAllSortButtons();
}

function showNormalLayout() {
  document.getElementById('globalRanking').style.display = '';
  document.getElementById('resultsWrapper').style.display = '';
  document.getElementById('topicLayout').classList.remove('visible');
  syncAllRankingButtons();
  syncAllSortButtons();
}

function syncAllRankingButtons() {
  document.querySelectorAll('#globalRanking .ranking-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.algorithm) === currentAlgorithm);
  });
  document.querySelectorAll('.section-ranking[data-section="pinned"] .ranking-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.algorithm) === pinnedAlgorithm);
  });
  document.querySelectorAll('.section-ranking[data-section="related"] .ranking-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.algorithm) === relatedAlgorithm);
  });
}

function syncAllSortButtons() {
  document.querySelectorAll('#globalRanking .sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === currentSort);
  });
  document.querySelectorAll('.section-ranking[data-section="pinned"] .sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === pinnedSort);
  });
  document.querySelectorAll('.section-ranking[data-section="related"] .sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === relatedSort);
  });
}

function applySortOrder(items, sortBy) {
  if (sortBy === 'firstVisit') {
    // Sort by each item's earliest visit, most recently discovered first
    return [...items].sort((a, b) => {
      const aFirst = Math.min(...(a.timestamps || [a.latestTs || 0]));
      const bFirst = Math.min(...(b.timestamps || [b.latestTs || 0]));
      return bFirst - aFirst;
    });
  } else if (sortBy === 'lastVisit') {
    // Sort by each item's most recent visit, most recently active first
    return [...items].sort((a, b) => {
      const aLast = Math.max(...(a.timestamps || [a.latestTs || 0]));
      const bLast = Math.max(...(b.timestamps || [b.latestTs || 0]));
      return bLast - aLast;
    });
  } else if (sortBy === 'pinTime') {
    return [...items].sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  }
  return items;
}

function isDeletableView() {
  return activeView.type === 'category' && activeView.value !== 'recycleBin';
}

async function handleDelete(url, title) {
  if (activeView.type === 'category' && activeView.value === 'all') {
    // "All" → global recycle bin
    await recycleItem(url, title);
  } else {
    // Specific category → local hide
    await locallyHideItem(url, activeViewKey());
  }
}

function refreshCurrentView() {
  if (activeView.type === 'category') {
    showCategory(activeView.value);
  } else if (activeView.type === 'search' && activeView.query) {
    showSearch(activeView.query);
  } else if (activeView.type === 'topic' && activeView.query) {
    showTopic({ id: activeView.id, query: activeView.query });
  }
}

// --- Category filters ---
function filterByCategory(interactions, category) {
  const now = Date.now();
  const viewKey = `category:${category}`;
  // All non-recycleBin views exclude globally recycled items
  // Specific categories also exclude locally hidden items
  function isHidden(url) {
    return isPermanentlyDeleted(url) || isRecycled(url) || isLocallyHidden(url, viewKey);
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

function isGatewayUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    return path === '/' || path === '' || path === '/index.html' || path === '/index.htm';
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

  const maxScore = Math.max(...data.map(d => d[1]), 0.1);
  const chartHeight = 48;

  // Limit to last 60 days to avoid cramming
  const visible = data.slice(-60);

  barsEl.innerHTML = visible.map(([dateStr, score]) => {
    const barH = Math.max(2, Math.round((score / maxScore) * chartHeight));
    const dateLabel = dateStr.slice(5); // MM-DD
    return `<div class="chart-bar-group" data-date="${dateStr}" data-score="${score.toFixed(1)}">
      <div class="chart-bar" style="height: ${barH}px"></div>
      <div class="chart-date">${visible.length <= 14 ? dateLabel : ''}</div>
    </div>`;
  }).join('');

  // Show date labels for first, last, and middle if many bars
  if (visible.length > 14) {
    const groups = barsEl.querySelectorAll('.chart-bar-group');
    const show = [0, Math.floor(groups.length / 2), groups.length - 1];
    show.forEach(idx => {
      const g = groups[idx];
      if (g) g.querySelector('.chart-date').textContent = g.dataset.date.slice(5);
    });
  }

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
}

// Chart tooltip handler (shared for both charts)
function bindChartTooltip(chartEl) {
  const barsEl = chartEl.querySelector('.chart-bars');
  const tooltip = chartEl.querySelector('.chart-tooltip');
  barsEl.addEventListener('mouseover', (e) => {
    const group = e.target.closest('.chart-bar-group');
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

function renderTopicAttentionCharts(pinnedUrls, unpinnedUrls, allInteractions) {
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
  showNormalLayout();
  // Show local recycle button only in specific categories (not "all" or "recycleBin")
  const showLocalRecycle = category !== 'all' && category !== 'recycleBin';
  document.getElementById('localRecycleBtn').style.display = showLocalRecycle ? 'flex' : 'none';
  document.getElementById('localRecyclePanel').classList.remove('open');
  if (showLocalRecycle) updateLocalRecycleBadge();

  const data = cachedData || await loadData();
  const filtered = filterByCategory(data.interactions, category);
  renderAttentionChart(filtered);
  if (category === 'recycleBin') {
    displayRecycleBinRows(filtered);
  } else {
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
  document.getElementById('localRecycleBtn').style.display = 'none';
  document.getElementById('localRecyclePanel').classList.remove('open');
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
    const results = await engine.search(query, currentAlgorithm);
    renderAttentionChartForResults(results, data.interactions);
    displaySearchResults(results);
  } catch (error) {
    console.error('Search error:', error);
    displayMessage('Error performing search: ' + error.message);
  }
}

async function showTopic(topic) {
  activeView = { type: 'topic', query: topic.query, id: topic.id };
  updateSidebarActive();
  updateMainTitle(topic.query);
  document.getElementById('pinSearchBtn').style.display = 'none';
  document.getElementById('localRecycleBtn').style.display = 'none';
  document.getElementById('localRecyclePanel').classList.remove('open');
  showTopicLayout();

  try {
    await initWasm();
    const data = cachedData || await loadData();

    if (data.interactions.length === 0) {
      document.getElementById('pinnedResults').innerHTML = '<div class="no-results">No interactions recorded yet.</div>';
      document.getElementById('relatedResults').innerHTML = '';
      document.getElementById('pinnedChart').classList.remove('visible');
      document.getElementById('relatedChart').classList.remove('visible');
      return;
    }

    const engine = new SearchEngine();
    buildInteractionsForEngine(Interaction, engine, data.interactions, data.contentMap);
    const pinnedResults = await engine.search(topic.query, pinnedAlgorithm);
    const relatedResults = pinnedAlgorithm === relatedAlgorithm
      ? pinnedResults
      : await engine.search(topic.query, relatedAlgorithm);

    displayTopicSections(topic.id, pinnedResults, relatedResults, data);
  } catch (error) {
    console.error('Topic search error:', error);
    document.getElementById('pinnedResults').innerHTML = `<div class="no-results">${escapeHtml('Error: ' + error.message)}</div>`;
    document.getElementById('relatedResults').innerHTML = '';
  }
}

function displayTopicSections(topicId, pinnedSearchResults, relatedSearchResults, data) {
  const pins = allTopicPins[topicId] || [];
  const pinnedUrls = new Set(pins.map(p => p.url));
  const pinnedResultUrls = new Set(pinnedSearchResults.map(r => r.url));
  const byUrl = groupInteractionsByUrl(data.interactions);

  function enrichResult(r) {
    const group = byUrl.get(r.url) || [];
    const agg = aggregateAttention(group);
    const highlights = group.flatMap(i => {
      const att = parseAttention(i);
      return (att && att.highlights) || [];
    });
    const timestamps = group.map(i => i.timestamp);
    if (timestamps.length === 0) timestamps.push(r.timestamp || r.pinnedAt || Date.now());
    return { ...r, attScore: agg.score, attDetail: agg.detail, highlights, timestamps };
  }

  // Pinned section: search results that are pinned + pure pins (using pinnedSearchResults ordering)
  const pinnedInResults = pinnedSearchResults.filter(r => pinnedUrls.has(r.url)).map(enrichResult);
  const pinnedOnly = pins.filter(p => !pinnedResultUrls.has(p.url)).map(enrichResult);
  const allPinned = [...pinnedInResults, ...pinnedOnly];

  // Related section: non-pinned results (using relatedSearchResults ordering)
  const related = relatedSearchResults.filter(r => !pinnedUrls.has(r.url)).map(enrichResult);

  const sortedPinned = applySortOrder(allPinned, pinnedSort);
  const sortedRelated = applySortOrder(related, relatedSort);

  const allForMax = [...sortedPinned, ...sortedRelated];
  const maxAtt = Math.max(...allForMax.map(r => r.attScore), 0.1);

  // Render pinned section
  const pinnedContainer = document.getElementById('pinnedResults');
  if (sortedPinned.length === 0) {
    pinnedContainer.innerHTML = '<div class="no-results">No pinned pages. Pin results from the Related section.</div>';
  } else {
    pinnedContainer.innerHTML = sortedPinned.map(r =>
      resultRowHtml(r.title, r.url, { pinned: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps })
    ).join('');
    bindResultClicks(pinnedContainer);
    bindPinClicks(pinnedContainer, topicId);
  }

  // Render related section
  const relatedContainer = document.getElementById('relatedResults');
  if (sortedRelated.length === 0) {
    relatedContainer.innerHTML = '<div class="no-results">No related pages found</div>';
  } else {
    relatedContainer.innerHTML = sortedRelated.map(r =>
      resultRowHtml(r.title, r.url, { pinned: false, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps })
    ).join('');
    bindResultClicks(relatedContainer);
    bindPinClicks(relatedContainer, topicId);
  }

  // Render attention charts per section
  const pinnedChartInteractions = data.interactions.filter(i => pinnedUrls.has(i.url));
  const relatedUrlSet = new Set(related.map(r => r.url));
  const relatedChartInteractions = data.interactions.filter(i => relatedUrlSet.has(i.url));

  renderAttentionChartInto(
    document.getElementById('pinnedChart'),
    document.getElementById('pinnedChartBars'),
    pinnedChartInteractions,
    'Pinned pages'
  );
  renderAttentionChartInto(
    document.getElementById('relatedChart'),
    document.getElementById('relatedChartBars'),
    relatedChartInteractions,
    'Related pages'
  );
}

function displaySearchResults(results) {
  const container = document.getElementById('results');
  if (!results || results.length === 0) {
    displayMessage('No results found');
    return;
  }

  const data = cachedData || { interactions: [] };
  const byUrl = groupInteractionsByUrl(data.interactions);

  // Compute attention for each result
  const resultData = results.map(r => {
    const group = byUrl.get(r.url) || [];
    const agg = aggregateAttention(group);
    const highlights = group.flatMap(i => {
      const att = parseAttention(i);
      return (att && att.highlights) || [];
    });
    const timestamps = group.map(i => i.timestamp);
    if (timestamps.length === 0) timestamps.push(r.timestamp);
    return { ...r, attScore: agg.score, attDetail: agg.detail, highlights, timestamps };
  });

  const sorted = applySortOrder(resultData, currentSort);
  const maxAtt = Math.max(...sorted.map(r => r.attScore), 0.1);

  container.innerHTML = sorted.map(r =>
    resultRowHtml(r.title, r.url, { attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps })
  ).join('');
  bindResultClicks(container);
}

function displayInteractionRows(interactions) {
  const container = document.getElementById('results');
  if (!interactions || interactions.length === 0) {
    displayMessage('No interactions found');
    return;
  }

  const byUrl = groupInteractionsByUrl(interactions);
  // Aggregate per URL, show most recent first
  const entries = [...byUrl.entries()].map(([url, group]) => {
    const latest = group.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    const agg = aggregateAttention(group);
    const highlights = group.flatMap(i => {
      const att = parseAttention(i);
      return (att && att.highlights) || [];
    });
    const timestamps = group.map(i => i.timestamp);
    return { url, title: latest.title, attScore: agg.score, attDetail: agg.detail, highlights, timestamps, latestTs: latest.timestamp };
  });

  const sorted = applySortOrder(entries, currentSort);
  const maxAtt = Math.max(...sorted.map(e => e.attScore), 0.1);

  const deletable = isDeletableView();
  container.innerHTML = sorted.map(e =>
    resultRowHtml(e.title, e.url, { deletable, attScore: e.attScore, maxAtt, attDetail: e.attDetail, highlights: e.highlights, timestamps: e.timestamps })
  ).join('');
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
      const text = typeof h === 'string' ? h : (h.text || '');
      if (text) html += `<div class="detail-highlight-item">${escapeHtml(text)}</div>`;
    }
    html += '</div>';
  }

  return html;
}

// Lazy-load extra detail data (notes, topics, snapshots) when detail is expanded
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

  // Find belonged topics (reverse lookup)
  const topics = await loadTopics();
  const belongedTopics = [];
  for (const topic of topics) {
    const pins = allTopicPins[topic.id] || [];
    if (pins.some(p => p.url === url)) {
      belongedTopics.push(topic.query);
    }
  }

  return { highlights, snapshots, belongedTopics, slug };
}

function renderExtraDetailHtml(extra) {
  let html = '';

  if (extra.belongedTopics.length > 0) {
    html += '<div class="detail-section"><span class="detail-section-label">Topics:</span> ';
    html += extra.belongedTopics.map(t => `<span class="detail-topic-tag">${escapeHtml(t)}</span>`).join(' ');
    html += '</div>';
  }

  if (extra.highlights.length > 0) {
    html += `<div class="detail-section detail-highlights-section" data-slug="${escapeHtml(extra.slug)}"><span class="detail-section-label">Highlights:</span>`;
    for (const h of extra.highlights.slice(0, 20)) {
      const text = h.text || '';
      const note = h.note || '';
      const ts = h.timestamp || 0;
      const isGlobal = h.isGlobalNote;
      const label = isGlobal ? 'Page note' : escapeHtml(text.substring(0, 100)) + (text.length > 100 ? '...' : '');
      const noteHtml = note ? ` <span class="detail-note-text">${escapeHtml(note)}</span>` : '';
      html += `<div class="detail-highlight-entry" data-text="${escapeHtml(text)}" data-timestamp="${ts}">
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

// opts: { pinned, deletable, attScore, maxAtt, attDetail, highlights, timestamps }
function resultRowHtml(title, url, opts = {}) {
  const safeTitle = escapeHtml(title || 'Untitled');
  const safeUrl = escapeHtml(url || '');
  const { pinned, deletable = false, attScore = 0, maxAtt = 1, attDetail = null, highlights = [], timestamps = [] } = opts;

  const time = timestamps.length > 0 ? formatTimeRange(timestamps) : '';
  const normalized = maxAtt > 0 ? attScore / maxAtt : 0;
  const dotColor = attentionColor(normalized);

  const pinBtn = pinned !== undefined
    ? `<button class="result-pin${pinned ? ' pinned' : ''}" data-pin-url="${safeUrl}" data-pin-title="${safeTitle}" title="${pinned ? 'Unpin' : 'Pin'}">${PIN_SVG}</button>`
    : '';

  const detailHtml = buildDetailHtml(url, attDetail, highlights);

  return `<div class="result-item">
    <div class="result-row" data-url="${safeUrl}" data-title="${safeTitle}" draggable="true">
      <button class="result-expand" title="Show details">&#9654;</button>
      <div class="result-title">${safeTitle}</div>
      <div class="result-time">${escapeHtml(time)}</div>
      <div class="attention-dot-wrap" title="Attention: ${(normalized * 100).toFixed(0)}%">
        <div class="attention-dot" style="background: ${dotColor}"></div>
      </div>
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
        // Plain click: select only this one
        allRows.forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        lastClickedRow = row;
      }
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

function bindPinClicks(container, topicId) {
  container.querySelectorAll('.result-pin').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = btn.dataset.pinUrl;
      const title = btn.dataset.pinTitle;
      await toggleResultPin(topicId, url, title);
      // Re-render topic view
      const topic = { id: topicId, query: activeView.query };
      showTopic(topic);
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
  const labels = { all: 'All', today: 'Today', week: 'This Week', highlighted: 'Highlighted', gateways: 'Gateways', recycleBin: 'Recycle Bin' };
  return labels[category] || category;
}

function updateMainTitle(text) {
  document.getElementById('mainTitle').textContent = text;
}

function updateSidebarActive() {
  document.querySelectorAll('.sidebar-item').forEach(item => item.classList.remove('active'));

  if (activeView.type === 'category') {
    const el = document.querySelector(`.sidebar-item[data-category="${activeView.value}"]`);
    if (el) el.classList.add('active');
  } else if (activeView.type === 'topic') {
    const el = document.querySelector(`.sidebar-item[data-topic-id="${activeView.id}"]`);
    if (el) el.classList.add('active');
  }
}

// --- Topics (pinned searches) ---
async function loadTopics() {
  const result = await chrome.storage.local.get(['pinnedTopics']);
  return result.pinnedTopics || [];
}

async function saveTopics(topics) {
  await chrome.storage.local.set({ pinnedTopics: topics });
}

async function renderTopics() {
  const topics = await loadTopics();
  const list = document.getElementById('topicsList');
  const empty = document.getElementById('topicsEmpty');

  // Remove existing topic items (keep the empty placeholder)
  list.querySelectorAll('.sidebar-item').forEach(el => el.remove());

  if (topics.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  for (const topic of topics) {
    const item = document.createElement('div');
    item.className = 'sidebar-item';
    item.dataset.topicId = topic.id;
    item.innerHTML = `
      <span class="icon"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg></span>
      <span class="label">${escapeHtml(topic.query)}</span>
      <button class="remove-topic" title="Remove topic">&times;</button>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.remove-topic')) return;
      showTopic(topic);
    });

    item.querySelector('.remove-topic').addEventListener('click', async (e) => {
      e.stopPropagation();
      const topics = await loadTopics();
      const updated = topics.filter(t => t.id !== topic.id);
      await saveTopics(updated);
      // Clean up pinned results for this topic
      if (allTopicPins[topic.id]) {
        delete allTopicPins[topic.id];
        await saveAllTopicPins();
      }
      renderTopics();
      if (activeView.type === 'topic' && activeView.id === topic.id) {
        showCategory('all');
      }
    });

    // Drag-and-drop: topic as drop target (counter prevents child-triggered dragleave)
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
        if (data.url && !isResultPinned(topic.id, data.url)) {
          await toggleResultPin(topic.id, data.url, data.title);
          // If we're viewing this topic, refresh
          if (activeView.type === 'topic' && activeView.id === topic.id) {
            showTopic(topic);
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
  if (activeView.type !== 'search' || !activeView.query) return;

  const topics = await loadTopics();
  // Don't duplicate
  if (topics.some(t => t.query === activeView.query)) return;

  const topic = { id: Date.now().toString(), query: activeView.query };
  topics.push(topic);
  await saveTopics(topics);
  await renderTopics();

  // Switch to the topic view
  showTopic(topic);
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
    document.getElementById('searchInput').value = '';
    showCategory(item.dataset.category);
  });
});

// --- Event listeners: Search ---
document.getElementById('searchInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') showSearch(e.target.value);
});

// Also search on input clear (when user deletes all text and presses enter, go back to category)
document.getElementById('searchInput').addEventListener('input', (e) => {
  if (e.target.value === '' && activeView.type === 'search') {
    showCategory('all');
  }
});

// --- Event listeners: Ranking pills ---
document.querySelectorAll('.ranking-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const algo = parseInt(btn.dataset.algorithm);
    const section = btn.closest('.section-ranking');

    if (section) {
      // Section-specific ranking button
      const sectionName = section.dataset.section;
      if (sectionName === 'pinned') {
        pinnedAlgorithm = algo;
      } else if (sectionName === 'related') {
        relatedAlgorithm = algo;
      }
      // Update only this section's active state
      section.querySelectorAll('.ranking-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.algorithm) === algo);
      });
      if (activeView.type === 'topic' && activeView.query) {
        showTopic({ id: activeView.id, query: activeView.query });
      }
    } else {
      // Global ranking button (category/search views)
      currentAlgorithm = algo;
      document.querySelectorAll('#globalRanking .ranking-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.algorithm) === currentAlgorithm);
      });
      if (activeView.type === 'search' && activeView.query) {
        showSearch(activeView.query);
      }
    }
  });
});

// --- Event listeners: Sort buttons ---
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const sortVal = btn.dataset.sort;
    const section = btn.closest('.section-ranking');

    if (section) {
      const sectionName = section.dataset.section;
      if (sectionName === 'pinned') {
        pinnedSort = sortVal;
      } else if (sectionName === 'related') {
        relatedSort = sortVal;
      }
      section.querySelectorAll('.sort-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.sort === sortVal);
      });
      if (activeView.type === 'topic' && activeView.query) {
        showTopic({ id: activeView.id, query: activeView.query });
      }
    } else {
      currentSort = sortVal;
      document.querySelectorAll('#globalRanking .sort-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.sort === currentSort);
      });
      if (activeView.type === 'search' && activeView.query) {
        showSearch(activeView.query);
      } else if (activeView.type === 'category') {
        showCategory(activeView.value);
      }
    }
  });
});

// --- Event listeners: Pin search ---
document.getElementById('pinSearchBtn').addEventListener('click', pinCurrentSearch);

// --- Event listeners: Local recycle bin ---
document.getElementById('localRecycleBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = document.getElementById('localRecyclePanel');
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
  } else {
    renderLocalRecyclePanel();
    panel.classList.add('open');
  }
});

document.addEventListener('click', (e) => {
  const panel = document.getElementById('localRecyclePanel');
  const btn = document.getElementById('localRecycleBtn');
  if (panel.classList.contains('open') && !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.classList.remove('open');
  }
});

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

// --- Marquee drag-select from left gutter ---
function initMarqueeForElements(gutter, wrapper, container, scrollParent) {
  const scroller = scrollParent || wrapper;
  let band = null;
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

  gutter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const wrapperRect = wrapper.getBoundingClientRect();
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
      const currentY = ev.clientY - currentWrapperRect.top;
      const minY = Math.min(startY, currentY);
      const maxY = Math.max(startY, currentY);

      if (Math.abs(currentY - startY) > 3) didDrag = true;

      b.style.display = 'block';
      b.style.top = minY + 'px';
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

      if (!didDrag) {
        const clickY = e.clientY;
        const rows = container.querySelectorAll('.result-row');
        for (const row of rows) {
          const rowRect = row.getBoundingClientRect();
          if (clickY >= rowRect.top && clickY <= rowRect.bottom) {
            if (!additive) {
              container.querySelectorAll('.result-row.selected').forEach(r => r.classList.remove('selected'));
            }
            row.classList.add('selected');
            lastClickedRow = row;
            break;
          }
        }
      }

      setTimeout(() => { marqueeActive = false; }, 0);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Init marquee for global results
initMarqueeForElements(
  document.getElementById('selectGutter'),
  document.getElementById('resultsWrapper'),
  document.getElementById('results')
);
// Init marquee for topic sections (shared scroll parent)
const topicScroller = document.getElementById('topicLayout');
initMarqueeForElements(
  document.getElementById('pinnedGutter'),
  document.getElementById('pinnedResultsWrapper'),
  document.getElementById('pinnedResults'),
  topicScroller
);
initMarqueeForElements(
  document.getElementById('relatedGutter'),
  document.getElementById('relatedResultsWrapper'),
  document.getElementById('relatedResults'),
  topicScroller
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
      cachedData = null;
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
    cachedData = null;
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
    cachedData = null;
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

  // Load data and show default view
  await loadData();
  await loadAllTopicPins();
  await loadRecycleBin();
  await loadLocalHides();
  updateRecycleSidebarCount();
  await renderTopics();
  renderBlacklist();
  renderTrimRules();
  showCategory('all');
}

initialize();
