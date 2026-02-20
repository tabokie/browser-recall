// Popup — current-page dashboard
import { generateSlugFromUrl, generateSlugFromTitle, loadSettingsValue, saveSettingsValue } from './utils.js';

let currentSlug = '';
let currentHighlights = [];
let currentInteraction = null;
let currentUrl = '';
let currentTitle = '';
let currentTab = null;
let detachedContent = null; // holds dashboardContent when removed in private mode

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
        ${snap.hasMd ? `<span class="badge md" data-ts="${snap.timestamp}">MD</span>` : ''}
        ${snap.hasHtml ? `<span class="badge html" data-ts="${snap.timestamp}">HTML</span>` : ''}
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

  // Double-click to open snapshot in new tab
  container.querySelectorAll('.snapshot-row').forEach(row => {
    row.addEventListener('dblclick', async () => {
      const ts = parseInt(row.dataset.ts, 10);
      const resp = await chrome.runtime.sendMessage({ action: 'getSnapshotUrl', slug: currentSlug, timestamp: ts });
      if (resp?.success) chrome.tabs.create({ url: resp.url });
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
    const displayText = Array.isArray(h.text) ? h.text.join(' ') : h.text;
    return `
      <div class="highlight-item" data-index="${i}">
        <div class="highlight-header">
          <div class="highlight-text">"${escapeHtml(displayText)}"</div>
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
        // Tell content script to remove the visual mark(s)
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && h.text) {
          chrome.tabs.sendMessage(tab.id, { action: 'removeHighlightMark', text: h.text, timestamp: h.timestamp }).catch(() => {});
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

// Collections — pin current page to collections
async function loadCollections() {
  return await loadSettingsValue('collections', []);
}

async function loadCollectionPins() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'loadCollectionPins' });
    return (resp && resp.success) ? (resp.pins || {}) : {};
  } catch { return {}; }
}

async function saveCollectionPins(allPins) {
  try {
    await chrome.runtime.sendMessage({ action: 'saveCollectionPins', pins: allPins });
  } catch (error) {
    console.error('[popup] Failed to save collection pins:', error);
  }
}

function isPagePinned(allPins, collectionId, url) {
  const pins = allPins[collectionId] || [];
  return pins.some(p => p.url === url);
}

async function renderCollectionChips() {
  const container = document.getElementById('collectionChips');
  const [collections, allPins] = await Promise.all([loadCollections(), loadCollectionPins()]);

  // Compute lastActivity for each collection and sort by most recent
  const ranked = collections.map(collection => {
    const pins = allPins[collection.id] || [];
    const maxPinnedAt = pins.reduce((max, p) => Math.max(max, p.pinnedAt || 0), 0);
    const lastActivity = maxPinnedAt || parseInt(collection.id) || 0;
    return { collection, lastActivity };
  });
  ranked.sort((a, b) => b.lastActivity - a.lastActivity);
  const topCollections = ranked.slice(0, 5);

  let html = topCollections.map(({ collection }) => {
    const pinned = isPagePinned(allPins, collection.id, currentUrl);
    return `<span class="collection-chip${pinned ? ' selected' : ''}" data-collection-id="${collection.id}">
      <span class="collection-chip-check">${pinned ? '&#10003;' : ''}</span>
      ${escapeHtml(collection.name || collection.query)}
    </span>`;
  }).join('');

  html += `<span class="collection-add-btn" id="collectionAddBtn" title="Add to collection">+</span>`;

  container.innerHTML = html;

  // Toggle existing chips
  container.querySelectorAll('.collection-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const collectionId = chip.dataset.collectionId;
      await toggleCollectionPin(collectionId);
      renderCollectionChips();
    });
  });

  // + button opens picker dropdown
  document.getElementById('collectionAddBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openCollectionPicker(collections, allPins);
  });
}

async function toggleCollectionPin(collectionId) {
  const freshPins = await loadCollectionPins();
  if (!freshPins[collectionId]) freshPins[collectionId] = [];
  const pins = freshPins[collectionId];
  const idx = pins.findIndex(p => p.url === currentUrl);

  if (idx !== -1) {
    pins.splice(idx, 1);
  } else {
    pins.push({ url: currentUrl, title: currentTitle, pinnedAt: Date.now() });
  }

  await saveCollectionPins(freshPins);
}

function closeCollectionPicker() {
  const existing = document.getElementById('collectionPicker');
  if (existing) existing.remove();
  document.removeEventListener('click', pickerOutsideClickHandler);
}

function pickerOutsideClickHandler(e) {
  const picker = document.getElementById('collectionPicker');
  if (picker && !picker.contains(e.target) && e.target.id !== 'collectionAddBtn') {
    closeCollectionPicker();
  }
}

function openCollectionPicker(collections, allPins) {
  // Close if already open
  if (document.getElementById('collectionPicker')) {
    closeCollectionPicker();
    return;
  }

  const wrap = document.querySelector('.collection-chips-wrap');
  const picker = document.createElement('div');
  picker.className = 'collection-picker';
  picker.id = 'collectionPicker';
  picker.innerHTML = `
    <input class="collection-picker-input" id="collectionPickerInput" placeholder="Search or create..." />
    <div class="collection-picker-list" id="collectionPickerList"></div>
  `;
  wrap.appendChild(picker);

  const input = document.getElementById('collectionPickerInput');
  const list = document.getElementById('collectionPickerList');

  function renderPickerRows() {
    const query = input.value.trim().toLowerCase();
    const filtered = query
      ? collections.filter(c => (c.name || c.query).toLowerCase().includes(query))
      : collections;

    let rowsHtml = filtered.map(c => {
      const pinned = isPagePinned(allPins, c.id, currentUrl);
      return `<div class="collection-picker-row${pinned ? ' selected' : ''}" data-collection-id="${c.id}">
        <span class="collection-picker-row-check">${pinned ? '&#10003;' : ''}</span>
        <span>${escapeHtml(c.name || c.query)}</span>
      </div>`;
    }).join('');

    // Show create option if input doesn't exactly match any existing collection
    const inputVal = input.value.trim();
    if (inputVal) {
      const exactMatch = collections.some(c =>
        (c.name || c.query).toLowerCase() === inputVal.toLowerCase()
      );
      if (!exactMatch) {
        rowsHtml += `<div class="collection-picker-create" id="collectionPickerCreate">Create "${escapeHtml(inputVal)}"</div>`;
      }
    }

    if (!rowsHtml) {
      rowsHtml = `<div style="padding: 8px 10px; font-size: 11px; color: #999; text-align: center;">No collections</div>`;
    }

    list.innerHTML = rowsHtml;

    // Attach click handlers to rows
    list.querySelectorAll('.collection-picker-row').forEach(row => {
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        const collectionId = row.dataset.collectionId;
        await toggleCollectionPin(collectionId);
        // Refresh allPins and re-render rows in place
        const freshPins = await loadCollectionPins();
        Object.assign(allPins, freshPins);
        renderPickerRows();
      });
    });

    const createBtn = document.getElementById('collectionPickerCreate');
    if (createBtn) {
      createBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await createCollectionAndPin(inputVal);
        closeCollectionPicker();
        renderCollectionChips();
      });
    }
  }

  renderPickerRows();
  // Use setTimeout to avoid the click event that opened the picker from immediately focusing away
  setTimeout(() => input.focus(), 0);

  input.addEventListener('input', renderPickerRows);

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const inputVal = input.value.trim();
      if (!inputVal) return;
      const exactMatch = collections.find(c =>
        (c.name || c.query).toLowerCase() === inputVal.toLowerCase()
      );
      if (exactMatch) {
        await toggleCollectionPin(exactMatch.id);
        closeCollectionPicker();
        renderCollectionChips();
      } else {
        await createCollectionAndPin(inputVal);
        closeCollectionPicker();
        renderCollectionChips();
      }
    } else if (e.key === 'Escape') {
      closeCollectionPicker();
    }
  });

  // Close on outside click (deferred to avoid catching the opening click)
  setTimeout(() => {
    document.addEventListener('click', pickerOutsideClickHandler);
  }, 0);
}

async function createCollectionAndPin(query) {
  const collections = await loadCollections();
  if (collections.some(c => c.query === query)) return;

  const collectionId = generateSlugFromTitle(query);
  await chrome.runtime.sendMessage({ action: 'saveCollectionMeta', collectionId, name: query, query });
  const { collectionOrder: order = [] } = await chrome.storage.session.get(['collectionOrder']);
  await saveSettingsValue('collectionOrder', [...order, collectionId]);

  await chrome.runtime.sendMessage({
    action: 'saveCollectionPinsById',
    collectionId,
    pins: [{ url: currentUrl, title: currentTitle, pinnedAt: Date.now() }]
  });

  console.log('[popup] Created collection and pinned page:', query);
}

// Workspace mode
async function loadWorkspace() {
  const ws = await loadSettingsValue('workspace', {});
  return { mode: 'default', collectionIds: [], autoSnapshot: false, ...ws };
}

async function saveWorkspace(workspace) {
  await saveSettingsValue('workspace', workspace);
}

async function renderWorkspaceBar() {
  const workspace = await loadWorkspace();
  const collections = await loadCollections();

  const bar = document.getElementById('workspaceBar');
  const triToggle = document.getElementById('triToggle');
  const config = document.getElementById('workspaceConfig');
  const collectionsContainer = document.getElementById('workspaceCollections');
  const autoSnapshotCheckbox = document.getElementById('workspaceAutoSnapshot');

  autoSnapshotCheckbox.checked = workspace.autoSnapshot;

  // Update toggle and bar mode classes
  bar.classList.remove('mode-workspace', 'mode-private');
  triToggle.classList.remove('mode-workspace', 'mode-private');
  if (workspace.mode === 'workspace') {
    bar.classList.add('mode-workspace');
    triToggle.classList.add('mode-workspace');
    config.style.display = 'block';
  } else if (workspace.mode === 'private') {
    bar.classList.add('mode-private');
    triToggle.classList.add('mode-private');
    config.style.display = 'none';
  } else {
    config.style.display = 'none';
  }

  // Render collection selection chips
  if (collections.length === 0) {
    collectionsContainer.innerHTML = '<span class="workspace-empty">No collections yet. Create one in Notes section.</span>';
  } else {
    collectionsContainer.innerHTML = collections.map(collection => {
      const selected = workspace.collectionIds.includes(collection.id);
      return `<span class="ws-collection-chip${selected ? ' selected' : ''}" data-collection-id="${collection.id}">${escapeHtml(collection.name || collection.query)}</span>`;
    }).join('');

    collectionsContainer.querySelectorAll('.ws-collection-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const collectionId = chip.dataset.collectionId;
        const ws = await loadWorkspace();
        const idx = ws.collectionIds.indexOf(collectionId);
        if (idx !== -1) {
          ws.collectionIds.splice(idx, 1);
        } else {
          ws.collectionIds.push(collectionId);
        }
        await saveWorkspace(ws);
        renderWorkspaceBar();
      });
    });
  }
}

// Three-way toggle handler
document.getElementById('triToggle').addEventListener('click', async (e) => {
  const zone = e.target.closest('[data-mode]');
  if (!zone) return;
  const ws = await loadWorkspace();
  const wasPrivate = ws.mode === 'private';
  let newMode = zone.dataset.mode;
  // Clicking the already-active zone resets to default
  if (newMode === ws.mode) newMode = 'default';
  ws.mode = newMode;
  if (newMode !== 'workspace') {
    ws.collectionIds = [];
    ws.autoSnapshot = false;
  }
  await saveWorkspace(ws);
  await renderWorkspaceBar();

  // Exiting private mode: record the current page visit and show details
  if (wasPrivate && newMode !== 'private' && currentTab) {
    const slug = generateSlugFromUrl(currentTab.url);
    const timestamp = Date.now();
    await chrome.runtime.sendMessage({
      action: 'enqueueInteraction',
      entry: {
        interaction: {
          timestamp,
          url: currentTab.url,
          title: currentTab.title || 'Untitled',
          intent: '',
          attention: '',
          slug
        },
        markdown: '',
        html: ''
      }
    });
    await showDashboard(currentTab);
  }

  // Entering private mode: remove page details from DOM
  if (newMode === 'private') {
    const content = document.getElementById('dashboardContent');
    if (content) {
      detachedContent = content;
      content.remove();
    }
  }
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
          action: 'enqueueInteraction',
          entry: { interaction: currentInteraction, markdown: '', html: '' }
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

// Show dashboard for a tab: set up state, fetch data, render sections
async function showDashboard(tab) {
  // Re-attach dashboardContent if it was removed (e.g. exiting private mode)
  if (detachedContent && !document.getElementById('dashboardContent')) {
    document.getElementById('dashboard').appendChild(detachedContent);
    detachedContent = null;
  }

  currentUrl = tab.url;
  currentTitle = tab.title || 'Untitled';
  document.getElementById('pageTitle').textContent = currentTitle;
  document.getElementById('pageUrl').textContent = tab.url;
  currentSlug = generateSlugFromUrl(tab.url);

  // Build a fallback interaction from tab info
  currentInteraction = {
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

  // Render collection chips and workspace bar
  await Promise.all([renderCollectionChips(), renderWorkspaceBar()]);

  document.getElementById('loading').style.display = 'none';
  document.getElementById('blacklisted').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  document.getElementById('dashboardContent').style.display = 'block';

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
        url: tab.url,
        intent: '',
        attention: '',
        slug: currentSlug
      };
      interaction.title = freshTitle;
      interaction.timestamp = Date.now();

      await chrome.runtime.sendMessage({
        action: 'enqueueInteraction',
        entry: { interaction, markdown: '', html: '' }
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

// Initialize dashboard
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    document.getElementById('loading').textContent = 'Not available for this page';
    return;
  }

  currentTab = tab;

  // Private mode: show only the toggle bar, remove page details entirely
  const wsCheck = await loadWorkspace();
  if (wsCheck.mode === 'private') {
    await renderWorkspaceBar();
    const content = document.getElementById('dashboardContent');
    detachedContent = content;
    content.remove();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    return;
  }

  // Skip blacklist if the page has visit history (previously captured and not deleted)
  let hasVisitHistory = false;
  try {
    const [resp, binData] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'loadInteractionByUrl', url: tab.url }),
      chrome.storage.session.get(['recycleBin', 'permanentDeletes'])
    ]);
    const recycled = (binData.recycleBin || []).some(item => item.url === tab.url);
    const permDeleted = (binData.permanentDeletes || []).includes(tab.url);
    hasVisitHistory = !!(resp && resp.interaction) && !recycled && !permDeleted;
  } catch {}

  // Check blacklist only for pages with no visit history
  const { urlBlacklist } = await chrome.storage.session.get(['urlBlacklist']);
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
          timestamp,
          url: tab.url,
          title: tab.title || 'Untitled',
          intent: '',
          attention: '',
          slug
        };
        await chrome.runtime.sendMessage({
          action: 'enqueueInteraction',
          entry: { interaction, markdown: '', html: '' }
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
