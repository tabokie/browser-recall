// Popup — current-page dashboard
import { generateSlugFromUrl } from './utils.js';

let currentSlug = '';
let currentHighlights = [];
let currentInteraction = null;
let currentUrl = '';
let currentTitle = '';

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function autoResizeTextarea(textarea) {
  textarea.style.height = '0';
  textarea.style.height = textarea.scrollHeight + 'px';
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

  // Populate the dedicated page-note input from global note entry
  const pageNoteEl = document.getElementById('pageNote');
  const globalNote = currentHighlights.find(h => h.isGlobalNote);
  pageNoteEl.value = globalNote?.note || '';

  // Only show non-global highlights in the list
  const textHighlights = currentHighlights.filter(h => !h.isGlobalNote);

  if (textHighlights.length === 0) {
    container.innerHTML = '<div class="empty-state">No highlights</div>';
    return;
  }

  container.innerHTML = textHighlights.map(h => {
    const i = currentHighlights.indexOf(h);
    return `
      <div class="highlight-item" data-index="${i}">
        <div class="highlight-header">
          <div class="highlight-text">"${escapeHtml(h.text)}"</div>
          <button class="highlight-delete" data-index="${i}" title="Delete">&times;</button>
        </div>
        <textarea class="highlight-note" placeholder="Add a note..." data-index="${i}">${escapeHtml(h.note || '')}</textarea>
      </div>`;
  }).join('');

  // Delete highlight
  container.querySelectorAll('.highlight-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const h = currentHighlights[idx];
      if (!h) return;

      try {
        await chrome.runtime.sendMessage({
          action: 'deleteHighlight',
          slug: currentSlug,
          text: h.text || '',
          timestamp: h.timestamp || 0
        });
        // Tell content script to remove the visual mark
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && h.text) {
          chrome.tabs.sendMessage(tab.id, { action: 'removeHighlightMark', text: h.text }).catch(() => {});
        }
      } catch (e) {
        console.error('[popup] Delete highlight error:', e);
      }

      currentHighlights.splice(idx, 1);
      renderHighlights(currentHighlights);
    });
  });

  // Save notes on change (debounced)
  let saveTimeout = null;
  container.querySelectorAll('.highlight-note').forEach(textarea => {
    textarea.addEventListener('input', () => {
      autoResizeTextarea(textarea);
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

// Page-note auto-save (debounced)
let pageNoteSaveTimeout = null;
document.getElementById('pageNote').addEventListener('input', (e) => {
  autoResizeTextarea(e.target);
  clearTimeout(pageNoteSaveTimeout);
  pageNoteSaveTimeout = setTimeout(async () => {
    const note = document.getElementById('pageNote').value;
    const globalIdx = currentHighlights.findIndex(h => h.isGlobalNote);
    if (globalIdx !== -1) {
      currentHighlights[globalIdx].note = note;
    } else {
      currentHighlights.push({ text: '', note, timestamp: Date.now(), isGlobalNote: true });
    }
    try {
      await chrome.runtime.sendMessage({
        action: 'saveHighlights',
        slug: currentSlug,
        highlights: currentHighlights
      });
    } catch (error) {
      console.error('[popup] Page note save error:', error);
    }
  }, 500);
});

// Topics — pin current page to topics
async function loadTopics() {
  const result = await chrome.storage.local.get(['pinnedTopics']);
  return result.pinnedTopics || [];
}

async function loadTopicPins() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'loadTopicPins' });
    return (resp && resp.success) ? (resp.pins || {}) : {};
  } catch { return {}; }
}

async function saveTopicPins(allPins) {
  try {
    await chrome.runtime.sendMessage({ action: 'saveTopicPins', pins: allPins });
  } catch (error) {
    console.error('[popup] Failed to save topic pins:', error);
  }
}

function isPagePinned(allPins, topicId, url) {
  const pins = allPins[topicId] || [];
  return pins.some(p => p.url === url);
}

async function renderTopicChips() {
  const container = document.getElementById('topicChips');
  const [topics, allPins] = await Promise.all([loadTopics(), loadTopicPins()]);

  let html = topics.map(topic => {
    const pinned = isPagePinned(allPins, topic.id, currentUrl);
    return `<span class="topic-chip${pinned ? ' selected' : ''}" data-topic-id="${topic.id}" data-topic-query="${escapeHtml(topic.query)}">
      <span class="topic-chip-check">${pinned ? '&#10003;' : ''}</span>
      ${escapeHtml(topic.query)}
    </span>`;
  }).join('');

  html += `<span class="topic-new">
    <input class="topic-new-input" id="topicNewInput" placeholder="+ New topic" />
  </span>`;

  container.innerHTML = html;

  // Toggle existing topics
  container.querySelectorAll('.topic-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const topicId = chip.dataset.topicId;
      const freshPins = await loadTopicPins();
      if (!freshPins[topicId]) freshPins[topicId] = [];
      const pins = freshPins[topicId];
      const idx = pins.findIndex(p => p.url === currentUrl);

      if (idx !== -1) {
        pins.splice(idx, 1);
      } else {
        pins.push({ url: currentUrl, title: currentTitle, pinnedAt: Date.now() });
      }

      await saveTopicPins(freshPins);
      renderTopicChips();
    });
  });

  // Create new topic
  const newInput = document.getElementById('topicNewInput');
  newInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const query = newInput.value.trim();
      if (!query) return;

      const topics = await loadTopics();
      if (topics.some(t => t.query === query)) {
        newInput.value = '';
        return;
      }

      const topicId = Date.now().toString();
      topics.push({ id: topicId, query });
      await chrome.storage.local.set({ pinnedTopics: topics });

      // Also pin the current page to the new topic
      const freshPins = await loadTopicPins();
      freshPins[topicId] = [{ url: currentUrl, title: currentTitle, pinnedAt: Date.now() }];
      await saveTopicPins(freshPins);

      console.log('[popup] Created topic and pinned page:', query);
      renderTopicChips();
    } else if (e.key === 'Escape') {
      newInput.value = '';
      newInput.blur();
    }
  });
}

// Workspace mode
async function loadWorkspace() {
  const result = await chrome.storage.local.get(['workspace']);
  return result.workspace || { enabled: false, topicIds: [], autoSnapshot: false };
}

async function saveWorkspace(workspace) {
  await chrome.storage.local.set({ workspace });
}

async function renderWorkspaceBar() {
  const workspace = await loadWorkspace();
  const topics = await loadTopics();

  const bar = document.getElementById('workspaceBar');
  const toggle = document.getElementById('workspaceToggle');
  const config = document.getElementById('workspaceConfig');
  const topicsContainer = document.getElementById('workspaceTopics');
  const autoSnapshotCheckbox = document.getElementById('workspaceAutoSnapshot');

  toggle.checked = workspace.enabled;
  autoSnapshotCheckbox.checked = workspace.autoSnapshot;

  if (workspace.enabled) {
    bar.classList.add('active');
    config.style.display = 'block';
  } else {
    bar.classList.remove('active');
    config.style.display = 'none';
  }

  // Render topic selection chips
  if (topics.length === 0) {
    topicsContainer.innerHTML = '<span class="workspace-empty">No topics yet. Create one in Notes section.</span>';
  } else {
    topicsContainer.innerHTML = topics.map(topic => {
      const selected = workspace.topicIds.includes(topic.id);
      return `<span class="ws-topic-chip${selected ? ' selected' : ''}" data-topic-id="${topic.id}">${escapeHtml(topic.query)}</span>`;
    }).join('');

    topicsContainer.querySelectorAll('.ws-topic-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const topicId = chip.dataset.topicId;
        const ws = await loadWorkspace();
        const idx = ws.topicIds.indexOf(topicId);
        if (idx !== -1) {
          ws.topicIds.splice(idx, 1);
        } else {
          ws.topicIds.push(topicId);
        }
        await saveWorkspace(ws);
        renderWorkspaceBar();
      });
    });
  }
}

// Workspace toggle handler
document.getElementById('workspaceToggle').addEventListener('change', async (e) => {
  const ws = await loadWorkspace();
  ws.enabled = e.target.checked;
  if (!ws.enabled) {
    ws.topicIds = [];
    ws.autoSnapshot = false;
  }
  await saveWorkspace(ws);
  renderWorkspaceBar();
});

// Auto-snapshot toggle handler
document.getElementById('workspaceAutoSnapshot').addEventListener('change', async (e) => {
  const ws = await loadWorkspace();
  ws.autoSnapshot = e.target.checked;
  await saveWorkspace(ws);
});

// Title editing
function startEditingTitle() {
  const titleEl = document.getElementById('pageTitle');
  const currentTitle = titleEl.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'page-title-input';
  input.value = currentTitle;

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  async function saveTitle() {
    const newTitle = input.value.trim() || currentTitle;
    const newTitleEl = document.createElement('div');
    newTitleEl.className = 'page-title';
    newTitleEl.id = 'pageTitle';
    newTitleEl.textContent = newTitle;
    newTitleEl.addEventListener('click', startEditingTitle);
    input.replaceWith(newTitleEl);

    if (newTitle !== currentTitle && currentInteraction) {
      currentInteraction.title = newTitle;
      currentInteraction.timestamp = Date.now();
      try {
        await chrome.runtime.sendMessage({
          action: 'writeInteraction',
          interaction: currentInteraction,
          markdown: '',
          html: ''
        });
        console.log('[popup] Title updated to:', newTitle);
      } catch (error) {
        console.error('[popup] Failed to save title:', error);
      }
    }
  }

  input.addEventListener('blur', saveTitle);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = currentTitle;
      input.blur();
    }
  });
}

document.getElementById('pageTitle').addEventListener('click', startEditingTitle);

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

  // Show dashboard for a tab: set up state, fetch data, render sections
  async function showDashboard(tab) {
    currentUrl = tab.url;
    currentTitle = tab.title || 'Untitled';
    document.getElementById('pageTitle').textContent = currentTitle;
    document.getElementById('pageUrl').textContent = tab.url;
    currentSlug = generateSlugFromUrl(tab.url);

    // Build a fallback interaction from tab info
    currentInteraction = {
      id: tab.url,
      timestamp: Date.now(),
      url: tab.url,
      title: tab.title || 'Untitled',
      intent: '',
      attention: '',
      slug: currentSlug
    };

    // Fetch page info from background (which queries offscreen)
    try {
      console.log(`[popup] Fetching page info for slug=${currentSlug}`);
      const info = await chrome.runtime.sendMessage({ action: 'getPageInfo', url: tab.url });
      console.log('[popup] getPageInfo response:', info);

      if (info && info.success) {
        if (info.interaction) {
          currentInteraction = info.interaction;
          // Use stored title if available
          currentTitle = info.interaction.title || tab.title || 'Untitled';
          document.getElementById('pageTitle').textContent = currentTitle;
        }
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

    // Render topic chips and workspace bar
    await Promise.all([renderTopicChips(), renderWorkspaceBar()]);

    document.getElementById('loading').style.display = 'none';
    document.getElementById('blacklisted').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';

    // Auto-resize note textareas now that the dashboard is visible
    requestAnimationFrame(() => {
      autoResizeTextarea(document.getElementById('pageNote'));
      document.querySelectorAll('.highlight-note').forEach(ta => autoResizeTextarea(ta));
    });

    // Re-check tab title after 1s — some sites set a generic title initially
    const initialTitle = tab.title || 'Untitled';
    setTimeout(async () => {
      try {
        const [freshTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!freshTab || freshTab.id !== tab.id) return;

        const freshTitle = freshTab.title || 'Untitled';
        if (freshTitle === initialTitle) return;

        // Only auto-update if the displayed title still matches the initial tab title
        const titleEl = document.getElementById('pageTitle');
        if (!titleEl || titleEl.textContent !== initialTitle) return;

        titleEl.textContent = freshTitle;

        // Load stored interaction to preserve existing fields, or build a fresh one
        const resp = await chrome.runtime.sendMessage({ action: 'loadInteractionByUrl', url: tab.url });
        const interaction = (resp && resp.interaction) || {
          id: tab.url,
          url: tab.url,
          intent: '',
          attention: '',
          slug: currentSlug
        };
        interaction.title = freshTitle;
        interaction.timestamp = Date.now();

        await chrome.runtime.sendMessage({
          action: 'writeInteraction',
          interaction,
          markdown: '',
          html: ''
        });
        // Keep currentInteraction in sync if it exists
        if (currentInteraction) {
          currentInteraction.title = freshTitle;
        }
        console.log('[popup] Auto-updated title to:', freshTitle);
      } catch (error) {
        console.warn('[popup] Title re-check failed:', error);
      }
    }, 1000);
  }

  // Skip blacklist if the page has visit history (previously captured and not deleted)
  let hasVisitHistory = false;
  try {
    const [resp, binData] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'loadInteractionByUrl', url: tab.url }),
      chrome.storage.local.get(['recycleBin', 'permanentDeletes'])
    ]);
    const recycled = (binData.recycleBin || []).some(item => item.url === tab.url);
    const permDeleted = (binData.permanentDeletes || []).includes(tab.url);
    hasVisitHistory = !!(resp && resp.interaction) && !recycled && !permDeleted;
  } catch {}

  // Check blacklist only for pages with no visit history
  const { urlBlacklist } = await chrome.storage.local.get(['urlBlacklist']);
  const blacklist = urlBlacklist ?? ['chrome://', 'edge://'];
  if (!hasVisitHistory && blacklist.some(prefix => tab.url.startsWith(prefix))) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('blacklistedUrl').textContent = tab.url;
    document.getElementById('blacklisted').style.display = 'block';
    document.getElementById('blacklistSettingsLink').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    // "Capture It" — write interaction + snapshot, then show dashboard (visit history will bypass blacklist next time)
    document.getElementById('captureOnceBtn').addEventListener('click', async () => {
      const btn = document.getElementById('captureOnceBtn');
      btn.disabled = true;
      btn.textContent = 'Capturing...';

      try {
        const slug = generateSlugFromUrl(tab.url);
        const timestamp = Date.now();

        // Write interaction record
        const interaction = {
          id: tab.url,
          timestamp,
          url: tab.url,
          title: tab.title || 'Untitled',
          intent: '',
          attention: '',
          slug
        };
        await chrome.runtime.sendMessage({
          action: 'writeInteraction',
          interaction,
          markdown: '',
          html: ''
        });

        // Capture snapshot (content script extracts page, background forwards to offscreen)
        await chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' });

        console.log('[popup] Capture once completed for blacklisted page');
      } catch (error) {
        console.error('[popup] Capture once failed:', error);
      }

      // Transition to full dashboard
      await showDashboard(tab);
    });

    return;
  }

  await showDashboard(tab);
})();
