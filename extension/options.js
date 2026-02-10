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
    case 'all':
    default:
      return interactions;
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

  // Pinned results that appear in search results
  const pinnedInResults = (results || []).filter(r => pinnedUrls.has(r.url));
  // Pinned results NOT in search results (persisted pins from filesystem)
  const pinnedOnly = pins.filter(p => !resultUrls.has(p.url));
  // Unpinned search results
  const unpinned = (results || []).filter(r => !pinnedUrls.has(r.url));

  if (pinnedInResults.length === 0 && pinnedOnly.length === 0 && unpinned.length === 0) {
    displayMessage('No results found');
    return;
  }

  let html = '';
  if (pinnedInResults.length > 0 || pinnedOnly.length > 0) {
    html += '<div class="pinned-divider">Pinned</div>';
    html += pinnedInResults.map(r => resultRowHtml(r.title, r.url, r.timestamp, true)).join('');
    html += pinnedOnly.map(p => resultRowHtml(p.title, p.url, p.pinnedAt, true)).join('');
    if (unpinned.length > 0) {
      html += '<div class="pinned-divider">Results</div>';
    }
  }
  html += unpinned.map(r => resultRowHtml(r.title, r.url, r.timestamp, false)).join('');

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

  container.innerHTML = results.map(r => resultRowHtml(r.title, r.url, r.timestamp)).join('');
  bindResultClicks(container);
}

function displayInteractionRows(interactions) {
  const container = document.getElementById('results');
  if (!interactions || interactions.length === 0) {
    displayMessage('No interactions found');
    return;
  }

  // Show most recent first
  const sorted = [...interactions].sort((a, b) => b.timestamp - a.timestamp);
  container.innerHTML = sorted.map(i => resultRowHtml(i.title, i.url, i.timestamp)).join('');
  bindResultClicks(container);
}

const PIN_SVG = '<svg viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>';

function resultRowHtml(title, url, timestamp, pinned) {
  const safeTitle = escapeHtml(title || 'Untitled');
  const safeUrl = escapeHtml(url || '');
  const time = formatTime(timestamp);
  let favicon;
  try {
    const origin = new URL(url).origin;
    favicon = `<img class="result-favicon" src="${escapeHtml(origin)}/favicon.ico" onerror="this.outerHTML='<span class=\\'result-favicon-placeholder\\'>${escapeHtml(safeTitle.charAt(0).toUpperCase())}</span>'">`;
  } catch {
    favicon = `<span class="result-favicon-placeholder">${escapeHtml(safeTitle.charAt(0).toUpperCase())}</span>`;
  }

  const pinBtn = pinned !== undefined
    ? `<button class="result-pin${pinned ? ' pinned' : ''}" data-pin-url="${safeUrl}" data-pin-title="${safeTitle}" title="${pinned ? 'Unpin' : 'Pin'}">${PIN_SVG}</button>`
    : '';

  return `<div class="result-row" data-url="${safeUrl}">
    ${favicon}
    <div class="result-info">
      <div class="result-title">${safeTitle}</div>
      <div class="result-url">${safeUrl}</div>
    </div>
    <div class="result-time">${escapeHtml(time)}</div>
    ${pinBtn}
  </div>`;
}

function bindResultClicks(container) {
  container.querySelectorAll('.result-row').forEach(row => {
    row.addEventListener('click', (e) => {
      // Don't navigate when clicking pin button
      if (e.target.closest('.result-pin')) return;
      chrome.tabs.create({ url: row.dataset.url });
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
  const labels = { all: 'All', today: 'Today', week: 'This Week', highlighted: 'Highlighted' };
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
  showCategory('all');
}

initialize();
