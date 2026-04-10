// Popup — current-page dashboard
import { generateSlugFromUrl, generateSlugFromTitle, loadSettingsValue, readCacheable, sendAction, saveSettingsValue, escapeHtml } from './utils.js';
import { logDebug, logError } from './logger.js';
import { applyTheme } from './theme.js';
import { pageKey, listKey, entitySlug } from './entity-types.js';

let currentSlug = '';
let currentNotes = [];
let currentEntry = null;
let currentUrl = '';
let currentTitle = '';
let currentTab = null;
let detachedContent = null; // holds dashboardContent when removed in private mode
let frozenChipOrder = null; // Array of list slugs — frozen on first render to keep order stable
let _noteSaveTimeout = null;

// ─── Error UI ────────────────────────────────────────────────────────

function showFatalError(message) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#fff;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  overlay.innerHTML = `
    <div style="color:#b41e1e;font-size:14px;font-weight:600;">Storage Unavailable</div>
    <div style="color:#555;font-size:12px;max-width:360px;text-align:center;">${escapeHtml(message)}</div>
    <button id="fatalReloadBtn" style="margin-top:6px;padding:4px 12px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:12px;">Reload Extension</button>
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
    bubble.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(180,30,30,0.92);color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:6px 14px;border-radius:6px;opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:360px;text-align:center;';
    document.body.appendChild(bubble);
  }
  bubble.textContent = message + ' — please reload the extension.';
  bubble.style.opacity = '1';
  clearTimeout(_errorBubbleTimer);
  _errorBubbleTimer = setTimeout(() => { bubble.style.opacity = '0'; }, 4000);
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
    container.innerHTML = '';
    return;
  }

  container.innerHTML = snapshots.map(snap => `
    <div class="snapshot-row" role="button" tabindex="0" data-ts="${snap.timestamp}">
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
      const resp = await sendAction({ action: 'listSnapshots', slug: currentSlug });
      renderSnapshots(resp.snapshots || []);
    });
  });

  // Double-click to open snapshot in new tab
  container.querySelectorAll('.snapshot-row').forEach(row => {
    row.addEventListener('dblclick', async () => {
      const ts = parseInt(row.dataset.ts, 10);
      await chrome.runtime.sendMessage({ action: 'openSnapshot', slug: currentSlug, timestamp: ts });
    });
  });
}

// Render attention section (flat fields on history entry)
function renderVisitsAndLikes(entry) {
  const section = document.getElementById('visitsLikesSection');
  const container = document.getElementById('attentionGrid');
  if (!section || !container) return;

  const items = [];

  const visitDates = entry?.visitDates || [];
  if (visitDates.length > 0) {
    const parse = (yyyymmdd) => {
      const y = Math.floor(yyyymmdd / 10000);
      const m = Math.floor((yyyymmdd % 10000) / 100) - 1;
      const d = yyyymmdd % 100;
      return new Date(y, m, d);
    };
    const fmtDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const sorted = [...visitDates].sort((a, b) => a - b);
    const first = parse(sorted[0]);
    items.push(`<span class="attention-item"><strong>First:</strong> ${fmtDate(first)}</span>`);
    if (sorted.length > 1) {
      const last = parse(sorted[sorted.length - 1]);
      items.push(`<span class="attention-item"><strong>Last:</strong> ${fmtDate(last)}</span>`);
    }
  }

  const likes = entry?.likes || 0;
  if (likes > 0) {
    items.push(`<span class="attention-item"><strong>Liked:</strong> ${likes}</span>`);
  }

  if (items.length > 0) {
    container.innerHTML = items.join('');
    section.style.display = '';
  } else {
    section.style.display = 'none';
  }
}

// Render notes section
function renderNotes(notes) {
  if (_noteSaveTimeout) { clearTimeout(_noteSaveTimeout); _noteSaveTimeout = null; }
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
        logError('[popup] Delete note error:', e);
      }

      currentNotes = currentNotes.filter(n => n.slug !== noteSlug);
      renderNotes(currentNotes);
    });
  });

  // Save notes on change (debounced)
  container.querySelectorAll('.highlight-note').forEach(textarea => {
    textarea.addEventListener('input', () => {
      autoResizeTextarea(textarea);
      const noteSlug = textarea.dataset.noteSlug;
      const note = currentNotes.find(n => n.slug === noteSlug);
      if (note) note.note = textarea.value;

      clearTimeout(_noteSaveTimeout);
      _noteSaveTimeout = setTimeout(async () => {
        const currentSlugForSave = textarea.dataset.noteSlug;
        logDebug(`[popup] Saving note for slug=${currentSlugForSave}`);
        try {
          const resp = await chrome.runtime.sendMessage({
            action: 'updateNote',
            noteSlug: currentSlugForSave,
            note: textarea.value
          });
          if (resp?.noteSlug && resp.noteSlug !== currentSlugForSave) {
            textarea.dataset.noteSlug = resp.noteSlug;
          }
        } catch (error) {
          logError('[popup] Note save error:', error);
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
        // Update existing global note (creates new immutable note entity)
        const resp = await chrome.runtime.sendMessage({
          action: 'updateNote',
          noteSlug,
          note
        });
        if (resp?.noteSlug && resp.noteSlug !== noteSlug) {
          document.getElementById('pageNote').dataset.noteSlug = resp.noteSlug;
        }
      } else if (note) {
        // Create new global note
        const resp = await chrome.runtime.sendMessage({
          action: 'createNote',
          pageSlug: currentSlug,
          url: currentUrl,
          excerpt: null,
          note,
          cssPath: null
        });
        if (resp?.noteSlug) {
          document.getElementById('pageNote').dataset.noteSlug = resp.noteSlug;
        }
      }
    } catch (error) {
      logError('[popup] Page note save error:', error);
    }
  }, 500);
});

// Lists — pin current page to lists
async function loadLists() {
  const order = await readCacheable('manifest:list-order');
  const all = [];
  async function walk(nodes) {
    for (const node of nodes) {
      const entity = await readCacheable(node.id);
      if (entity && !entity.deleted) {
        all.push({ slug: entity.slug || entitySlug(node.id), name: entity.name || '' });
      }
      if (node.children) await walk(node.children);
    }
  }
  await walk(order?.tree || []);
  return all;
}

async function loadListPins() {
  const lists = await loadLists();
  const allPins = {};
  for (const list of lists) {
    const entity = await readCacheable(listKey(list.slug));
    if (entity?.pins?.length > 0) allPins[list.slug] = entity.pins;
  }
  return allPins;
}

function isPagePinned(allPins, listId, url) {
  const pins = allPins[listId] || [];
  const slug = generateSlugFromUrl(url);
  const pageId = pageKey(slug);
  return pins.some(p => p.id === pageId || p.url === url);
}

async function renderListChips() {
  const container = document.getElementById('listChips');
  const [lists, allPins] = await Promise.all([loadLists(), loadListPins()]);

  // Partition into lists containing this page vs. others
  const containsPage = [];
  const others = [];
  for (const list of lists) {
    if (isPagePinned(allPins, list.slug, currentUrl)) {
      containsPage.push(list);
    } else {
      others.push(list);
    }
  }

  // Sort others by most recent activity
  const othersRanked = others.map(list => {
    const pins = allPins[list.slug] || [];
    const maxPinnedAt = pins.reduce((max, p) => Math.max(max, p.pinnedAt || 0), 0);
    return { list, lastActivity: maxPinnedAt || 0 };
  });
  othersRanked.sort((a, b) => b.lastActivity - a.lastActivity);

  let displayLists;
  if (!frozenChipOrder) {
    // First render: pinned lists first, then fill remaining slots with active lists
    const remaining = Math.max(0, 15 - containsPage.length);
    displayLists = [...containsPage, ...othersRanked.slice(0, remaining).map(r => r.list)];
    frozenChipOrder = displayLists.map(l => l.slug);
  } else {
    // Subsequent renders: use frozen order, but ensure newly-pinned lists are visible
    const bySlug = new Map(lists.map(l => [l.slug, l]));
    displayLists = frozenChipOrder.filter(slug => bySlug.has(slug)).map(slug => bySlug.get(slug));
    for (const list of containsPage) {
      if (!frozenChipOrder.includes(list.slug)) {
        displayLists.push(list);
        frozenChipOrder.push(list.slug);
      }
    }
  }

  let html = displayLists.map((list) => {
    const pinned = isPagePinned(allPins, list.slug, currentUrl);
    return `<span class="list-chip${pinned ? ' selected' : ''}" role="button" tabindex="0" data-list-id="${list.slug}">${escapeHtml(list.name)}</span>`;
  }).join('');

  html += `<span class="list-add-btn" id="listAddBtn" title="Add to list">+</span>`;

  container.innerHTML = html;

  // Toggle existing chips
  container.querySelectorAll('.list-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      try {
        const listId = chip.dataset.listId;
        await toggleListPin(listId);
        renderListChips();
      } catch (err) { showErrorBubble(err.message); }
    });
  });

  // + button opens picker dropdown
  document.getElementById('listAddBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openListPicker(lists, allPins);
  });
}

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
      return `<div class="list-picker-row${pinned ? ' selected' : ''}" role="button" tabindex="0" data-list-id="${c.slug}">
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
        rowsHtml += `<div class="list-picker-create" id="listPickerCreate" role="button" tabindex="0">Create "${escapeHtml(inputVal)}"</div>`;
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
        try {
          const listId = row.dataset.listId;
          await toggleListPin(listId);
          // Refresh allPins and re-render rows in place
          const freshPins = await loadListPins();
          Object.assign(allPins, freshPins);
          renderPickerRows();
          renderListChips();
        } catch (err) { showErrorBubble(err.message); }
      });
    });

    const createBtn = document.getElementById('listPickerCreate');
    if (createBtn) {
      createBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await createListAndPin(inputVal);
          closeListPicker();
          renderListChips();
        } catch (err) { showErrorBubble(err.message); }
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
      try {
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
      } catch (err) { showErrorBubble(err.message); }
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

  // saveListMeta's effectOf adds to tree manifest — no manual append needed.
  // Use the generatedId returned by the handler (replay engine generates its own ID).
  const resp = await chrome.runtime.sendMessage({ action: 'saveListMeta', name });
  const listId = resp?.listId;
  if (!listId) { logError('[popup] saveListMeta did not return listId'); return; }

  await toggleListPin(listId);

  logDebug('[popup] Created list and pinned page:', name, listId);
}

// Workspace mode (session-only, not persisted to disk)
async function loadWorkspace() {
  const { workspace = {} } = await chrome.storage.session.get(['workspace']);
  return { mode: 'default', listIds: [], autoSnapshot: false, ...workspace };
}

async function saveWorkspace(workspace) {
  await chrome.storage.session.set({ workspace });
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
      const selected = workspace.listIds.includes(listKey(list.slug));
      return `<span class="ws-list-chip${selected ? ' selected' : ''}" role="button" tabindex="0" data-list-id="${list.slug}">${escapeHtml(list.name)}</span>`;
    }).join('');

    listsContainer.querySelectorAll('.ws-list-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const slug = chip.dataset.listId;
        const lk = listKey(slug);
        const ws = await loadWorkspace();
        const idx = ws.listIds.indexOf(lk);
        if (idx !== -1) {
          ws.listIds.splice(idx, 1);
        } else {
          ws.listIds.push(lk);
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
    const url = currentTab._effectiveUrl || currentTab.url;
    await chrome.runtime.sendMessage({
      action: 'reportPage',
      url,
      title: currentTab.title || null,
      slug: generateSlugFromUrl(url),
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

    if (newTitle !== currentTitle && currentEntry) {
      currentEntry.user_title = newTitle;
      try {
        await chrome.runtime.sendMessage({
          action: 'reportPage',
          url: currentEntry.url,
          user_title: newTitle
        });
        logDebug('[popup] User title updated to:', newTitle);
      } catch (error) {
        logError('[popup] Failed to save user title:', error);
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

// Open settings page
document.getElementById('openSettingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Capture button handler
document.getElementById('captureBtn').addEventListener('click', async () => {
  const btn = document.getElementById('captureBtn');
  btn.disabled = true;
  btn.textContent = 'Capturing...';

  try {
    logDebug('[popup] Capturing snapshot...');
    const resp = await chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' });
    logDebug('[popup] Capture response:', resp);
    if (resp && resp.success) {
      const snapshotsResp = await sendAction({ action: 'listSnapshots', slug: currentSlug });
      renderSnapshots(snapshotsResp.snapshots || []);
    } else {
      logDebug('[popup] Capture failed:', resp);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) chrome.tabs.sendMessage(tab.id, { action: 'showErrorNotification', message: resp?.error || 'Capture failed' }).catch(() => {});
    }
  } catch (error) {
    logError('[popup] Capture error:', error);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (tab) chrome.tabs.sendMessage(tab.id, { action: 'showErrorNotification', message: error.message || 'Capture failed' }).catch(() => {});
  }

  btn.disabled = false;
  btn.textContent = '+ Capture';
});

// ─── showDashboard phases ────────────────────────────────────────────

function reattachDashboardContent() {
  if (detachedContent && !document.getElementById('dashboardContent')) {
    document.getElementById('dashboard').appendChild(detachedContent);
    detachedContent = null;
  }
}

async function resolvePageIdentity(tab) {
  const effectiveUrl = tab._effectiveUrl || tab.url;
  let title = tab.title || '<unknown>';
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'trimTitle', title, url: effectiveUrl });
    if (resp?.title) title = resp.title;
  } catch {}
  const viewerPrefix = chrome.runtime.getURL('snapshot-viewer.html');
  let slug;
  if (tab.url.startsWith(viewerPrefix)) {
    slug = new URL(tab.url).searchParams.get('slug') || '';
  } else {
    slug = generateSlugFromUrl(tab.url);
  }
  return { slug, url: effectiveUrl, title };
}

async function fetchAndRenderPageData(tab, slug) {
  // Build a fallback entry from tab info
  currentEntry = { timestamp: Date.now(), url: tab.url, title: tab.title || null, intent: '', slug };

  try {
    logDebug(`[popup] Fetching page info for slug=${slug}`);
    const info = await chrome.runtime.sendMessage({ action: 'getPageInfo', slug });
    logDebug('[popup] getPageInfo response:', info);

    if (info && info.success) {
      if (info.entry) {
        currentEntry = info.entry;
        currentTitle = info.entry.user_title || info.entry.title || tab.title || '<unknown>';
        document.getElementById('pageTitle').textContent = currentTitle;
        if (info.entry.url) {
          currentUrl = info.entry.url;
          document.getElementById('pageUrl').textContent = info.entry.url;
        }
      }
      renderVisitsAndLikes(info.entry);
      renderSnapshots(info.snapshots);
      renderNotes(info.notes);
      logDebug(`[popup] Loaded ${info.notes?.length || 0} notes, ${info.snapshots?.length || 0} snapshots`);
    } else {
      logDebug('[popup] getPageInfo returned failure:', info);
    }
  } catch (error) {
    logError('[popup] Could not load page info:', error);
  }
}

function showDashboardUI() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('blacklisted').style.display = 'none';
  document.getElementById('dashboard').style.display = 'flex';
  document.getElementById('dashboardContent').style.display = 'block';

  requestAnimationFrame(() => {
    autoResizeTextarea(document.getElementById('pageNote'));
    document.querySelectorAll('.highlight-note').forEach(ta => autoResizeTextarea(ta));
  });
}

function scheduleDelayedTitleCheck(tab, initialTitle) {
  if (currentEntry?.user_title) return;
  setTimeout(async () => {
    try {
      const [freshTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!freshTab || freshTab.id !== tab.id) return;

      const freshTitle = freshTab.title || '';
      if (freshTitle === initialTitle) return;

      const titleEl = document.getElementById('pageTitle');
      if (!titleEl || titleEl.textContent !== initialTitle) return;

      titleEl.textContent = freshTitle;
      await chrome.runtime.sendMessage({ action: 'reportPage', url: tab.url, title: freshTitle });
      if (currentEntry) currentEntry.title = freshTitle;
      logDebug('[popup] Auto-updated title to:', freshTitle);
    } catch (error) {
      logDebug('[popup] Title re-check failed:', error);
    }
  }, 1000);
}

// Show dashboard for a tab: set up state, fetch data, render sections
async function showDashboard(tab) {
  reattachDashboardContent();

  const { slug, url, title } = await resolvePageIdentity(tab);
  currentUrl = url;
  currentTitle = title;
  currentSlug = slug;
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageUrl').textContent = url;

  await fetchAndRenderPageData(tab, slug);
  await Promise.all([renderListChips(), renderWorkspaceBar()]);
  showDashboardUI();
  scheduleDelayedTitleCheck(tab, tab.title || '');
}

// ─── Init phases ─────────────────────────────────────────────────────

async function verifyDeviceIdentity() {
  const deviceResp = await chrome.runtime.sendMessage({ action: 'getDeviceId' });
  if (!deviceResp?.deviceId) {
    throw new Error('Device identity unavailable — the CURRENT file may be missing or corrupted. Try reloading the extension.');
  }
}

async function resolveActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isSnapshotViewer = tab?.url?.startsWith(chrome.runtime.getURL('snapshot-viewer.html'));
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || (tab.url.startsWith('chrome-extension://') && !isSnapshotViewer)) {
    document.getElementById('loading').textContent = 'Not available for this page';
    return null;
  }
  return tab;
}

async function resolveEffectiveUrl(tab) {
  let effectiveUrl = tab.url;
  try {
    const reported = await chrome.runtime.sendMessage({ action: 'getReportedUrl', tabId: tab.id });
    if (reported?.success && reported.url) effectiveUrl = reported.url;
  } catch {}
  tab._effectiveUrl = effectiveUrl;
}

async function handlePrivateMode(tab) {
  const wsCheck = await loadWorkspace();
  if (wsCheck.mode !== 'private') return false;
  await renderWorkspaceBar();
  const content = document.getElementById('dashboardContent');
  detachedContent = content;
  content.remove();
  document.getElementById('loading').style.display = 'none';
  document.getElementById('dashboard').style.display = 'flex';
  return true;
}

async function handleBlacklist(tab) {
  const effectiveUrl = tab._effectiveUrl || tab.url;
  const pageSlug = generateSlugFromUrl(effectiveUrl);
  const hasVisitHistory = !!(await readCacheable(pageKey(pageSlug)));

  const urlBlacklist = (await readCacheable('manifest:settings')).urlBlacklist;
  const blacklist = urlBlacklist ?? ['chrome://', 'edge://'];
  if (hasVisitHistory || !blacklist.some(prefix => tab.url.startsWith(prefix))) return false;

  document.getElementById('loading').style.display = 'none';
  document.getElementById('blacklistedUrl').textContent = tab.url;
  document.getElementById('blacklisted').style.display = 'block';
  document.getElementById('blacklistSettingsLink').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('captureOnceBtn').addEventListener('click', async () => {
    const btn = document.getElementById('captureOnceBtn');
    btn.disabled = true;
    btn.textContent = 'Capturing...';

    try {
      const slug = generateSlugFromUrl(effectiveUrl);
      await chrome.runtime.sendMessage({
        action: 'reportPage', url: effectiveUrl, title: tab.title || null,
        slug, isInitialLoad: true, bypassBlacklist: true,
      });
      const resp = await chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' });
      if (resp && !resp.success) {
        chrome.tabs.sendMessage(tab.id, { action: 'showErrorNotification', message: resp.error || 'Capture failed' }).catch(() => {});
      }
      logDebug('[popup] Capture once completed for blacklisted page');
    } catch (error) {
      logError('[popup] Capture once failed:', error);
      chrome.tabs.sendMessage(tab.id, { action: 'showErrorNotification', message: error.message || 'Capture failed' }).catch(() => {});
    }

    await showDashboard(tab);
  });

  return true;
}

// Initialize popup
async function initPopup() {
  await applyTheme();
  await verifyDeviceIdentity();
  const tab = await resolveActiveTab();
  if (!tab) return;
  currentTab = tab;
  await resolveEffectiveUrl(tab);
  if (await handlePrivateMode(tab)) return;
  if (await handleBlacklist(tab)) return;
  await showDashboard(tab);
}
initPopup().catch(err => showFatalError(err.message));

// Listen for note mutations from background to keep popup in sync
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'mutation' || msg.type !== 'note' || !currentSlug) return false;
  // Re-fetch notes for current page
  chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: currentSlug }).then(resp => {
    if (resp?.success && resp.notes) renderNotes(resp.notes);
  }).catch(() => {});
  return false;
});
