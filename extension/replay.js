// replay.js — pure functions for applying log entries to entity state.
// Imported by both background.js (cache-miss replay) and offscreen.js (checkpoint).
// Each function is idempotent — safe to replay the same entry twice.
import { generateSlugFromUrl, isGatewayRoot } from './utils.js';

const REFERRER_CAP = 50;

const PAGE_PREFIX = 'page:';
const NOTE_PREFIX = 'note:';
const SNAP_PREFIX = 'snap:';
const SHALLOW_PREFIX = 'shallow:';

/**
 * Return the set of page keys that an entry affects.
 * A visit entry with a referrerId affects both its own key (child-side: parentIds, visitDates)
 * and the referrer's key (parent-side: childIds accumulation).
 * All other entry types affect only the entry's own key.
 */
export function getAffectedKeys(entry) {
  const keys = new Set();
  const entrySlug = entry.slug || (entry.url ? generateSlugFromUrl(entry.url) : null);
  if (entrySlug) keys.add(PAGE_PREFIX + entrySlug);

  // Page entries with referrerId also affect the parent page
  if (entry.action === 'page' && entry.referrerId) {
    const parentKey = entry.referrerId; // already page:slug format
    if (parentKey !== PAGE_PREFIX + entrySlug) keys.add(parentKey);
  }

  // Snap/del_snap/restore_snap affect parent pages
  if ((entry.action === 'snap' || entry.action === 'del_snap' || entry.action === 'restore_snap') && entry.parentIds) {
    for (const parentKey of entry.parentIds) keys.add(parentKey);
  }

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
    return { slug, timestamp: 0, parentIds: [], childIds: [] };
  }
  if (key.startsWith(NOTE_PREFIX)) {
    const slug = key.slice(NOTE_PREFIX.length);
    return { slug, timestamp: 0, excerpt: null, note: null, cssPath: null, parentIds: [], childIds: [] };
  }
  if (key === 'settings') return { timestamp: 0 };
  if (key === 'list:system/shallow-page') return { timestamp: 0, index: {} };
  if (key === 'list:system/gateways') return { timestamp: 0, origins: [] };
  if (key === 'list:system/orphaned') return { timestamp: 0, keys: [] };
  if (key === 'list:system/root') return { timestamp: 0, childLists: [] };
  if (key.startsWith('list:')) {
    const slug = key.slice('list:'.length);
    return { timestamp: 0, slug, name: '', qbTrees: [], pins: [], parentList: null, childLists: [] };
  }
  return null;
}

/** Load entity, falling back to defaultEntity for non-page/non-note keys. */
async function loadOrDefault(key, load) {
  return (await load(key)) ?? defaultEntity(key);
}

/** Load a page entity; only page_checkpoint can create from null. */
async function loadPage(key, load, canCreate) {
  const entity = await load(key);
  if (entity) return entity;
  return canCreate ? defaultEntity(key) : null;
}

/**
 * Compute the effect of a log entry against a backing store.
 * load(key) → entity | null   — async closure that reads from any backing store
 *                                (session cache, filesystem + round cache, etc.)
 *
 * Returns { key: updatedEntity | null } for every affected key.
 * Each action branch loads what it needs and applies immediately.
 */
export async function effectOf(entry, load) {
  const result = {};

  // --- shared helpers for link/unlink/orphan across note, snap, and list branches ---
  async function linkChild(childKey, parentIds) {
    if (!parentIds) return;
    for (const parentKey of parentIds) {
      const parent = await load(parentKey);
      if (!parent) { result[parentKey] = null; continue; }
      const childIds = [...(parent.childIds || [])];
      if (!childIds.includes(childKey)) childIds.push(childKey);
      result[parentKey] = { ...parent, childIds };
    }
  }

  async function unlinkChild(childKey, parentIds) {
    if (!parentIds) return;
    for (const parentKey of parentIds) {
      const parent = await load(parentKey);
      if (!parent) { result[parentKey] = null; continue; }
      const childIds = (parent.childIds || []).filter(c => c !== childKey);
      result[parentKey] = { ...parent, childIds };
    }
  }

  async function orphan(childKey, ts) {
    const orphaned = result['list:system/orphaned'] || await loadOrDefault('list:system/orphaned', load);
    const keys = [...(orphaned.keys || [])];
    if (!keys.includes(childKey)) keys.push(childKey);
    result['list:system/orphaned'] = { ...orphaned, timestamp: ts, keys };
  }

  async function unorphan(childKey, ts) {
    const orphaned = result['list:system/orphaned'] || await loadOrDefault('list:system/orphaned', load);
    const keys = (orphaned.keys || []).filter(k => k !== childKey);
    result['list:system/orphaned'] = { ...orphaned, timestamp: ts, keys };
  }

  // --- settings ---
  if (entry.action === 'set') {
    const settings = await loadOrDefault('settings', load);
    result['settings'] = applyLogToSettings(settings, entry);
    return result;
  }

  // --- list / list_meta / del_list ---
  if (entry.action === 'list' || entry.action === 'list_meta' || entry.action === 'del_list') {
    const listKey = `list:${entry.id}`;

    // Guard: reject list/list_meta actions on orphaned (deleted) lists
    if (entry.action !== 'del_list' && !listKey.startsWith('list:system/')) {
      const orphaned = await loadOrDefault('list:system/orphaned', load);
      if ((orphaned.keys || []).includes(listKey)) {
        return result;
      }
    }

    const entity = await loadOrDefault(listKey, load);
    if (listKey === 'list:system/gateways') {
      result[listKey] = applyLogToGateways(entity, entry);
    } else {
      result[listKey] = applyLogToPins(entity, entry);
    }

    // List entries with shallow: ids also update the shallow-page index
    if (entry.action === 'list' && entry.ids?.some(id => id.startsWith(SHALLOW_PREFIX))) {
      const spi = await loadOrDefault('list:system/shallow-page', load);
      let updatedSpi = applyLogToShallowPage(spi, entry);

      // Enrich newly-created SPI entries that have title=null from history
      if (entry.op === 'add') {
        const shallowUrls = entry.ids
          .filter(id => id.startsWith(SHALLOW_PREFIX))
          .map(id => id.slice(SHALLOW_PREFIX.length));
        const needTitle = shallowUrls.filter(url => updatedSpi.index[url] && !updatedSpi.index[url].title);
        if (needTitle.length > 0) {
          const dateStr = new Date(entry.timestamp).toISOString().slice(0, 10);
          const todayEntries = (await load('history:' + dateStr)) || [];
          let sources = todayEntries;
          // Also check yesterday (visit may have been logged the day before)
          let remaining = needTitle.filter(url => !sources.find(e => e.url === url && e.title));
          if (remaining.length > 0) {
            const yest = new Date(entry.timestamp);
            yest.setDate(yest.getDate() - 1);
            const yestEntries = (await load('history:' + yest.toISOString().slice(0, 10))) || [];
            sources = [...sources, ...yestEntries];
          }
          let changed = false;
          const index = { ...updatedSpi.index };
          for (const url of needTitle) {
            const match = sources.find(e => e.url === url && e.title);
            if (match) {
              index[url] = { ...index[url], title: match.title };
              changed = true;
            }
          }
          if (changed) updatedSpi = { ...updatedSpi, index };
        }
      }

      result['list:system/shallow-page'] = updatedSpi;
    }

    // list_meta → sync root/parent for new lists + handle reparent
    if (entry.action === 'list_meta' && !listKey.startsWith('list:system/')) {
      const entity = result[listKey]; // already updated by applyLogToPins above

      // NEW LIST: if entity has no parentList yet → add to root's childLists, set parentList
      if (!entity.parentList) {
        const root = result['list:system/root'] || await loadOrDefault('list:system/root', load);
        if (!(root.childLists || []).includes(listKey)) {
          result['list:system/root'] = { ...root, timestamp: entry.timestamp, childLists: [...(root.childLists || []), listKey] };
        }
        entity.parentList = 'list:system/root';
        result[listKey] = entity;
      }

      // REPARENT: { from, to, index }
      if (entry.reparent) {
        const { from, to, index } = entry.reparent;
        const fromKey = 'list:' + from;
        const toKey = 'list:' + to;
        // Remove from source parent's childLists
        const fromEntity = result[fromKey] || await loadOrDefault(fromKey, load);
        fromEntity.childLists = (fromEntity.childLists || []).filter(k => k !== listKey);
        result[fromKey] = { ...fromEntity, timestamp: entry.timestamp };
        // Add to destination parent's childLists at index
        const toEntity = (toKey === fromKey) ? result[fromKey] : (result[toKey] || await loadOrDefault(toKey, load));
        const cl = [...(toEntity.childLists || [])].filter(k => k !== listKey);
        cl.splice(index, 0, listKey);
        result[toKey] = { ...toEntity, timestamp: entry.timestamp, childLists: cl };
        // Update child's parentList
        entity.parentList = toKey;
        result[listKey] = entity;
      }
    }

    // del_list → remove from parent's childLists + soft-delete subtree descendants
    if (entry.action === 'del_list' && !listKey.startsWith('list:system/')) {
      const deletedEntity = result[listKey]; // already set by applyLogToPins with full shape
      // 1. Remove from parent's childLists (parentList is on entity)
      const parentKey = deletedEntity.parentList || 'list:system/root';
      const parent = result[parentKey] || await loadOrDefault(parentKey, load);
      result[parentKey] = { ...parent, timestamp: entry.timestamp, childLists: (parent.childLists || []).filter(k => k !== listKey) };
      // 2. Soft-delete all descendants (subtreeKeys provided by handler)
      for (const childKey of (entry.subtreeKeys || [])) {
        const child = result[childKey] || await loadOrDefault(childKey, load);
        result[childKey] = { ...child, timestamp: entry.timestamp, deleted: true };
        await orphan(childKey, entry.timestamp);
      }
    }

    // list pin/unpin → update page parentIds with list:<id>
    if (entry.action === 'list' && entry.ids && !listKey.startsWith('list:system/')) {
      const pageIds = entry.ids.filter(id => id.startsWith(PAGE_PREFIX));
      for (const pageKey of pageIds) {
        const page = await load(pageKey);
        if (!page) continue;
        const parentIds = [...(page.parentIds || [])];
        if (entry.op === 'add') {
          if (!parentIds.includes(listKey)) parentIds.push(listKey);
        } else if (entry.op === 'del') {
          const idx = parentIds.indexOf(listKey);
          if (idx >= 0) parentIds.splice(idx, 1);
        }
        result[pageKey] = { ...page, parentIds };
      }
    }

    // del_list → remove list:<id> from all pinned page parentIds + clean SPI + orphan
    if (entry.action === 'del_list' && !listKey.startsWith('list:system/')) {
      const pins = entity.pins || [];
      const shallowUrls = [];
      for (const pin of pins) {
        if (pin.id.startsWith(PAGE_PREFIX)) {
          const page = await load(pin.id);
          if (!page) continue;
          const parentIds = (page.parentIds || []).filter(p => p !== listKey);
          result[pin.id] = { ...page, parentIds };
        } else if (pin.id.startsWith(SHALLOW_PREFIX)) {
          shallowUrls.push(pin.id.slice(SHALLOW_PREFIX.length));
        }
      }
      // Remove list from SPI lists for shallow pins
      if (shallowUrls.length > 0) {
        const spi = result['list:system/shallow-page'] || await loadOrDefault('list:system/shallow-page', load);
        const index = { ...spi.index };
        for (const url of shallowUrls) {
          if (index[url]) {
            index[url] = { ...index[url], lists: (index[url].lists || []).filter(l => l !== listKey) };
          }
        }
        result['list:system/shallow-page'] = { ...spi, timestamp: entry.timestamp, index };
      }
      await orphan(listKey, entry.timestamp);
    }

    return result;
  }

  // --- note: wire note as child of parent pages (content is on disk, not in log) ---
  if (entry.action === 'note') {
    const noteKey = `${NOTE_PREFIX}${entry.slug}`;
    await linkChild(noteKey, entry.parentIds);
    return result;
  }

  // --- del_note: unlink note from parents + add to orphaned list ---
  if (entry.action === 'del_note') {
    const noteKey = `${NOTE_PREFIX}${entry.slug}`;
    await unlinkChild(noteKey, entry.parentIds);
    await orphan(noteKey, entry.timestamp);
    return result;
  }

  // --- restore_note: re-link note to parents + remove from orphaned list ---
  if (entry.action === 'restore_note') {
    const noteKey = `${NOTE_PREFIX}${entry.slug}`;
    await linkChild(noteKey, entry.parentIds);
    await unorphan(noteKey, entry.timestamp);
    return result;
  }

  // --- snap: wire snapshot as child of parent page (content is on disk, not in log) ---
  if (entry.action === 'snap') {
    const snapKey = `${SNAP_PREFIX}${entry.slug}`;
    await linkChild(snapKey, entry.parentIds);
    return result;
  }

  // --- del_snap: unlink snapshot from parents + add to orphaned list ---
  if (entry.action === 'del_snap') {
    const snapKey = `${SNAP_PREFIX}${entry.slug}`;
    await unlinkChild(snapKey, entry.parentIds);
    await orphan(snapKey, entry.timestamp);
    return result;
  }

  // --- restore_snap: re-link snapshot to parents + remove from orphaned list ---
  if (entry.action === 'restore_snap') {
    const snapKey = `${SNAP_PREFIX}${entry.slug}`;
    await linkChild(snapKey, entry.parentIds);
    await unorphan(snapKey, entry.timestamp);
    return result;
  }

  // --- restore_list: re-add to root, clear deleted flag, restore subtree + page parentIds ---
  if (entry.action === 'restore_list') {
    const listKey = `list:${entry.id}`;

    // Load list entity — may be null if readCacheable filters deleted: true.
    // Fall back to default, then overlay with entry data (name, pins from handler).
    const entity = await loadOrDefault(listKey, load);
    // Clear deleted flag and update timestamp
    const restored = { ...entity, deleted: false, timestamp: entry.timestamp };
    if (entry.name) restored.name = entry.name;
    // Restore pins from log entry (handler passes them since load may filter deleted entities)
    if (entry.pins) restored.pins = entry.pins;
    result[listKey] = restored;

    // Re-add to root's childLists (restored lists always go to root)
    const root = result['list:system/root'] || await loadOrDefault('list:system/root', load);
    const rootCL = [...(root.childLists || [])];
    if (!rootCL.includes(listKey)) rootCL.push(listKey);
    result['list:system/root'] = { ...root, timestamp: entry.timestamp, childLists: rootCL };
    // Update restored entity's parentList to root
    restored.parentList = 'list:system/root';
    result[listKey] = restored;
    // Restore all descendants
    for (const childKey of (entry.subtreeKeys || [])) {
      const child = result[childKey] || await loadOrDefault(childKey, load);
      result[childKey] = { ...child, deleted: false, timestamp: entry.timestamp };
      await unorphan(childKey, entry.timestamp);
    }

    // Restore page parentIds for checkpointed pins (use entry.pins — authoritative)
    const pins = entry.pins || restored.pins || [];
    for (const pin of pins) {
      if (pin.id.startsWith(PAGE_PREFIX)) {
        const page = await load(pin.id);
        if (!page) continue;
        const parentIds = [...(page.parentIds || [])];
        if (!parentIds.includes(listKey)) parentIds.push(listKey);
        result[pin.id] = { ...page, parentIds };
      } else if (pin.id.startsWith(SHALLOW_PREFIX)) {
        // Re-add list to SPI lists for shallow pins
        const url = pin.id.slice(SHALLOW_PREFIX.length);
        const spi = result['list:system/shallow-page'] || await loadOrDefault('list:system/shallow-page', load);
        const index = { ...spi.index };
        if (index[url]) {
          const lists = [...(index[url].lists || [])];
          if (!lists.includes(listKey)) lists.push(listKey);
          index[url] = { ...index[url], lists };
        }
        result['list:system/shallow-page'] = { ...spi, timestamp: entry.timestamp, index };
      }
    }

    await unorphan(listKey, entry.timestamp);

    return result;
  }

  // --- page ---
  if (entry.action === 'page') {
    // Skip parent-side childIds accumulation when parent is a gateway root
    const gatewayOrigins = entry.referrerId
      ? (await loadOrDefault('list:system/gateways', load)).origins || []
      : [];
    // Apply to each affected page (entry's own page + referrer parent)
    for (const pageKey of getAffectedKeys(entry)) {
      const page = await load(pageKey);
      if (!page) { result[pageKey] = null; continue; }
      // Skip parent-side update for gateway roots (too many children)
      if (pageKey === entry.referrerId && page.url && isGatewayRoot(page.url, gatewayOrigins)) continue;
      result[pageKey] = applyLogToPage(page, entry);
    }

    // Update shallow-page index if entry carries referrer/title info
    if (entry.referrerId || entry.title || entry.user_title) {
      const spi = await loadOrDefault('list:system/shallow-page', load);
      let updated = applyLogToShallowPage(spi, entry);
      // Prune SPI entries for pages that exist in scope
      if (updated.index) {
        let pruned = false;
        const index = { ...updated.index };
        for (const url of Object.keys(index)) {
          const pk = PAGE_PREFIX + generateSlugFromUrl(url);
          if (result[pk] !== undefined && result[pk] !== null) {
            delete index[url]; pruned = true;
          }
        }
        if (pruned) updated = { ...updated, index };
      }
      result['list:system/shallow-page'] = updated;
    }

    // Resolve shallow:<url> refs in parentIds/childIds to page:<slug>
    for (const [key, entity] of Object.entries(result)) {
      if (!key.startsWith(PAGE_PREFIX) || !entity) continue;
      let cur = entity;
      for (const field of ['parentIds', 'childIds']) {
        if (!cur[field]?.length) continue;
        let changed = false;
        const resolved = cur[field].map(ref => {
          if (typeof ref !== 'string' || !ref.startsWith(SHALLOW_PREFIX)) return ref;
          const refKey = PAGE_PREFIX + generateSlugFromUrl(ref.slice(SHALLOW_PREFIX.length));
          if (result[refKey] !== undefined && result[refKey] !== null) { changed = true; return refKey; }
          return ref;
        });
        if (changed) cur = { ...cur, [field]: resolved };
      }
      if (cur !== entity) result[key] = cur;
    }
    return result;
  }

  // --- page_checkpoint ---
  if (entry.action === 'page_checkpoint') {
    const slug = generateSlugFromUrl(entry.url);
    const pageKey = `${PAGE_PREFIX}${slug}`;
    const page = await loadPage(pageKey, load, true);
    result[pageKey] = applyLogToPage(page, entry);

    // Absorption: move SPI data into new page entity, upgrade list pins
    const spi = await loadOrDefault('list:system/shallow-page', load);
    const shallowEntry = spi.index?.[entry.url];
    if (shallowEntry) {
      // Absorb parent refs into page.parentIds
      const parentRefs = shallowEntry.parentIds || [];
      if (parentRefs.length > 0) {
        const p = result[pageKey];
        const parentIds = [...(p.parentIds || [])];
        for (const ref of parentRefs) {
          if (!parentIds.includes(ref)) parentIds.push(ref);
        }
        result[pageKey] = { ...p, parentIds };
      }

      // Remove absorbed URL from SPI
      const updatedIdx = { ...spi, index: { ...spi.index } };
      delete updatedIdx.index[entry.url];
      result['list:system/shallow-page'] = updatedIdx;

      // Upgrade shallow: pins → page: in affected lists
      const affectedLists = shallowEntry.lists || [];
      if (affectedLists.length > 0) {
        const shallowId = `${SHALLOW_PREFIX}${entry.url}`;
        for (const listKey of affectedLists) {
          const listEntity = await loadOrDefault(listKey, load);
          if (!listEntity.pins?.some(p => p.id === shallowId)) continue;
          result[listKey] = {
            ...listEntity,
            pins: listEntity.pins.map(p =>
              p.id === shallowId ? { ...p, id: pageKey } : p
            ),
          };
        }
      }
    } else {
      result['list:system/shallow-page'] = spi;
    }

    return result;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Per-entity apply functions (used by effectOf internally, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Apply a log entry to settings state.
 * Entry: { timestamp, action: 'set', key, value }
 * Returns new settings object (or original if entry is irrelevant).
 */
export function applyLogToSettings(settings, entry) {
  if (entry.action !== 'set') return settings;
  return { ...settings, [entry.key]: entry.value, timestamp: entry.timestamp };
}

/**
 * Apply a log entry to a page entity.
 * Handles:
 *   - page_checkpoint: create/update page watermark
 *   - page: unified visit + attention + capture (url, title, referrerId, scrollDepth, timeOnPage, mdPath, htmlPath)
 *     - On parent page (referrerId match): accumulate shallow child ref in childIds[]
 * Returns new page object (or original if entry is irrelevant).
 */
export function applyLogToPage(page, entry) {
  // Derive slug from entry URL (slug field removed from log entries)
  const entrySlug = entry.url ? generateSlugFromUrl(entry.url) : null;

  // page_checkpoint: passthrough that creates/updates page watermark
  if (entry.action === 'page_checkpoint') {
    if (entrySlug !== page.slug && page.slug !== undefined) return page;
    const updated = { ...page };
    if (!updated.url && entry.url) updated.url = entry.url;
    if (!updated.title && entry.title) updated.title = entry.title;
    if (!updated.user_title && entry.user_title) updated.user_title = entry.user_title;
    if (entry.parentIds?.length) {
      const parentIds = [...(updated.parentIds || [])];
      for (const pid of entry.parentIds) {
        if (!parentIds.includes(pid)) parentIds.push(pid);
      }
      updated.parentIds = parentIds;
    }
    if (entry.visitDates?.length) {
      const visitDates = [...(updated.visitDates || [])];
      for (const d of entry.visitDates) {
        if (!visitDates.includes(d)) visitDates.push(d);
      }
      updated.visitDates = visitDates;
    }
    updated.timestamp = Math.max(updated.timestamp || 0, entry.timestamp);
    return updated;
  }

  // Unified page entry: visit + attention + capture
  if (entry.action === 'page') {
    // Parent-side: if this page's referrerId matches this page, accumulate shallow child ref
    if (entry.referrerId && page.slug !== undefined) {
      const referrerSlug = entry.referrerId.startsWith(PAGE_PREFIX)
        ? entry.referrerId.slice(PAGE_PREFIX.length) : entry.referrerId;
      if (referrerSlug === page.slug && entrySlug !== page.slug) {
        const updated = { ...page };
        const childIds = [...(updated.childIds || [])];
        const shallowRef = SHALLOW_PREFIX + entry.url;
        const pageRef = PAGE_PREFIX + entrySlug;
        if (!childIds.some(c => c === shallowRef || c === pageRef)) {
          childIds.push(shallowRef);
          if (childIds.length > REFERRER_CAP) childIds.shift();
        }
        updated.childIds = childIds;
        updated.timestamp = Math.max(updated.timestamp || 0, entry.timestamp);
        return updated;
      }
    }

    // Child-side slug check
    const matchSlug = entrySlug || entry.slug;
    if (matchSlug !== page.slug && page.slug !== undefined) return page;

    const prevTimestamp = page.timestamp || 0; // save before mutation for attention idempotency
    const updated = { ...page };

    // Visit fields
    if (entry.url) updated.url = entry.url;
    if (entry.title) updated.title = entry.title;
    if (entry.user_title) updated.user_title = entry.user_title;
    updated.timestamp = entry.timestamp;

    // visitDates (only when url present = visit entry)
    if (entry.url) {
      const d = new Date(entry.timestamp);
      const yyyymmdd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      if (!updated.visitDates) updated.visitDates = [];
      else updated.visitDates = [...updated.visitDates];
      if (!updated.visitDates.includes(yyyymmdd)) updated.visitDates.push(yyyymmdd);
    }

    // parentIds from referrerId (already in page:slug format)
    if (entry.referrerId) {
      const parentIds = [...(updated.parentIds || [])];
      if (!parentIds.includes(entry.referrerId)) {
        parentIds.push(entry.referrerId);
        if (parentIds.length > REFERRER_CAP) parentIds.shift();
      }
      updated.parentIds = parentIds;
    }

    // Attention (guard with prevTimestamp for idempotency)
    if ((entry.scrollDepth !== undefined || entry.timeOnPage !== undefined || entry.likes !== undefined)
        && entry.timestamp > prevTimestamp) {
      if (entry.scrollDepth !== undefined) {
        updated.scrollDepth = Math.max(updated.scrollDepth || 0, entry.scrollDepth);
      }
      if (entry.timeOnPage !== undefined) {
        updated.timeOnPage = (updated.timeOnPage || 0) + entry.timeOnPage;
      }
      if (entry.likes !== undefined) {
        updated.likes = (updated.likes || 0) + entry.likes;
      }
    }

    // Capture fields
    if (entry.mdPath) updated.mdPath = entry.mdPath;
    if (entry.htmlPath) updated.htmlPath = entry.htmlPath;

    return updated;
  }

  return page;
}

/**
 * Apply a log entry to a list entity (self-describing file).
 * Entity: { timestamp, id, name, qbTrees, pins: [...] }
 * Handles:
 *   - list (id="{listId}", op=add/del/clear): granular pin operations (typed ids)
 *   - list_meta (id="{listId}"): list metadata (name, qbTrees)
 *   - del_list (id="{listId}"): mark entity as deleted
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToPins(pinsEntity, entry) {
  if (entry.action === 'list' && entry.id === pinsEntity.slug) {
    const updated = { ...pinsEntity, timestamp: entry.timestamp };
    let pins = [...(pinsEntity.pins || [])];

    if (entry.op === 'clear') {
      updated.pins = [];
    } else if (entry.op === 'add' && entry.ids) {
      for (const id of entry.ids) {
        if (!pins.some(p => p.id === id)) {
          pins.push({ id, pinnedAt: entry.timestamp });
        }
      }
      updated.pins = pins;
    } else if (entry.op === 'del' && entry.ids) {
      pins = pins.filter(p => !entry.ids.includes(p.id));
      updated.pins = pins;
    }

    return updated;
  }
  if (entry.action === 'list_meta' && entry.id === pinsEntity.slug) {
    const updated = { ...pinsEntity, timestamp: entry.timestamp };
    if (entry.name !== undefined) updated.name = entry.name;
    if (entry.qbTrees !== undefined) updated.qbTrees = entry.qbTrees;
    if (entry.autoEnabled !== undefined) updated.autoEnabled = entry.autoEnabled;
    if (entry.parentList !== undefined) updated.parentList = entry.parentList;
    if (entry.childLists !== undefined) updated.childLists = entry.childLists;
    return updated;
  }
  if (entry.action === 'del_list' && entry.id === pinsEntity.slug) {
    return { ...pinsEntity, timestamp: entry.timestamp, deleted: true };
  }
  return pinsEntity;
}

/**
 * Apply a log entry to the shallow page index (for non-checkpointed pages).
 * Index: { timestamp, index: { url: { parentIds: [...], lists: [...], title, user_title } } }
 * Processes:
 *   - page entries with referrerId: records parent in index[url].parentIds
 *   - page entries with title/user_title: updates index[url].title/user_title
 *   - list entries with shallow: ids: records list membership in index[url].lists
 * Returns new index (or original if entry is irrelevant).
 *
 * SPI completeness guarantee — a page MUST have an SPI entry if any of:
 *   (a) it has parentIds (recorded via referrerId on page entries)
 *   (b) it belongs to a list (recorded via shallow: ids on list entries)
 *   (c) it has a user_title (recorded via user_title on page entries)
 * Callers (e.g. searchPageContext) may rely on this: if a field governed by
 * (a)–(c) is absent from SPI, it is genuinely absent — no history search needed.
 * Title is also kept up-to-date: if a page entry carries a new title and the
 * page already has an SPI record, the title is overwritten.
 */
export function applyLogToShallowPage(shallowPageIndex, entry) {
  // Page entry: record parentIds and title info
  if (entry.action === 'page' && entry.url) {
    const hasReferrer = !!entry.referrerId;
    const hasTitle = !!entry.title;
    const hasUserTitle = !!entry.user_title;
    if (!hasReferrer && !hasTitle && !hasUserTitle) return shallowPageIndex;

    const updated = { ...shallowPageIndex };
    const index = { ...updated.index };
    const existing = index[entry.url] || { parentIds: [], lists: [], title: null, user_title: null };
    const rec = { ...existing };

    if (hasReferrer) {
      const parentIds = [...rec.parentIds];
      if (!parentIds.includes(entry.referrerId)) parentIds.push(entry.referrerId);
      rec.parentIds = parentIds;
    }
    if (hasTitle) rec.title = entry.title;
    if (hasUserTitle) rec.user_title = entry.user_title;

    index[entry.url] = rec;
    updated.index = index;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  // List entry with shallow: ids: record list membership
  if (entry.action === 'list' && entry.ids && entry.id) {
    const shallowUrls = entry.ids
      .filter(id => id.startsWith(SHALLOW_PREFIX))
      .map(id => id.slice(SHALLOW_PREFIX.length));
    if (shallowUrls.length === 0) return shallowPageIndex;

    const listKey = `list:${entry.id}`;
    const updated = { ...shallowPageIndex };
    const index = { ...updated.index };

    for (const url of shallowUrls) {
      const existing = index[url] || { parentIds: [], lists: [], title: null, user_title: null };
      const rec = { ...existing };

      if (entry.op === 'add') {
        const lists = [...rec.lists];
        if (!lists.includes(listKey)) lists.push(listKey);
        rec.lists = lists;
      } else if (entry.op === 'del') {
        rec.lists = rec.lists.filter(l => l !== listKey);
      }

      index[url] = rec;
    }

    updated.index = index;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  return shallowPageIndex;
}

/**
 * Apply a log entry to a gateways entity.
 * Entity: { timestamp, origins: [...] }
 * Entry: { timestamp, action: 'list', id: 'system/gateways', op: 'add'|'del'|'clear', origins: [...] }
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToGateways(gatewaysEntity, entry) {
  if (entry.action !== 'list' || entry.id !== 'system/gateways') return gatewaysEntity;

  const updated = { timestamp: entry.timestamp };
  let origins = [...(gatewaysEntity.origins || [])];

  if (entry.op === 'clear') {
    updated.origins = [];
  } else if (entry.op === 'add' && entry.origins) {
    for (const origin of entry.origins) {
      if (!origins.includes(origin)) {
        origins.push(origin);
      }
    }
    updated.origins = origins;
  } else if (entry.op === 'del' && entry.origins) {
    origins = origins.filter(o => !entry.origins.includes(o));
    updated.origins = origins;
  } else {
    updated.origins = origins;
  }

  return updated;
}
