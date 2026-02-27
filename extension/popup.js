// Popup — current-page dashboard
import { generateSlugFromUrl, generateSlugFromTitle, loadSettingsValue, readCacheable, saveSettingsValue } from './utils.js';

let currentSlug = '';
let currentNotes = [];
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

// Render notes section
function renderNotes(notes) {
  const container = document.getElementById('highlightList');
  currentNotes = notes || [];

  // Populate the dedicated page-note input from global note entry (excerpt: null)
  const pageNoteEl = document.getElementById('pageNote');
  const globalNote = currentNotes.find(n => n.excerpt === null);
  pageNoteEl.value = globalNote?.note || '';
  pageNoteEl.dataset.noteSlug = globalNote?.slug || '';

  // Only show non-global notes in the list
  const textNotes = currentNotes.filter(n => n.excerpt !== null);

  if (textNotes.length === 0) {
    container.innerHTML = '<div class="empty-state">No notes</div>';
    return;
  }

  container.innerHTML = textNotes.map((n, i) => {
    const displayText = Array.isArray(n.excerpt) ? n.excerpt.join(' ') : n.excerpt;
    return `
      <div class="highlight-item" data-note-slug="${escapeHtml(n.slug)}">
        <div class="highlight-header">
          <div class="highlight-text">"${escapeHtml(displayText)}"</div>
          <button class="highlight-delete" data-note-slug="${escapeHtml(n.slug)}" title="Delete">&times;</button>
        </div>
        <textarea class="highlight-note" placeholder="Add a note..." data-note-slug="${escapeHtml(n.slug)}">${escapeHtml(n.note || '')}</textarea>
      </div>`;
  }).join('');

  // Delete note
  container.querySelectorAll('.highlight-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const noteSlug = btn.dataset.noteSlug;
      if (!noteSlug) return;

      try {
        await chrome.runtime.sendMessage({
          action: 'deleteNote',
          noteSlug
        });
        // Tell content script to remove the visual mark(s)
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { action: 'removeHighlightMark', noteSlug }).catch(() => {});
        }
      } catch (e) {
        console.error('[popup] Delete note error:', e);
      }

      currentNotes = currentNotes.filter(n => n.slug !== noteSlug);
      renderNotes(currentNotes);
    });
  });

  // Save notes on change (debounced)
  let saveTimeout = null;
  container.querySelectorAll('.highlight-note').forEach(textarea => {
    textarea.addEventListener('input', () => {
      autoResizeTextarea(textarea);
      const noteSlug = textarea.dataset.noteSlug;
      const note = currentNotes.find(n => n.slug === noteSlug);
      if (note) note.note = textarea.value;

      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(async () => {
        console.log(`[popup] Saving note for slug=${noteSlug}`);
        try {
          await chrome.runtime.sendMessage({
            action: 'updateNote',
            noteSlug,
            note: textarea.value
          });
        } catch (error) {
          console.error('[popup] Note save error:', error);
        }
      }, 500);
    });
  });
}

// Page-note auto-save (debounced)
let pageNoteSaveTimeout = null;
let currentGlobalNoteSlug = null;
document.getElementById('pageNote').addEventListener('input', (e) => {
  autoResizeTextarea(e.target);
  clearTimeout(pageNoteSaveTimeout);
  pageNoteSaveTimeout = setTimeout(async () => {
    const note = document.getElementById('pageNote').value;
    const noteSlug = document.getElementById('pageNote').dataset.noteSlug;
    try {
      if (noteSlug) {
        // Update existing global note
        await chrome.runtime.sendMessage({
          action: 'updateNote',
          noteSlug,
          note
        });
      } else if (note) {
        // Create new global note
        const resp = await chrome.runtime.sendMessage({
          action: 'createNote',
          pageSlug: currentSlug,
          excerpt: null,
          note,
          cssPath: null
        });
        if (resp?.noteSlug) {
          document.getElementById('pageNote').dataset.noteSlug = resp.noteSlug;
        }
      }
    } catch (error) {
      console.error('[popup] Page note save error:', error);
    }
  }, 500);
});

// Lists — pin current page to lists
async function loadLists() {
  return await readCacheable('lists') || [];
}

async function loadListPins() {
  try {
    const lists = await readCacheable('lists') || [];
    const allPins = {};
    for (const list of lists) {
      if (list.pins && list.pins.length > 0) allPins[list.slug] = list.pins;
    }
    return allPins;
  } catch { return {}; }
}

function isPagePinned(allPins, listId, url) {
  const pins = allPins[listId] || [];
  const slug = generateSlugFromUrl(url);
  const pageId = `page:${slug}`;
  const shallowId = `shallow:${url}`;
  return pins.some(p => p.id === pageId || p.id === shallowId || p.url === url);
}

async function renderListChips() {
  const container = document.getElementById('listChips');
  const [lists, allPins] = await Promise.all([loadLists(), loadListPins()]);

  // Compute lastActivity for each list and sort by most recent
  const ranked = lists.map(list => {
    const pins = allPins[list.slug] || [];
    const maxPinnedAt = pins.reduce((max, p) => Math.max(max, p.pinnedAt || 0), 0);
    const lastActivity = maxPinnedAt || 0;
    return { list, lastActivity };
  });
  ranked.sort((a, b) => b.lastActivity - a.lastActivity);
  const topLists = ranked.slice(0, 5);

  let html = topLists.map(({ list }) => {
    const pinned = isPagePinned(allPins, list.slug, currentUrl);
    return `<span class="list-chip${pinned ? ' selected' : ''}" data-list-id="${list.slug}">
      <span class="list-chip-check">${pinned ? '&#10003;' : ''}</span>
      ${escapeHtml(list.name)}
    </span>`;
  }).join('');

  html += `<span class="list-add-btn" id="listAddBtn" title="Add to list">+</span>`;

  container.innerHTML = html;

  // Toggle existing chips
  container.querySelectorAll('.list-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const listId = chip.dataset.listId;
      await toggleListPin(listId);
      renderListChips();
    });
  });

  // + button opens picker dropdown
  document.getElementById('listAddBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openListPicker(lists, allPins);
  });
}

// TODO: currentUrl comes from tab.url, which may differ from the URL the content
// script reported (e.g. YouTube SPA adds &pp= after load). This causes slug
// mismatches — background computes a different slug than the checkpoint's.
// Fix: ask the content script for the canonical URL it reported, or maintain a
// url→slug reverse index in background so slug lookups survive URL mutations.
// Same issue affects getPageInfo and ensureCheckpointIfMissing.
async function toggleListPin(listId) {
  await chrome.runtime.sendMessage({ action: 'toggleListPin', listId, url: currentUrl });
}

function closeListPicker() {
  const existing = document.getElementById('listPicker');
  if (existing) existing.remove();
  document.removeEventListener('click', pickerOutsideClickHandler);
}

function pickerOutsideClickHandler(e) {
  const picker = document.getElementById('listPicker');
  if (picker && !picker.contains(e.target) && e.target.id !== 'listAddBtn') {
    closeListPicker();
  }
}

function openListPicker(lists, allPins) {
  // Close if already open
  if (document.getElementById('listPicker')) {
    closeListPicker();
    return;
  }

  const wrap = document.querySelector('.list-chips-wrap');
  const picker = document.createElement('div');
  picker.className = 'list-picker';
  picker.id = 'listPicker';
  picker.innerHTML = `
    <input class="list-picker-input" id="listPickerInput" placeholder="Search or create..." />
    <div class="list-picker-list" id="listPickerList"></div>
  `;
  wrap.appendChild(picker);

  const input = document.getElementById('listPickerInput');
  const listEl = document.getElementById('listPickerList');

  function renderPickerRows() {
    const query = input.value.trim().toLowerCase();
    const filtered = query
      ? lists.filter(c => (c.name).toLowerCase().includes(query))
      : lists;

    let rowsHtml = filtered.map(c => {
      const pinned = isPagePinned(allPins, c.slug, currentUrl);
      return `<div class="list-picker-row${pinned ? ' selected' : ''}" data-list-id="${c.slug}">
        <span class="list-picker-row-check">${pinned ? '&#10003;' : ''}</span>
        <span>${escapeHtml(c.name)}</span>
      </div>`;
    }).join('');

    // Show create option if input doesn't exactly match any existing list
    const inputVal = input.value.trim();
    if (inputVal) {
      const exactMatch = lists.some(c =>
        (c.name).toLowerCase() === inputVal.toLowerCase()
      );
      if (!exactMatch) {
        rowsHtml += `<div class="list-picker-create" id="listPickerCreate">Create "${escapeHtml(inputVal)}"</div>`;
      }
    }

    if (!rowsHtml) {
      rowsHtml = `<div style="padding: 8px 10px; font-size: 11px; color: #999; text-align: center;">No lists</div>`;
    }

    listEl.innerHTML = rowsHtml;

    // Attach click handlers to rows
    listEl.querySelectorAll('.list-picker-row').forEach(row => {
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        const listId = row.dataset.listId;
        await toggleListPin(listId);
        // Refresh allPins and re-render rows in place
        const freshPins = await loadListPins();
        Object.assign(allPins, freshPins);
        renderPickerRows();
      });
    });

    const createBtn = document.getElementById('listPickerCreate');
    if (createBtn) {
      createBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await createListAndPin(inputVal);
        closeListPicker();
        renderListChips();
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
      const exactMatch = lists.find(c =>
        (c.name).toLowerCase() === inputVal.toLowerCase()
      );
      if (exactMatch) {
        await toggleListPin(exactMatch.slug);
        closeListPicker();
        renderListChips();
      } else {
        await createListAndPin(inputVal);
        closeListPicker();
        renderListChips();
      }
    } else if (e.key === 'Escape') {
      closeListPicker();
    }
  });

  // Close on outside click (deferred to avoid catching the opening click)
  setTimeout(() => {
    document.addEventListener('click', pickerOutsideClickHandler);
  }, 0);
}

async function createListAndPin(name) {
  const lists = await loadLists();
  if (lists.some(c => c.name === name)) return;

  const listId = generateSlugFromTitle(name);
  await chrome.runtime.sendMessage({ action: 'saveListMeta', listId, name });
  const order = (await readCacheable('settings'))?.listOrder || [];
  await saveSettingsValue('listOrder', [...order, 'list:' + listId]);

  await toggleListPin(listId);

  console.log('[popup] Created list and pinned page:', name);
}

// Workspace mode
async function loadWorkspace() {
  const ws = await loadSettingsValue('workspace', {});
  return { mode: 'default', listIds: [], autoSnapshot: false, ...ws };
}

async function saveWorkspace(workspace) {
  await saveSettingsValue('workspace', workspace);
}

async function renderWorkspaceBar() {
  const workspace = await loadWorkspace();
  const lists = await loadLists();

  const bar = document.getElementById('workspaceBar');
  const triToggle = document.getElementById('triToggle');
  const config = document.getElementById('workspaceConfig');
  const listsContainer = document.getElementById('workspaceLists');
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

  // Render list selection chips
  if (lists.length === 0) {
    listsContainer.innerHTML = '<span class="workspace-empty">No lists yet. Create one in Notes section.</span>';
  } else {
    listsContainer.innerHTML = lists.map(list => {
      const selected = workspace.listIds.includes('list:' + list.slug);
      return `<span class="ws-list-chip${selected ? ' selected' : ''}" data-list-id="${list.slug}">${escapeHtml(list.name)}</span>`;
    }).join('');

    listsContainer.querySelectorAll('.ws-list-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const slug = chip.dataset.listId;
        const listKey = 'list:' + slug;
        const ws = await loadWorkspace();
        const idx = ws.listIds.indexOf(listKey);
        if (idx !== -1) {
          ws.listIds.splice(idx, 1);
        } else {
          ws.listIds.push(listKey);
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
    ws.listIds = [];
    ws.autoSnapshot = false;
  }
  await saveWorkspace(ws);
  await renderWorkspaceBar();

  // Exiting private mode: record the current page visit and show details
  if (wasPrivate && newMode !== 'private' && currentTab) {
    await chrome.runtime.sendMessage({
      action: 'reportPage',
      url: currentTab.url,
      title: currentTab.title || 'Untitled',
      slug: generateSlugFromUrl(currentTab.url),
      isInitialLoad: true
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
      currentInteraction.user_title = newTitle;
      try {
        await chrome.runtime.sendMessage({
          action: 'reportPage',
          url: currentInteraction.url,
          user_title: newTitle
        });
        console.log('[popup] User title updated to:', newTitle);
      } catch (error) {
        console.error('[popup] Failed to save user title:', error);
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
        // Use user_title if set, otherwise auto-detected title
        currentTitle = info.interaction.user_title || info.interaction.title || tab.title || 'Untitled';
        document.getElementById('pageTitle').textContent = currentTitle;
      }
      renderSnapshots(info.snapshots);
      renderAttention(info.interaction);
      renderNotes(info.notes);
      console.log(`[popup] Loaded ${info.notes?.length || 0} notes, ${info.snapshots?.length || 0} snapshots`);
    } else {
      console.warn('[popup] getPageInfo returned failure:', info);
    }
  } catch (error) {
    console.error('[popup] Could not load page info:', error);
  }

  // Render list chips and workspace bar
  await Promise.all([renderListChips(), renderWorkspaceBar()]);

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
  // Skip if user has set a custom title (user_title takes precedence)
  const initialTitle = tab.title || 'Untitled';
  const hasUserTitle = currentInteraction?.user_title;
  if (!hasUserTitle) {
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

        await chrome.runtime.sendMessage({
          action: 'reportPage',
          url: tab.url,
          title: freshTitle
        });
        if (currentInteraction) {
          currentInteraction.title = freshTitle;
        }
        console.log('[popup] Auto-updated title to:', freshTitle);
      } catch (error) {
        console.warn('[popup] Title re-check failed:', error);
      }
    }, 1000);
  }
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
    const [resp, recycleBin, permanentDeletes] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'loadInteractionByUrl', url: tab.url }),
      readCacheable('list:system/recycle-bin').then(v => v || []),
      readCacheable('list:system/permanent-deletes').then(v => v || [])
    ]);
    const recycled = recycleBin.some(item => item.url === tab.url);
    const permDeleted = permanentDeletes.includes(tab.url);
    hasVisitHistory = !!(resp && resp.interaction) && !recycled && !permDeleted;
  } catch {}

  // Check blacklist only for pages with no visit history
  const urlBlacklist = (await readCacheable('settings'))?.urlBlacklist;
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

        // Record page visit
        await chrome.runtime.sendMessage({
          action: 'reportPage',
          url: tab.url,
          title: tab.title || 'Untitled',
          slug,
          isInitialLoad: true
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
