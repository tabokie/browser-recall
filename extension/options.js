// Options page for Portal extension
// Bookmark-manager style UI with sidebar navigation, search, and settings modal
import { FileSystemStorage } from './filesystem-storage.js';
import init, { Interaction, SearchEngine } from './pkg/portal_extension.js';
import { mergeBufferIntoInteractions, buildInteractionsForEngine } from './search-helpers.js';

const fsStorage = new FileSystemStorage();

// --- State ---
let currentAlgorithm = 0;
let wasmInitialized = false;
let cachedData = null; // { interactions, contentMap }
let activeView = { type: 'category', value: 'all' }; // or { type: 'search', query: '...' } or { type: 'topic', query: '...', id: '...' }
let allTopicPins = {}; // topicId -> [{ url, title, pinnedAt }]

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
      return interactions.filter(i => i.attention && i.attention.length > 0);
    case 'gateways':
      return interactions.filter(i => isGatewayUrl(i.url));
    case 'all':
    default:
      return interactions;
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

function renderAttentionChart(interactions) {
  const chartEl = document.getElementById('attentionChart');
  const barsEl = document.getElementById('chartBars');
  const tooltip = document.getElementById('chartTooltip');

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
    const label = dateStr.slice(5); // MM-DD
    return `<div class="chart-bar-group" data-date="${dateStr}" data-score="${score.toFixed(1)}">
      <div class="chart-bar" style="height: ${barH}px"></div>
      <div class="chart-date">${visible.length <= 14 ? label : ''}</div>
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

// Chart tooltip (bound once)
document.getElementById('chartBars').addEventListener('mouseover', (e) => {
  const group = e.target.closest('.chart-bar-group');
  const tooltip = document.getElementById('chartTooltip');
  const chartEl = document.getElementById('attentionChart');
  if (!group) { tooltip.style.display = 'none'; return; }
  tooltip.textContent = `${group.dataset.date}: ${group.dataset.score}`;
  tooltip.style.display = 'block';
  const rect = group.getBoundingClientRect();
  const chartRect = chartEl.getBoundingClientRect();
  tooltip.style.left = (rect.left - chartRect.left + rect.width / 2 - tooltip.offsetWidth / 2) + 'px';
  tooltip.style.top = (rect.top - chartRect.top - 22) + 'px';
});

document.getElementById('chartBars').addEventListener('mouseout', () => {
  document.getElementById('chartTooltip').style.display = 'none';
});

function renderAttentionChartForResults(results, allInteractions) {
  if (!results || results.length === 0) {
    document.getElementById('attentionChart').classList.remove('visible');
    return;
  }
  // Map result URLs to source interactions for attention data
  const urlSet = new Set(results.map(r => r.url));
  const matched = allInteractions.filter(i => urlSet.has(i.url));
  renderAttentionChart(matched);
}

// --- Display ---
async function showCategory(category) {
  activeView = { type: 'category', value: category };
  updateSidebarActive();
  updateMainTitle(categoryLabel(category));
  document.getElementById('pinSearchBtn').style.display = 'none';

  const data = cachedData || await loadData();
  const filtered = filterByCategory(data.interactions, category);
  renderAttentionChart(filtered);
  displayInteractionRows(filtered);
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

  try {
    await initWasm();
    const data = cachedData || await loadData();

    if (data.interactions.length === 0) {
      displayMessage('No interactions recorded yet.');
      return;
    }

    const engine = new SearchEngine();
    buildInteractionsForEngine(Interaction, engine, data.interactions, data.contentMap);
    const results = await engine.search(topic.query, currentAlgorithm);
    renderAttentionChartForResults(results, data.interactions);
    displayTopicResults(topic.id, results);
  } catch (error) {
    console.error('Topic search error:', error);
    displayMessage('Error: ' + error.message);
  }
}

function displayTopicResults(topicId, results) {
  const container = document.getElementById('results');
  const pins = allTopicPins[topicId] || [];
  const pinnedUrls = new Set(pins.map(p => p.url));
  const resultUrls = new Set((results || []).map(r => r.url));

  const data = cachedData || { interactions: [] };
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

  // Pinned results that appear in search results
  const pinnedInResults = (results || []).filter(r => pinnedUrls.has(r.url)).map(enrichResult);
  // Pinned results NOT in search results (persisted pins from filesystem)
  const pinnedOnly = pins.filter(p => !resultUrls.has(p.url)).map(enrichResult);
  // Unpinned search results
  const unpinned = (results || []).filter(r => !pinnedUrls.has(r.url)).map(enrichResult);

  const allEnriched = [...pinnedInResults, ...pinnedOnly, ...unpinned];
  if (allEnriched.length === 0) {
    displayMessage('No results found');
    return;
  }

  const maxAtt = Math.max(...allEnriched.map(r => r.attScore), 0.1);

  let html = '';
  if (pinnedInResults.length > 0 || pinnedOnly.length > 0) {
    html += '<div class="pinned-divider">Pinned</div>';
    html += pinnedInResults.map(r => resultRowHtml(r.title, r.url, { pinned: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps })).join('');
    html += pinnedOnly.map(r => resultRowHtml(r.title, r.url, { pinned: true, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps })).join('');
    if (unpinned.length > 0) {
      html += '<div class="pinned-divider">Results</div>';
    }
  }
  html += unpinned.map(r => resultRowHtml(r.title, r.url, { pinned: false, attScore: r.attScore, maxAtt, attDetail: r.attDetail, highlights: r.highlights, timestamps: r.timestamps })).join('');

  container.innerHTML = html;
  bindResultClicks(container);
  bindPinClicks(container, topicId);
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

  const maxAtt = Math.max(...resultData.map(r => r.attScore), 0.1);

  container.innerHTML = resultData.map(r =>
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
  }).sort((a, b) => b.latestTs - a.latestTs);

  const maxAtt = Math.max(...entries.map(e => e.attScore), 0.1);

  container.innerHTML = entries.map(e =>
    resultRowHtml(e.title, e.url, { attScore: e.attScore, maxAtt, attDetail: e.attDetail, highlights: e.highlights, timestamps: e.timestamps })
  ).join('');
  bindResultClicks(container);
}

const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>';
const EYE_SVG = '<svg class="attention-eye" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';

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

// opts: { pinned, attScore, maxAtt, attDetail, highlights, timestamps }
function resultRowHtml(title, url, opts = {}) {
  const safeTitle = escapeHtml(title || 'Untitled');
  const safeUrl = escapeHtml(url || '');
  const { pinned, attScore = 0, maxAtt = 1, attDetail = null, highlights = [], timestamps = [] } = opts;

  const time = timestamps.length > 0 ? formatTimeRange(timestamps) : '';
  const normalized = maxAtt > 0 ? attScore / maxAtt : 0;
  const dotColor = attentionColor(normalized);

  const pinBtn = pinned !== undefined
    ? `<button class="result-pin${pinned ? ' pinned' : ''}" data-pin-url="${safeUrl}" data-pin-title="${safeTitle}" title="${pinned ? 'Unpin' : 'Pin'}">${PIN_SVG}</button>`
    : '';

  const detailHtml = buildDetailHtml(url, attDetail, highlights);

  return `<div class="result-item">
    <div class="result-row" data-url="${safeUrl}" data-title="${safeTitle}" draggable="true">
      <div class="result-title">${safeTitle}</div>
      <div class="result-time">${escapeHtml(time)}</div>
      <div class="attention-dot-wrap" title="Attention: ${(normalized * 100).toFixed(0)}%">
        <div class="attention-dot" style="background: ${dotColor}"></div>
        ${EYE_SVG}
      </div>
      ${pinBtn}
    </div>
    <div class="result-detail">${detailHtml}</div>
  </div>`;
}

function bindResultClicks(container) {
  container.querySelectorAll('.result-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.result-pin')) return;
      if (e.target.closest('.attention-dot-wrap')) return;
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
  // Eye toggle for inline detail
  container.querySelectorAll('.attention-dot-wrap').forEach(dot => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = dot.closest('.result-item');
      if (item) {
        const detail = item.querySelector('.result-detail');
        if (detail) detail.classList.toggle('open');
      }
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
  document.getElementById('results').innerHTML =
    `<div class="no-results">${escapeHtml(msg)}</div>`;
}

function categoryLabel(category) {
  const labels = { all: 'All', today: 'Today', week: 'This Week', highlighted: 'Highlighted', gateways: 'Gateways' };
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
    document.querySelectorAll('.ranking-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentAlgorithm = parseInt(btn.dataset.algorithm);

    // Re-run current search/topic if active
    if (activeView.type === 'search' && activeView.query) {
      showSearch(activeView.query);
    } else if (activeView.type === 'topic' && activeView.query) {
      showTopic({ id: activeView.id, query: activeView.query });
    }
  });
});

// --- Event listeners: Pin search ---
document.getElementById('pinSearchBtn').addEventListener('click', pinCurrentSearch);

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
async function loadBlacklist() {
  const result = await chrome.storage.local.get(['urlBlacklist']);
  return result.urlBlacklist || [];
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
  remove_brackets: 'Remove [brackets]'
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
  await renderTopics();
  renderBlacklist();
  renderTrimRules();
  showCategory('all');
}

initialize();
