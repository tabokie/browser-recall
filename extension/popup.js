// Popup — current-page dashboard
import { generateSlugFromUrl } from './utils.js';

let currentSlug = '';
let currentHighlights = [];

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTimestamp(ts) {
  if (ts === 0) return 'Legacy';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function formatDuration(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Render snapshots section
function renderSnapshots(snapshots) {
  const container = document.getElementById('snapshotList');
  if (!snapshots || snapshots.length === 0) {
    container.innerHTML = '<div class="empty-state">No snapshots yet</div>';
    return;
  }

  container.innerHTML = snapshots.map(snap => `
    <div class="snapshot-row" data-ts="${snap.timestamp}">
      <span class="snapshot-time">${escapeHtml(formatTimestamp(snap.timestamp))}</span>
      <span class="snapshot-badges">
        ${snap.hasMd ? '<span class="badge">MD</span>' : ''}
        ${snap.hasHtml ? '<span class="badge">HTML</span>' : ''}
        <button class="delete-btn" data-ts="${snap.timestamp}" title="Delete snapshot">&times;</button>
      </span>
    </div>
  `).join('');

  // Attach delete handlers
  container.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ts = parseInt(btn.dataset.ts, 10);
      await chrome.runtime.sendMessage({ action: 'deleteSnapshot', slug: currentSlug, timestamp: ts });
      // Re-fetch and re-render
      const resp = await chrome.runtime.sendMessage({ action: 'listSnapshots', slug: currentSlug });
      renderSnapshots(resp?.snapshots || []);
    });
  });
}

// Render attention section
function renderAttention(interaction) {
  const container = document.getElementById('attentionGrid');

  if (!interaction || !interaction.attention) {
    container.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }

  let attention;
  try {
    attention = typeof interaction.attention === 'string'
      ? JSON.parse(interaction.attention)
      : interaction.attention;
  } catch (e) {
    container.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }

  const items = [];
  if (attention.scrollDepth !== undefined) {
    items.push(`<span class="attention-item"><strong>Scroll:</strong> ${Math.round(attention.scrollDepth)}%</span>`);
  }
  if (attention.timeOnPage !== undefined) {
    items.push(`<span class="attention-item"><strong>Time:</strong> ${formatDuration(attention.timeOnPage)}</span>`);
  }
  if (attention.clicks !== undefined) {
    items.push(`<span class="attention-item"><strong>Clicks:</strong> ${attention.clicks}</span>`);
  }
  if (attention.highlights && attention.highlights.length > 0) {
    items.push(`<span class="attention-item"><strong>Selections:</strong> ${attention.highlights.length}</span>`);
  }

  container.innerHTML = items.length > 0
    ? items.join('')
    : '<div class="empty-state">No data</div>';
}

// Render highlights section
function renderHighlights(highlights) {
  const container = document.getElementById('highlightList');
  currentHighlights = highlights || [];

  if (currentHighlights.length === 0) {
    container.innerHTML = '<div class="empty-state">No highlights</div>';
    return;
  }

  container.innerHTML = currentHighlights.map((h, i) => {
    if (h.isGlobalNote) {
      return `
        <div class="highlight-item global-note" data-index="${i}">
          <div class="highlight-label">Page Note</div>
          <textarea class="highlight-note" rows="2" placeholder="Add a page note..." data-index="${i}">${escapeHtml(h.note || '')}</textarea>
        </div>`;
    }
    return `
      <div class="highlight-item" data-index="${i}">
        <div class="highlight-text">"${escapeHtml(h.text)}"</div>
        <textarea class="highlight-note" rows="1" placeholder="Add a note..." data-index="${i}">${escapeHtml(h.note || '')}</textarea>
      </div>`;
  }).join('');

  // Save notes on change (debounced)
  let saveTimeout = null;
  container.querySelectorAll('.highlight-note').forEach(textarea => {
    textarea.addEventListener('input', () => {
      const idx = parseInt(textarea.dataset.index, 10);
      currentHighlights[idx].note = textarea.value;

      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        console.log(`[popup] Saving ${currentHighlights.length} highlights for slug=${currentSlug}`);
        try {
          const resp = await chrome.runtime.sendMessage({
            action: 'saveHighlights',
            slug: currentSlug,
            highlights: currentHighlights
          });
          if (resp && resp.success) {
            console.log('[popup] Highlights saved successfully');
          } else {
            console.error('[popup] Highlight save failed:', resp);
          }
        } catch (error) {
          console.error('[popup] Highlight save error:', error);
        }
      }, 500);
    });
  });
}

// Capture button handler
document.getElementById('captureBtn').addEventListener('click', async () => {
  const btn = document.getElementById('captureBtn');
  btn.disabled = true;
  btn.textContent = 'Capturing...';

  try {
    console.log('[popup] Capturing snapshot...');
    const resp = await chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' });
    console.log('[popup] Capture response:', resp);
    if (resp && resp.success) {
      const snapshotsResp = await chrome.runtime.sendMessage({ action: 'listSnapshots', slug: currentSlug });
      renderSnapshots(snapshotsResp?.snapshots || []);
    } else {
      console.warn('[popup] Capture failed:', resp);
    }
  } catch (error) {
    console.error('[popup] Capture error:', error);
  }

  btn.disabled = false;
  btn.textContent = '+ Capture';
});

// Initialize dashboard
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    document.getElementById('loading').textContent = 'Not available for this page';
    return;
  }

  document.getElementById('pageTitle').textContent = tab.title || 'Untitled';
  document.getElementById('pageUrl').textContent = tab.url;
  currentSlug = generateSlugFromUrl(tab.url);

  // Fetch page info from background (which queries offscreen)
  try {
    console.log(`[popup] Fetching page info for slug=${currentSlug}`);
    const info = await chrome.runtime.sendMessage({ action: 'getPageInfo', url: tab.url });
    console.log('[popup] getPageInfo response:', info);

    if (info && info.success) {
      renderSnapshots(info.snapshots);
      renderAttention(info.interaction);
      renderHighlights(info.highlights);
      console.log(`[popup] Loaded ${info.highlights?.length || 0} highlights, ${info.snapshots?.length || 0} snapshots`);
    } else {
      console.warn('[popup] getPageInfo returned failure:', info);
    }
  } catch (error) {
    console.error('[popup] Could not load page info:', error);
  }

  document.getElementById('loading').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
})();
