// replay.js — pure functions for applying log entries to entity state.
// Imported by both background.js (cache-miss replay) and offscreen.js (checkpoint).
// Each function is idempotent — safe to replay the same entry twice.
import { generateSlugFromUrl } from './utils.js';
import { generateRuleId } from './rule-engine.js';
import { PAGE_PREFIX, NOTE_PREFIX, SNAPSHOT_PREFIX, LIST_PREFIX, entitySlug, isSystemList } from './entity-types.js';

const REFERRER_CAP = 50;


/** Update the per-device timestamp on an entity, returning a shallow copy. */
function touchTimestamp(entity, deviceId, ts) {
  const timestamps = { ...(entity.timestamps || {}) };
  timestamps[deviceId] = Math.max(timestamps[deviceId] || 0, ts);
  return { ...entity, timestamps };
}

/**
 * Return the set of page keys that an entry affects.
 * Used by hydration to pre-load page entities referenced by logBuffer entries.
 */
export function getAffectedKeys(entry) {
  const keys = new Set();
  const url = entry.url;
  if (url) {
    keys.add(PAGE_PREFIX + generateSlugFromUrl(url));
  }

  // visit_page with referrerUrl also affects the parent page
  if (entry.action === 'visit_page' && entry.referrerUrl) {
    const parentKey = PAGE_PREFIX + generateSlugFromUrl(entry.referrerUrl);
    const childKey = url ? PAGE_PREFIX + generateSlugFromUrl(url) : null;
    if (parentKey !== childKey) keys.add(parentKey);
  }

  // create_snapshot/delete_snapshot/restore_snapshot: url IS the parent page
  // (already added above via entry.url)

  // create_note/delete_note/restore_note: url IS the parent page
  // (already added above via entry.url)

  return keys;
}


// ---------------------------------------------------------------------------
// Unified replay interface: effectOf
// ---------------------------------------------------------------------------

/**
 * Default empty entity for a given key. Used when creating entities from null.
 */
export function defaultEntity(key) {
  if (key.startsWith(PAGE_PREFIX)) {
    const slug = key.slice(PAGE_PREFIX.length);
    return { slug, parentIds: [], childIds: [] };
  }
  if (key.startsWith(NOTE_PREFIX)) {
    const slug = key.slice(NOTE_PREFIX.length);
    return { slug, excerpt: null, note: null, cssPath: null, url: null };
  }
  if (key === 'manifest:settings') return {};
  if (key === 'manifest:orphaned') return { entries: [] };
  if (key === 'manifest:list-order') return { tree: [] };
  if (key === 'manifest:name-to-id') return { paths: {} };
  if (key.startsWith(LIST_PREFIX)) {
    const slug = entitySlug(key);
    return { slug, name: '', pins: [], rules: [] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tree manifest helpers (for manifest:list-order)
// ---------------------------------------------------------------------------

/**
 * Remove a node from the tree by ID. Its children are promoted to the
 * same position in the parent array (splice in place).
 * Returns a new tree array (does not mutate input).
 */
function removeFromTree(tree, listId) {
  const out = [];
  for (const node of tree) {
    if (node.id === listId) {
      // Promote children to this level
      if (node.children) {
        for (const child of node.children) {
          out.push(deepCloneTree(child));
        }
      }
    } else {
      const cloned = { id: node.id };
      if (node.children) {
        cloned.children = removeFromTree(node.children, listId);
      }
      out.push(cloned);
    }
  }
  return out;
}

/**
 * Append a node to the tree under a given parent.
 * If parentId is null or not found, appends to top level.
 * Returns a new tree array (does not mutate input).
 */
function appendToTree(tree, listId, parentId) {
  const newNode = { id: listId };
  if (!parentId) {
    return [...tree.map(deepCloneTree), newNode];
  }
  // Try to find parentId in tree and append there
  const cloned = tree.map(deepCloneTree);
  if (appendToTreeRecursive(cloned, listId, parentId)) {
    return cloned;
  }
  // Parent not found — append to top level
  cloned.push(newNode);
  return cloned;
}

/** Mutates `nodes` in place. Returns true if parent was found. */
function appendToTreeRecursive(nodes, listId, parentId) {
  for (const node of nodes) {
    if (node.id === parentId) {
      if (!node.children) node.children = [];
      node.children.push({ id: listId });
      return true;
    }
    if (node.children && appendToTreeRecursive(node.children, listId, parentId)) {
      return true;
    }
  }
  return false;
}

function deepCloneTree(node) {
  const cloned = { id: node.id };
  if (node.children) {
    cloned.children = node.children.map(deepCloneTree);
  }
  return cloned;
}

/**
 * A page entity is eligible for retention if ANY of:
 * - parentIds contains at least one list: key (pinned to a user list)
 * - childIds contains at least one note: or snapshot: key
 * - user_title is set and truthy
 * - likes is set and non-zero
 */
export function isPageEligible(entity) {
  if (entity.parentIds?.some(id => id.startsWith(LIST_PREFIX))) return true;
  if (entity.childIds?.some(id => id.startsWith(NOTE_PREFIX) || id.startsWith(SNAPSHOT_PREFIX))) return true;
  if (entity.user_title) return true;
  if (entity.likes) return true;
  return false;
}

// ---------------------------------------------------------------------------
// LWW guard (consolidates 5 inline checks) — exported for tests
// ---------------------------------------------------------------------------

export function isStaleByLWW(entity, entryTimestamp) {
  const ts = entity?.deletedTs;
  return !!ts && ts >= entryTimestamp;
}

// ---------------------------------------------------------------------------
// ReplayContext — carries shared state for effectOf handler functions
// ---------------------------------------------------------------------------

class ReplayContext {
  constructor(entry, load, context) {
    this.entry = entry;
    this.load = load;
    this.context = context;
    this.result = {};
  }

  isStaleByLWW(entity, field = 'deletedTs') {
    const ts = entity?.[field] || 0;
    return ts >= this.entry.timestamp;
  }

  async loadOrDefault(key, opts) {
    return (await this.load(key, opts)) ?? defaultEntity(key);
  }

  async linkChild(childKey, parentIds) {
    if (!parentIds) return;
    for (const parentKey of parentIds) {
      const parent = this.result[parentKey] !== undefined ? this.result[parentKey] : await this.load(parentKey);
      if (!parent) { this.result[parentKey] = null; continue; }
      const childIds = [...(parent.childIds || [])];
      if (!childIds.includes(childKey)) childIds.push(childKey);
      this.result[parentKey] = { ...parent, childIds };
    }
  }

  async unlinkChild(childKey, parentIds) {
    if (!parentIds) return;
    for (const parentKey of parentIds) {
      const parent = this.result[parentKey] !== undefined ? this.result[parentKey] : await this.load(parentKey);
      if (!parent) { this.result[parentKey] = null; continue; }
      const childIds = (parent.childIds || []).filter(c => c !== childKey);
      this.result[parentKey] = { ...parent, childIds };
    }
  }

  async orphan(childKey, ts, parentUrl) {
    const orphaned = this.result['manifest:orphaned'] || await this.loadOrDefault('manifest:orphaned');
    const entries = [...(orphaned.entries || [])];
    if (!entries.some(e => e.key === childKey)) {
      const entry = { key: childKey };
      if (parentUrl) entry.url = parentUrl;
      entries.push(entry);
    }
    this.result['manifest:orphaned'] = { ...touchTimestamp(orphaned, this.context.deviceId, ts), entries };
  }

  async unorphan(childKey, ts) {
    const orphaned = this.result['manifest:orphaned'] || await this.loadOrDefault('manifest:orphaned');
    const entries = (orphaned.entries || []).filter(e => e.key !== childKey);
    this.result['manifest:orphaned'] = { ...touchTimestamp(orphaned, this.context.deviceId, ts), entries };
  }

  async resolveListKey(name) {
    if (!name) return null;
    if (name.startsWith('system/')) {
      return LIST_PREFIX + name;
    }
    const nameToId = this.result['manifest:name-to-id'] || await this.loadOrDefault('manifest:name-to-id');
    const owner = this.entry.listOwner;
    if (!owner) return null;
    const id = nameToId.paths?.[owner + '/' + name];
    if (id) return LIST_PREFIX + id;
    // Fallback: search orphaned entities by owner+name (deleted lists removed from name-to-id)
    const orphanedEntity = this.result['manifest:orphaned'] || await this.loadOrDefault('manifest:orphaned');
    for (const oe of (orphanedEntity.entries || [])) {
      if (!oe.key.startsWith(LIST_PREFIX) || isSystemList(oe.key)) continue;
      const entity = await this.load(oe.key, { includeDeleted: true });
      if (entity?.owner === owner && entity?.name === name) return oe.key;
    }
    return null;
  }

  async ensurePageEntity(url, ts, title) {
    const slug = generateSlugFromUrl(url);
    const pageKey = PAGE_PREFIX + slug;
    let page = this.result[pageKey] !== undefined ? this.result[pageKey] : await this.load(pageKey);
    if (!page) {
      page = { ...defaultEntity(pageKey), url, createdAt: ts };
      if (title) page.title = title;
    }
    this.result[pageKey] = page;
    return { pageKey, page };
  }

  async findListsWithPin(pinId) {
    const nameToId = this.result['manifest:name-to-id'] || await this.loadOrDefault('manifest:name-to-id');
    const lists = [];
    for (const id of Object.values(nameToId.paths || {})) {
      const lk = LIST_PREFIX + id;
      const list = this.result[lk] !== undefined ? this.result[lk] : await this.load(lk);
      if (list && (list.pins || []).some(p => p.id === pinId)) lists.push(lk);
    }
    return lists;
  }

  async loadListForMutation(listKey) {
    return await this.loadOrDefault(listKey, { includeDeleted: true });
  }
}

// ---------------------------------------------------------------------------
// Action handler functions
// ---------------------------------------------------------------------------

async function handleUpdateSetting(ctx) {
  const settings = await ctx.loadOrDefault('manifest:settings');
  ctx.result['manifest:settings'] = { ...touchTimestamp(settings, ctx.context.deviceId, ctx.entry.timestamp), [ctx.entry.key]: ctx.entry.value };
}

async function handleVisitPage(ctx) {
  const { entry } = ctx;
  const slug = generateSlugFromUrl(entry.url);
  const pageKey = PAGE_PREFIX + slug;
  const page = entry.checkpoint
    ? (await ctx.ensurePageEntity(entry.url, entry.timestamp, entry.title)).page
    : await ctx.load(pageKey);

  if (page) {
    const updated = touchTimestamp(page, ctx.context.deviceId, ctx.entry.timestamp);
    if (entry.url) updated.url = entry.url;
    if (entry.title) updated.title = entry.title;

    // visitDates
    const d = new Date(entry.timestamp);
    const yyyymmdd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const visitDates = [...(updated.visitDates || [])];
    if (!visitDates.includes(yyyymmdd)) visitDates.push(yyyymmdd);
    updated.visitDates = visitDates;

    // referrerUrl → parentIds
    if (entry.referrerUrl) {
      const referrerKey = PAGE_PREFIX + generateSlugFromUrl(entry.referrerUrl);
      const parentIds = [...(updated.parentIds || [])];
      if (!parentIds.includes(referrerKey)) {
        parentIds.push(referrerKey);
        if (parentIds.length > REFERRER_CAP) parentIds.shift();
      }
      updated.parentIds = parentIds;
    }

    ctx.result[pageKey] = updated;
  }

  // Parent-side: accumulate child ref on referrer page
  if (entry.referrerUrl) {
    const referrerSlug = generateSlugFromUrl(entry.referrerUrl);
    const referrerKey = PAGE_PREFIX + referrerSlug;
    if (referrerKey !== pageKey) {
      const parent = ctx.result[referrerKey] !== undefined ? ctx.result[referrerKey] : await ctx.load(referrerKey);
      if (parent) {
        const childIds = [...(parent.childIds || [])];
        const childRef = PAGE_PREFIX + slug;
        if (!childIds.includes(childRef)) {
          childIds.push(childRef);
          if (childIds.length > REFERRER_CAP) childIds.shift();
        }
        ctx.result[referrerKey] = { ...touchTimestamp(parent, ctx.context.deviceId, ctx.entry.timestamp), childIds };
      }
    }
  }
}

async function handleLeavePage(ctx) {
  const { entry } = ctx;
  const slug = generateSlugFromUrl(entry.url);
  const pageKey = PAGE_PREFIX + slug;
  const page = await ctx.load(pageKey);

  if (page) {
    const updated = touchTimestamp(page, ctx.context.deviceId, ctx.entry.timestamp);

    // Title: latest auto-detected from MutationObserver, folded into leave report
    if (entry.title) updated.title = entry.title;

    // Attention guard: per-device timestamp (skip additive fields if already applied)
    const deviceTs = (page.timestamps || {})[ctx.context.deviceId] || 0;
    if (entry.timestamp > deviceTs) {
      if (entry.scrollDepth !== undefined) {
        updated.scrollDepth = Math.max(updated.scrollDepth || 0, entry.scrollDepth);
      }
      if (entry.timeOnPage !== undefined) {
        updated.timeOnPage = (updated.timeOnPage || 0) + entry.timeOnPage;
      }
    }

    ctx.result[pageKey] = updated;
  }
}

async function handleRenamePage(ctx) {
  const { entry } = ctx;
  const { pageKey } = await ctx.ensurePageEntity(entry.url, entry.timestamp);
  const page = ctx.result[pageKey];
  ctx.result[pageKey] = { ...touchTimestamp(page, ctx.context.deviceId, ctx.entry.timestamp), user_title: entry.user_title };
}

async function handleRatePage(ctx) {
  const { entry } = ctx;
  const { pageKey } = await ctx.ensurePageEntity(entry.url, entry.timestamp, entry.title);
  const page = ctx.result[pageKey];
  const updated = touchTimestamp(page, ctx.context.deviceId, ctx.entry.timestamp);

  // Per-device guard (skip additive fields if already applied)
  const deviceTs = (page.timestamps || {})[ctx.context.deviceId] || 0;
  if (entry.timestamp > deviceTs && entry.likes !== undefined) {
    updated.likes = (updated.likes || 0) + entry.likes;
  }

  ctx.result[pageKey] = updated;
}

async function handleCreateSnapshot(ctx) {
  const { entry } = ctx;
  const { pageKey } = await ctx.ensurePageEntity(entry.url, entry.timestamp, entry.title);
  const page = ctx.result[pageKey];
  const updated = touchTimestamp(page, ctx.context.deviceId, ctx.entry.timestamp);

  // Snapshot key derived from path: "snapshots/<slug>-<ts>" → "snapshot:<slug>-<ts>"
  const snapKey = `${SNAPSHOT_PREFIX}${entry.path.slice('snapshots/'.length)}`;
  const childIds = [...(updated.childIds || [])];
  if (!childIds.includes(snapKey)) childIds.push(snapKey);
  updated.childIds = childIds;

  ctx.result[pageKey] = updated;
}

async function handleCreateNote(ctx) {
  const { entry } = ctx;
  const slug = generateSlugFromUrl(entry.url);
  const pageKey = PAGE_PREFIX + slug;
  await ctx.ensurePageEntity(entry.url, entry.timestamp, entry.title);

  // Derive note slug from path: "notes/<slug>.json" → "<slug>"
  const noteSlug = entry.path.slice('notes/'.length, -'.json'.length);
  const noteKey = `${NOTE_PREFIX}${noteSlug}`;
  // Link note as child of page (page.childIds)
  await ctx.linkChild(noteKey, [pageKey]);
  // Set url on note entity
  const note = ctx.result[noteKey] !== undefined ? ctx.result[noteKey] : await ctx.load(noteKey);
  if (note) ctx.result[noteKey] = { ...note, url: entry.url };
}

async function handleDeleteNote(ctx) {
  const { entry } = ctx;
  const noteSlug = entry.path.slice('notes/'.length, -'.json'.length);
  const noteKey = `${NOTE_PREFIX}${noteSlug}`;
  // Load with includeDeleted; noop if already deleted
  const note = await ctx.loadOrDefault(noteKey, { includeDeleted: true });
  // LWW via deletedTs
  if (ctx.isStaleByLWW(note)) return;

  // Derive page key from note.url
  const noteUrl = note.url || entry.url;
  if (noteUrl) {
    const pageKey = PAGE_PREFIX + generateSlugFromUrl(noteUrl);
    await ctx.unlinkChild(noteKey, [pageKey]);
    // GC parent page if it became ineligible
    const p = ctx.result[pageKey];
    if (p && !isPageEligible(p)) ctx.result[pageKey] = null;
  }
  // Remove note pin from lists (find via pins scan)
  const listKeys = await ctx.findListsWithPin(noteKey);
  for (const lk of listKeys) {
    const list = ctx.result[lk] !== undefined ? ctx.result[lk] : await ctx.load(lk);
    if (!list) continue;
    ctx.result[lk] = { ...list, pins: (list.pins || []).filter(p => p.id !== noteKey) };
  }
  // Mark deleted
  const deletedNote = { ...note, deleted: true, deletedTs: entry.timestamp };
  ctx.result[noteKey] = deletedNote;
  await ctx.orphan(noteKey, entry.timestamp, noteUrl);
}

async function handleRestoreNote(ctx) {
  const { entry } = ctx;
  const noteSlug = entry.path.slice('notes/'.length, -'.json'.length);
  const noteKey = `${NOTE_PREFIX}${noteSlug}`;
  // Load with includeDeleted to preserve original entity fields
  const note = await ctx.loadOrDefault(noteKey, { includeDeleted: true });

  // LWW via deletedTs
  if (ctx.isStaleByLWW(note)) return;

  // Get parent URL from orphaned entries or note.url
  const orphaned = ctx.result['manifest:orphaned'] || await ctx.loadOrDefault('manifest:orphaned');
  const orphanEntry = (orphaned.entries || []).find(e => e.key === noteKey);
  const noteUrl = orphanEntry?.url || note.url || entry.url;
  // Re-link to parent page
  if (noteUrl) {
    const pageKey = PAGE_PREFIX + generateSlugFromUrl(noteUrl);
    await ctx.linkChild(noteKey, [pageKey]);
  }
  // Clear deleted flag
  const restoredNote = { ...note, deleted: false, deletedTs: entry.timestamp };
  ctx.result[noteKey] = restoredNote;
  await ctx.unorphan(noteKey, entry.timestamp);
}

async function handleDeleteSnapshot(ctx) {
  const { entry } = ctx;
  const snapStem = entry.path.slice('snapshots/'.length);
  const snapKey = `${SNAPSHOT_PREFIX}${snapStem}`;
  const slug = generateSlugFromUrl(entry.url);
  const pageKey = PAGE_PREFIX + slug;
  await ctx.unlinkChild(snapKey, [pageKey]);
  // GC parent page if it became ineligible
  const snapPage = ctx.result[pageKey];
  if (snapPage && !isPageEligible(snapPage)) ctx.result[pageKey] = null;
  await ctx.orphan(snapKey, entry.timestamp, entry.url);
}

async function handleRestoreSnapshot(ctx) {
  const { entry } = ctx;
  const snapStem = entry.path.slice('snapshots/'.length);
  const snapKey = `${SNAPSHOT_PREFIX}${snapStem}`;
  const slug = generateSlugFromUrl(entry.url);
  const pageKey = PAGE_PREFIX + slug;
  await ctx.linkChild(snapKey, [pageKey]);
  await ctx.unorphan(snapKey, entry.timestamp);
}

async function handleReplaceNote(ctx) {
  const { entry } = ctx;
  const oldNoteSlug = entry.oldPath.slice('notes/'.length, -'.json'.length);
  const oldNoteKey = `${NOTE_PREFIX}${oldNoteSlug}`;
  const newNoteSlug = entry.path.slice('notes/'.length, -'.json'.length);
  const newNoteKey = `${NOTE_PREFIX}${newNoteSlug}`;

  // Load old note
  const oldNote = await ctx.loadOrDefault(oldNoteKey, { includeDeleted: true });

  // Derive page key from old note's url
  const noteUrl = oldNote.url || entry.url;
  if (noteUrl) {
    const pageKey = PAGE_PREFIX + generateSlugFromUrl(noteUrl);
    await ctx.unlinkChild(oldNoteKey, [pageKey]);
    // Page may have been GC'd by a concurrent delete_note; re-create it
    await ctx.ensurePageEntity(noteUrl, entry.timestamp);
    await ctx.linkChild(newNoteKey, [pageKey]);
  }

  // Transfer list pins: replace old note with new note in each list
  const listKeys = await ctx.findListsWithPin(oldNoteKey);
  for (const lk of listKeys) {
    const list = ctx.result[lk] !== undefined ? ctx.result[lk] : await ctx.load(lk);
    if (!list) continue;
    const pins = (list.pins || []).map(p =>
      p.id === oldNoteKey ? { ...p, id: newNoteKey } : p
    );
    ctx.result[lk] = { ...list, pins };
  }

  // Set up new note with url from old note.
  // If the new note file can't be loaded (transient save error, missing file),
  // inherit content fields from the old note — these are primary user data
  // (excerpt, cssPath, note text) that would be lost if we fell back to defaultEntity.
  const newNote = ctx.result[newNoteKey] !== undefined ? ctx.result[newNoteKey] : await ctx.load(newNoteKey);
  if (newNote) {
    ctx.result[newNoteKey] = { ...newNote, url: noteUrl };
  } else {
    ctx.result[newNoteKey] = {
      ...defaultEntity(newNoteKey),
      excerpt: oldNote.excerpt,
      cssPath: oldNote.cssPath,
      note: oldNote.note,
      url: noteUrl,
    };
  }

  // Mark old note as replaced + orphan (LWW — only if our timestamp wins)
  const oldDeletedTs = oldNote.deletedTs || 0;
  if (entry.timestamp > oldDeletedTs) {
    ctx.result[oldNoteKey] = {
      ...oldNote, deleted: true, deletedTs: entry.timestamp,
      deletionReason: 'replaced', replacedBy: newNoteKey,
    };
    await ctx.orphan(oldNoteKey, entry.timestamp, noteUrl);
  }
}

async function handlePinToList(ctx) {
  const { entry } = ctx;
  const listKey = await ctx.resolveListKey(entry.name);
  if (!listKey) return;

  const entity = await ctx.loadListForMutation(listKey);
  if (!entity) return;
  const pins = [...(entity.pins || [])];

  for (const item of (entry.items || [])) {
    // Resolve item to pin ID — notes use path prefix, others are URLs
    let pinId;
    if (item.startsWith('notes/')) {
      // Note path: "notes/<slug>.json" → "note:<slug>"
      const noteSlug = item.slice('notes/'.length, -'.json'.length);
      pinId = NOTE_PREFIX + noteSlug;
    } else {
      const slug = generateSlugFromUrl(item);
      const pageKey = PAGE_PREFIX + slug;
      await ctx.ensurePageEntity(item, entry.timestamp, entry.titles?.[item]);
      pinId = pageKey;
    }

    if (!pins.some(p => p.id === pinId)) {
      const pin = { id: pinId, pinnedAt: entry.timestamp };
      if (entry.source) pin.source = entry.source;
      pins.push(pin);
    }

    // Update page parentIds with list key (notes don't track parentIds)
    if (pinId.startsWith(PAGE_PREFIX)) {
      const page = ctx.result[pinId] || await ctx.load(pinId);
      if (page) {
        const parentIds = [...(page.parentIds || [])];
        if (!parentIds.includes(listKey)) parentIds.push(listKey);
        ctx.result[pinId] = { ...page, parentIds };
      }
    }
  }

  ctx.result[listKey] = { ...touchTimestamp(entity, ctx.context.deviceId, ctx.entry.timestamp), pins };
}

async function handleUnpinFromList(ctx) {
  const { entry } = ctx;
  const listKey = await ctx.resolveListKey(entry.name);
  if (!listKey) return;

  const entity = await ctx.loadListForMutation(listKey);
  if (!entity) return;
  const removeIds = new Set();

  for (const item of (entry.items || [])) {
    let pinId;
    if (item.startsWith('notes/')) {
      const noteSlug = item.slice('notes/'.length, -'.json'.length);
      pinId = NOTE_PREFIX + noteSlug;
    } else {
      pinId = PAGE_PREFIX + generateSlugFromUrl(item);
    }
    removeIds.add(pinId);
  }

  const pins = (entity.pins || []).filter(p => !removeIds.has(p.id));
  ctx.result[listKey] = { ...touchTimestamp(entity, ctx.context.deviceId, ctx.entry.timestamp), pins };

  // Update page parentIds: remove list key (notes don't track parentIds)
  for (const pinId of removeIds) {
    if (pinId.startsWith(PAGE_PREFIX)) {
      const page = await ctx.load(pinId);
      if (page) {
        const parentIds = (page.parentIds || []).filter(p => p !== listKey);
        const updated = { ...page, parentIds };
        ctx.result[pinId] = isPageEligible(updated) ? updated : null;
      }
    }
  }
}

async function handleAddRule(ctx) {
  const { entry } = ctx;
  const listKey = await ctx.resolveListKey(entry.name);
  if (!listKey) return;

  const entity = await ctx.loadListForMutation(listKey);
  if (!entity) return;
  const rules = [...(entity.rules || [])];
  const ruleId = entry.rule.id || generateRuleId(entry.rule.type, entry.timestamp);

  // Idempotent: skip if rule with same ID already exists
  if (!rules.some(r => r.id === ruleId)) {
    rules.push({
      id: ruleId,
      type: entry.rule.type,
      config: entry.rule.config,
      createdAt: entry.timestamp,
    });
  }

  ctx.result[listKey] = { ...touchTimestamp(entity, ctx.context.deviceId, ctx.entry.timestamp), rules };
}

async function handleRemoveRule(ctx) {
  const { entry } = ctx;
  const listKey = await ctx.resolveListKey(entry.name);
  if (!listKey) return;

  const entity = await ctx.loadListForMutation(listKey);
  if (!entity) return;
  const rules = (entity.rules || []).filter(r => r.id !== entry.ruleId);
  ctx.result[listKey] = { ...touchTimestamp(entity, ctx.context.deviceId, ctx.entry.timestamp), rules };
}

async function handleUpdateRule(ctx) {
  const { entry } = ctx;
  const listKey = await ctx.resolveListKey(entry.name);
  if (!listKey) return;

  const entity = await ctx.loadListForMutation(listKey);
  if (!entity) return;
  const rules = (entity.rules || []).map(r => {
    if (r.id !== entry.ruleId) return r;
    return { ...r, config: { ...r.config, ...entry.config } };
  });
  ctx.result[listKey] = { ...touchTimestamp(entity, ctx.context.deviceId, ctx.entry.timestamp), rules };
}

async function handleCreateList(ctx) {
  const { entry } = ctx;
  const nameToId = ctx.result['manifest:name-to-id'] || await ctx.loadOrDefault('manifest:name-to-id');
  const paths = { ...nameToId.paths };

  // Resolve parent for tree placement (optional)
  const parentKey = entry.parentListId ? LIST_PREFIX + entry.parentListId : null;

  // Use provided listId (migrated events) or generate from name+timestamp (new events)
  const listId = entry.listId || (entry.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').substring(0, 30) + '-' + Math.abs(hashString(entry.name + entry.timestamp)).toString(36));
  const listKey = LIST_PREFIX + listId;

  // Idempotency: if entity already exists, this is a redundant replay — skip
  const existing = ctx.result[listKey] !== undefined ? ctx.result[listKey] : await ctx.load(listKey);
  if (existing) return;

  // Create list entity (no parentList/childLists)
  const entity = defaultEntity(listKey);
  entity.name = entry.name;
  entity.owner = entry.listOwner;
  entity.timestamps = { [ctx.context.deviceId]: entry.timestamp };
  ctx.result[listKey] = entity;

  // Append to tree manifest
  const treeEntity = ctx.result['manifest:list-order'] || await ctx.loadOrDefault('manifest:list-order');
  const newTree = appendToTree(treeEntity.tree || [], listKey, parentKey);
  ctx.result['manifest:list-order'] = { ...touchTimestamp(treeEntity, ctx.context.deviceId, ctx.entry.timestamp), tree: newTree };

  // Update name-to-id: compound key owner/name
  const nameKey = entry.listOwner + '/' + entry.name;
  paths[nameKey] = listId;
  ctx.result['manifest:name-to-id'] = { ...touchTimestamp(nameToId, ctx.context.deviceId, ctx.entry.timestamp), paths };
}

async function handleUpdateList(ctx) {
  const { entry } = ctx;
  const listKey = await ctx.resolveListKey(entry.name);
  if (!listKey) return;

  // Guard: reject actions on orphaned (deleted) lists
  const entity = await ctx.loadListForMutation(listKey);
  if (!entity) return;
  const updated = touchTimestamp(entity, ctx.context.deviceId, ctx.entry.timestamp);

  if (entry.newName !== undefined) {
    const oldName = entity.name;
    updated.name = entry.newName;

    // Update name-to-id: delete old key, add new key
    if (oldName !== entry.newName) {
      const nameToId = ctx.result['manifest:name-to-id'] || await ctx.loadOrDefault('manifest:name-to-id');
      const paths = { ...nameToId.paths };
      const listId = entitySlug(listKey);
      const owner = entity.owner;
      const oldKey = owner + '/' + oldName;
      const newKey = owner + '/' + entry.newName;
      delete paths[oldKey];
      paths[newKey] = listId;
      ctx.result['manifest:name-to-id'] = { ...touchTimestamp(nameToId, ctx.context.deviceId, ctx.entry.timestamp), paths };
    }
  }

  ctx.result[listKey] = updated;
}

async function handleUpdateListTree(ctx) {
  const { entry } = ctx;
  const treeEntity = ctx.result['manifest:list-order'] || await ctx.loadOrDefault('manifest:list-order');
  const treeDeviceTs = (treeEntity.timestamps || {})[ctx.context.deviceId] || 0;
  if (treeDeviceTs >= entry.timestamp) return;
  // Reconcile the accepted tree against current entity state:
  // remove deleted lists (promote children), append non-deleted lists missing from tree.
  function collectIds(nodes) {
    const ids = new Set();
    for (const n of nodes) {
      ids.add(n.id);
      if (n.children) for (const id of collectIds(n.children)) ids.add(id);
    }
    return ids;
  }
  let newTree = entry.tree;
  const treeIds = collectIds(newTree);
  let reconciled = newTree.map(deepCloneTree);
  // Remove deleted lists from tree (promotes children)
  for (const id of treeIds) {
    if (isSystemList(id)) continue;
    const entity = await ctx.load(id, { includeDeleted: true });
    if (entity?.deleted) {
      reconciled = removeFromTree(reconciled, id);
    }
  }
  // Append non-deleted lists that exist in name-to-id but are missing from tree
  const reconciledIds = collectIds(reconciled);
  const nameToId = ctx.result['manifest:name-to-id'] || await ctx.loadOrDefault('manifest:name-to-id');
  for (const listId of Object.values(nameToId.paths || {})) {
    const listKey = LIST_PREFIX + listId;
    if (reconciledIds.has(listKey)) continue;
    if (isSystemList(listKey)) continue;
    const entity = await ctx.load(listKey, { includeDeleted: true });
    if (entity && !entity.deleted) {
      reconciled.push({ id: listKey });
      reconciledIds.add(listKey);
    }
  }
  newTree = reconciled;
  ctx.result['manifest:list-order'] = { ...touchTimestamp(treeEntity, ctx.context.deviceId, ctx.entry.timestamp), tree: newTree };
}

async function handleDeleteList(ctx) {
  const { entry } = ctx;
  const listKey = await ctx.resolveListKey(entry.name);
  if (!listKey) return;

  if (isSystemList(listKey)) return;

  const entity = await ctx.loadOrDefault(listKey, { includeDeleted: true });
  // LWW via deletedTs
  if (ctx.isStaleByLWW(entity)) return;

  // Mark deleted
  const deletedEntity = { ...touchTimestamp(entity, ctx.context.deviceId, ctx.entry.timestamp), deleted: true, deletedTs: entry.timestamp };
  ctx.result[listKey] = deletedEntity;

  // Remove from tree manifest (promotes children to parent level)
  const treeEntity = ctx.result['manifest:list-order'] || await ctx.loadOrDefault('manifest:list-order');
  ctx.result['manifest:list-order'] = { ...touchTimestamp(treeEntity, ctx.context.deviceId, ctx.entry.timestamp), tree: removeFromTree(treeEntity.tree || [], listKey) };

  // Remove list key from all pinned page parentIds (notes don't track parentIds)
  const pins = entity.pins || [];
  for (const pin of pins) {
    if (pin.id.startsWith(PAGE_PREFIX)) {
      const page = await ctx.load(pin.id);
      if (!page) continue;
      const parentIds = (page.parentIds || []).filter(p => p !== listKey);
      const updated = { ...page, parentIds };
      ctx.result[pin.id] = isPageEligible(updated) ? updated : null;
    }
  }

  // Remove from name-to-id
  const nameToId = ctx.result['manifest:name-to-id'] || await ctx.loadOrDefault('manifest:name-to-id');
  const paths = { ...nameToId.paths };
  const listName = entity.name || entry.name;
  const nameKey = entity.owner + '/' + listName;
  delete paths[nameKey];
  ctx.result['manifest:name-to-id'] = { ...touchTimestamp(nameToId, ctx.context.deviceId, ctx.entry.timestamp), paths };

  await ctx.orphan(listKey, entry.timestamp);
}

async function handleRestoreList(ctx) {
  const { entry } = ctx;
  // Resolve by name-to-id first; if not found (deleted), try to find by searching entities
  let listKey = await ctx.resolveListKey(entry.name);

  // Deleted lists are removed from name-to-id, so resolve from orphaned entities
  if (!listKey) {
    const orphanedEntity = await ctx.loadOrDefault('manifest:orphaned');
    for (const oe of (orphanedEntity.entries || [])) {
      const key = oe.key;
      if (!key.startsWith(LIST_PREFIX) || isSystemList(key)) continue;
      const entity = await ctx.load(key, { includeDeleted: true });
      if (!entity) continue;
      if (entity.owner === entry.listOwner && entity.name === entry.name) { listKey = key; break; }
    }
  }
  if (!listKey) return;

  // Load list entity with includeDeleted to preserve original fields
  const entity = await ctx.loadOrDefault(listKey, { includeDeleted: true });

  // LWW via deletedTs
  if (ctx.isStaleByLWW(entity)) return;

  const restored = { ...touchTimestamp(entity, ctx.context.deviceId, ctx.entry.timestamp), deleted: false, deletedTs: entry.timestamp };
  ctx.result[listKey] = restored;

  // Append to tree manifest as top-level node
  const treeEntity = ctx.result['manifest:list-order'] || await ctx.loadOrDefault('manifest:list-order');
  const tree = treeEntity.tree || [];
  // Only add if not already in tree
  const inTree = (function findInTree(nodes) {
    for (const n of nodes) {
      if (n.id === listKey) return true;
      if (n.children && findInTree(n.children)) return true;
    }
    return false;
  })(tree);
  if (!inTree) {
    ctx.result['manifest:list-order'] = { ...touchTimestamp(treeEntity, ctx.context.deviceId, ctx.entry.timestamp), tree: [...tree.map(deepCloneTree), { id: listKey }] };
  }

  // Restore page parentIds for pins
  const pins = restored.pins || [];
  for (const pin of pins) {
    if (pin.id.startsWith(PAGE_PREFIX)) {
      const page = await ctx.load(pin.id);
      if (!page) continue;
      const parentIds = [...(page.parentIds || [])];
      if (!parentIds.includes(listKey)) parentIds.push(listKey);
      ctx.result[pin.id] = { ...page, parentIds };
    }
  }

  // Re-add to name-to-id
  const nameToId = ctx.result['manifest:name-to-id'] || await ctx.loadOrDefault('manifest:name-to-id');
  const paths = { ...nameToId.paths };
  const listName = restored.name || entry.name;
  const listId = entitySlug(listKey);
  const nameKey = restored.owner + '/' + listName;
  paths[nameKey] = listId;
  ctx.result['manifest:name-to-id'] = { ...touchTimestamp(nameToId, ctx.context.deviceId, ctx.entry.timestamp), paths };

  await ctx.unorphan(listKey, entry.timestamp);
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

const ACTION_HANDLERS = {
  update_setting: handleUpdateSetting,
  visit_page: handleVisitPage,
  leave_page: handleLeavePage,
  rename_page: handleRenamePage,
  rate_page: handleRatePage,
  create_snapshot: handleCreateSnapshot,
  create_note: handleCreateNote,
  delete_note: handleDeleteNote,
  restore_note: handleRestoreNote,
  delete_snapshot: handleDeleteSnapshot,
  restore_snapshot: handleRestoreSnapshot,
  replace_note: handleReplaceNote,
  pin_to_list: handlePinToList,
  unpin_from_list: handleUnpinFromList,
  add_rule: handleAddRule,
  remove_rule: handleRemoveRule,
  update_rule: handleUpdateRule,
  create_list: handleCreateList,
  update_list: handleUpdateList,
  update_list_tree: handleUpdateListTree,
  delete_list: handleDeleteList,
  restore_list: handleRestoreList,
};

/**
 * Compute the effect of a log entry against a backing store.
 * load(key) → entity | null   — async closure that reads from any backing store
 *                                (session cache, filesystem + round cache, etc.)
 *
 * Returns { key: updatedEntity | null } for every affected key.
 * Each action branch loads what it needs and applies immediately.
 */
export async function effectOf(entry, load, context = {}) {
  const ctx = new ReplayContext(entry, load, context);
  const handler = ACTION_HANDLERS[entry.action];
  if (handler) await handler(ctx);
  return ctx.result;
}

// ---------------------------------------------------------------------------
// Helper: simple string hash (same as generateSlug in utils.js)
// ---------------------------------------------------------------------------

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Per-entity apply functions (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Apply a log entry to settings state.
 * Entry: { timestamp, action: 'update_setting', key, value }
 * Returns new settings object (or original if entry is irrelevant).
 */
export function applyLogToSettings(settings, entry, context = {}) {
  if (entry.action !== 'update_setting') return settings;
  return { ...touchTimestamp(settings, context.deviceId, entry.timestamp), [entry.key]: entry.value };
}
