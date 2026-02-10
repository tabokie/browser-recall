// Import WASM module (works in popup, unlike service worker)
import init, { Interaction, SearchEngine } from './pkg/portal_extension.js';
import { mergeBufferIntoInteractions, buildInteractionsForEngine } from './search-helpers.js';

let currentAlgorithm = 0;
let wasmInitialized = false;
let searchEngine = null;
let allInteractions = [];
let contentMap = {};

// Initialize WASM
async function initWasm() {
  if (!wasmInitialized) {
    try {
      await init();
      searchEngine = new SearchEngine();
      wasmInitialized = true;
      console.log('WASM initialized in popup');
    } catch (error) {
      console.error('WASM init failed:', error);
    }
  }
}

// Load interactions from filesystem (primary) and buffer (pending writes)
async function loadInteractions() {
  try {
    // Request interactions from offscreen document (metadata only)
    const response = await chrome.runtime.sendMessage({ action: 'loadInteractions' });

    if (response && response.success) {
      allInteractions = response.interactions || [];
      console.log(`Loaded ${allInteractions.length} interactions from filesystem`);
    } else {
      console.log('Could not load from filesystem, checking buffer...');
      allInteractions = [];
    }
  } catch (error) {
    console.log('Filesystem not available:', error.message);
    allInteractions = [];
  }

  // Load content from pages/ directory
  try {
    const contentResponse = await chrome.runtime.sendMessage({ action: 'loadAllContent' });
    if (contentResponse && contentResponse.success) {
      contentMap = contentResponse.contentMap || {};
      console.log(`Loaded content for ${Object.keys(contentMap).length} pages`);
    }
  } catch (error) {
    console.log('Could not load content:', error.message);
    contentMap = {};
  }

  // Merge with write buffer (pending writes)
  return new Promise((resolve) => {
    chrome.storage.local.get(['writeBuffer'], (result) => {
      const buffer = result.writeBuffer || [];

      if (buffer.length > 0) {
        console.log(`Merging ${buffer.length} pending writes from buffer`);
        ({ interactions: allInteractions, contentMap } =
          mergeBufferIntoInteractions(allInteractions, buffer, contentMap));
      }

      console.log(`Total interactions: ${allInteractions.length}`);
      resolve(allInteractions);
    });
  });
}

// Handle ranking button clicks
document.querySelectorAll('.ranking-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ranking-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentAlgorithm = parseInt(btn.dataset.algorithm);

    // Re-run search if there's a query
    const query = document.getElementById('searchInput').value;
    if (query) {
      performSearch(query);
    }
  });
});

// Handle search
document.getElementById('searchBtn').addEventListener('click', () => {
  const query = document.getElementById('searchInput').value;
  performSearch(query);
});

document.getElementById('searchInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    const query = e.target.value;
    performSearch(query);
  }
});

async function performSearch(query) {
  if (!query.trim()) {
    displayNoResults('Enter a search query');
    return;
  }

  try {
    // Initialize WASM if not already done
    await initWasm();

    // Reload interactions (in case new ones were added)
    const interactions = await loadInteractions();

    if (interactions.length === 0) {
      displayNoResults('No interactions recorded yet. Browse some pages first!');
      return;
    }

    // Load interactions into WASM search engine
    const engine = new SearchEngine();
    buildInteractionsForEngine(Interaction, engine, interactions, contentMap);

    // Perform search
    const results = await engine.search(query, currentAlgorithm);
    console.log('Search results:', results);
    displayResults(results);
  } catch (error) {
    console.error('Search error:', error);
    displayNoResults('Error performing search: ' + error.message);
  }
}

function displayResults(results) {
  const resultsDiv = document.getElementById('results');

  if (!results || results.length === 0) {
    displayNoResults('No results found');
    return;
  }

  resultsDiv.innerHTML = results.map(result => `
    <div class="result-item" data-url="${escapeHtml(result.url)}">
      <div class="result-title">${escapeHtml(result.title)}</div>
      <div class="result-url">${escapeHtml(result.url)}</div>
      <div class="result-time">${formatTime(result.timestamp)}</div>
    </div>
  `).join('');

  // Add click handlers to open URLs
  resultsDiv.querySelectorAll('.result-item').forEach(item => {
    item.addEventListener('click', () => {
      const url = item.dataset.url;
      chrome.tabs.create({ url });
    });
  });
}

function displayNoResults(message) {
  const resultsDiv = document.getElementById('results');
  resultsDiv.innerHTML = `<div class="no-results">${escapeHtml(message)}</div>`;
}

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

// Load recent interactions on popup open
(async () => {
  await initWasm();

  const interactions = await loadInteractions();

  if (interactions.length > 0) {
    const recent = interactions.slice(-250).reverse();
    displayResults(recent);
  } else {
    displayNoResults('No interactions yet. Visit some webpages to get started!');
  }
})();
