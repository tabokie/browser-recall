/**
 * readCacheable / readFs tests.
 *
 * Tests the session→filesystem fallback cache layer in background.js:
 * - Session hit returns cached value without offscreen call
 * - Session miss falls back to filesystem and caches the result
 * - Settings keys batch-load all keys on any single miss
 * - `await hydrationDone` blocks readCacheable until resolved
 *
 * Structural tests verify readCacheable/readFs exist in background.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, '..', 'extension');

// ---------------------------------------------------------------------------
// Structural tests — verify functions/handlers exist in background.js
// ---------------------------------------------------------------------------
describe('utils.js structural checks', () => {
  const utilsSource = readFileSync(resolve(extDir, 'utils.js'), 'utf-8');

  it('exports readCacheable function', () => {
    expect(utilsSource).toMatch(/export async function readCacheable\s*\(\s*key/);
  });

  it('readCacheable sends readCacheable action on session miss', () => {
    expect(utilsSource).toMatch(/action:\s*'readCacheable'/);
  });

  it('loadSettingsValue delegates to readCacheable for settings', () => {
    const fnBody = utilsSource.match(/export async function loadSettingsValue[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    expect(fnBody[0]).toMatch(/readCacheable\s*\(\s*'settings'\s*\)/);
  });
});

describe('background.js structural checks', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('exports readCacheable function', () => {
    expect(bgSource).toMatch(/async function readCacheable\s*\(\s*key/);
  });

  it('exports readFs function', () => {
    expect(bgSource).toMatch(/async function readFs\s*\(\s*key\s*\)/);
  });

  it('has readCacheable case handler', () => {
    expect(bgSource).toMatch(/case\s+'readCacheable'\s*:/);
  });

  it('readCacheable handler returns success: true', () => {
    const match = bgSource.match(/case\s+'readCacheable'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toMatch(/success:\s*true/);
  });

});

// ---------------------------------------------------------------------------
// Behavioral tests — verify readCacheable/readFs logic
// ---------------------------------------------------------------------------

// Minimal mock helpers
function makeSessionStore(initial = {}) {
  const store = { ...initial };
  return {
    async get(keys) {
      if (!keys) return { ...store };
      if (typeof keys === 'string') keys = [keys];
      const result = {};
      for (const k of keys) if (k in store) result[k] = store[k];
      return result;
    },
    async set(obj) { Object.assign(store, obj); },
    _store: store,
  };
}

describe('readCacheable / readFs', () => {
  let session;
  let offscreenCalls;
  // Mimics the readCacheable/readFs/getAllListKeys functions from background.js
  let readCacheable, readFs, getAllListKeys;
  let hydrationResolve;
  let hydrationDone;

  const TEST_SETTINGS = { urlBlacklist: [], titleTrimRules: [{ urlPrefix: 'https://x.com', action: 'remove_after_pipe' }], captureContent: true };

  function requestOffscreen(msg) {
    offscreenCalls.push(msg);
    switch (msg.action) {
      case 'loadSettings':
        return { success: true, settings: TEST_SETTINGS };
      case 'loadAllListMetadata':
        return { success: true, lists: [{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }] };
      case 'loadShallowPageIndex':
        return { success: true, timestamp: 42, index: { 'https://a.com': { parentIds: ['s1'] } } };
      case 'loadGateways':
        return { success: true, timestamp: 0, origins: ['https://docs.rs'] };
      case 'loadListEntity':
        if (msg.listId === 'my-custom-list') {
          return { success: true, entity: { slug: 'my-custom-list', name: 'My Custom List', qbTrees: [], pins: [{ id: 'page:abc', pinnedAt: 100 }], parentList: 'list:system/root', childLists: [] } };
        }
        if (msg.listId === 'system/root') {
          return { success: true, entity: { timestamp: 0, childLists: ['list:b', 'list:a'] } };
        }
        return { success: true, entity: null };
      default:
        return { success: false, error: 'unknown' };
    }
  }

  beforeEach(() => {
    session = makeSessionStore();
    offscreenCalls = [];

    // Create controllable hydration promise
    hydrationDone = new Promise(r => { hydrationResolve = r; });
    // Resolve immediately by default (tests that need blocking will override)
    hydrationResolve();

    // Wire up readCacheable/readFs matching the background.js implementation
    readFs = async (key) => {
      let value;
      switch (key) {
        case 'settings': {
          const resp = requestOffscreen({ action: 'loadSettings' });
          value = resp?.settings || {};
          break;
        }
        case 'list:system/shallow-page': {
          const r = requestOffscreen({ action: 'loadShallowPageIndex' });
          value = r?.success ? { timestamp: r.timestamp || 0, index: r.index || {} } : { timestamp: 0, index: {} }; break;
        }
        case 'list:system/gateways': {
          const r = requestOffscreen({ action: 'loadGateways' });
          value = { timestamp: r.timestamp, origins: r.origins }; break;
        }
        default: {
          if (key.startsWith('list:')) {
            const listId = key.slice('list:'.length);
            const r = requestOffscreen({ action: 'loadListEntity', listId });
            value = r?.entity ?? null;
            break;
          }
          return undefined;
        }
      }
      await session.set({ [key]: value });
      return value;
    };

    readCacheable = async (key) => {
      await hydrationDone;
      const cached = await session.get([key]);
      if (key in cached) return cached[key];
      return readFs(key);
    };

    // Traverse tree from root to get all list keys (mirrors background.js getAllListKeys)
    getAllListKeys = async () => {
      const root = await readCacheable('list:system/root');
      const result = [];
      const queue = [...(root?.childLists || [])];
      const visited = new Set();
      while (queue.length > 0) {
        const key = queue.shift();
        if (visited.has(key)) continue;
        visited.add(key);
        result.push(key);
        const entity = await readCacheable(key);
        if (entity?.childLists) queue.push(...entity.childLists);
      }
      return result;
    };
  });

  // ── Session hit ──────────────────────────────────────────────────────
  it('returns cached value from session without offscreen call', async () => {
    await session.set({ 'list:system/gateways': { timestamp: 0, origins: ['https://example.com'] } });
    const result = await readCacheable('list:system/gateways');
    expect(result).toEqual({ timestamp: 0, origins: ['https://example.com'] });
    expect(offscreenCalls).toEqual([]); // No offscreen call
  });

  it('getAllListKeys returns list keys from cached root without offscreen call', async () => {
    await session.set({
      'list:system/root': { timestamp: 0, childLists: ['list:x'] },
      'list:x': { slug: 'x', name: 'X', parentList: 'list:system/root', childLists: [] },
    });
    const result = await getAllListKeys();
    expect(result).toEqual(['list:x']);
    expect(offscreenCalls).toEqual([]);
  });

  // ── Session miss → filesystem fallback ───────────────────────────────
  it('getAllListKeys falls back to filesystem for root then traverses tree', async () => {
    // Root not in session — triggers readFs('list:system/root')
    await session.set({
      'list:b': { slug: 'b', name: 'B', parentList: 'list:system/root', childLists: [] },
      'list:a': { slug: 'a', name: 'A', parentList: 'list:system/root', childLists: [] },
    });
    const result = await getAllListKeys();
    expect(result).toEqual(['list:b', 'list:a']);
    expect(offscreenCalls.some(c => c.action === 'loadListEntity' && c.listId === 'system/root')).toBe(true);
  });

  it('falls back to filesystem for shallow-page and caches result', async () => {
    const result = await readCacheable('list:system/shallow-page');
    expect(result).toEqual({ timestamp: 42, index: { 'https://a.com': { parentIds: ['s1'] } } });
    expect(offscreenCalls.some(c => c.action === 'loadShallowPageIndex')).toBe(true);
    expect(session._store['list:system/shallow-page']).toEqual({ timestamp: 42, index: { 'https://a.com': { parentIds: ['s1'] } } });
  });

  it('falls back to filesystem for gateways and caches result', async () => {
    const result = await readCacheable('list:system/gateways');
    expect(result).toEqual({ timestamp: 0, origins: ['https://docs.rs'] });
    expect(offscreenCalls.some(c => c.action === 'loadGateways')).toBe(true);
    expect(session._store['list:system/gateways']).toEqual({ timestamp: 0, origins: ['https://docs.rs'] });
  });

  // ── Settings batch-load ──────────────────────────────────────────────
  it('loads full settings object on miss', async () => {
    const result = await readCacheable('settings');
    expect(result).toEqual(TEST_SETTINGS);
    // Full settings object should be cached
    expect(session._store.settings).toEqual(TEST_SETTINGS);
    // Only ONE loadSettings call
    const settingsCalls = offscreenCalls.filter(c => c.action === 'loadSettings');
    expect(settingsCalls.length).toBe(1);
  });

  it('second settings read hits session cache (no second offscreen call)', async () => {
    await readCacheable('settings');
    offscreenCalls = []; // clear
    const result = await readCacheable('settings');
    expect(result).toEqual(TEST_SETTINGS);
    expect(offscreenCalls).toEqual([]); // No additional offscreen call
  });

  // ── Lists ordering ───────────────────────────────────────────────────
  it('getAllListKeys returns keys in childLists order', async () => {
    await session.set({
      'list:system/root': { timestamp: 0, childLists: ['list:b', 'list:a'] },
      'list:b': { slug: 'b', name: 'B', parentList: 'list:system/root', childLists: [] },
      'list:a': { slug: 'a', name: 'A', parentList: 'list:system/root', childLists: [] },
    });
    const result = await getAllListKeys();
    // 'b' should come before 'a' because childLists = [list:b, list:a]
    expect(result[0]).toBe('list:b');
    expect(result[1]).toBe('list:a');
    expect(offscreenCalls).toEqual([]);
  });

  it('returns empty array when root has no children', async () => {
    await session.set({ 'list:system/root': { timestamp: 0, childLists: [] } });
    const result = await getAllListKeys();
    expect(result).toEqual([]);
    expect(offscreenCalls).toEqual([]);
  });

  // ── hydrationDone blocking ──────────────────────────────────────────
  it('blocks readCacheable until hydrationDone resolves', async () => {
    let resolved = false;
    // Create a new hydrationDone that won't resolve immediately
    hydrationDone = new Promise(r => { hydrationResolve = r; });

    // Re-wire readCacheable with the new hydrationDone
    const origReadFs = readFs;
    readCacheable = async (key) => {
      await hydrationDone;
      const cached = await session.get([key]);
      if (key in cached) return cached[key];
      return origReadFs(key);
    };

    await session.set({ settings: { urlBlacklist: ['chrome://'] } });

    const promise = readCacheable('settings').then(v => { resolved = true; return v; });

    // Should not have resolved yet
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Resolve hydration
    hydrationResolve();
    const result = await promise;
    expect(resolved).toBe(true);
    expect(result).toEqual({ urlBlacklist: ['chrome://'] });
  });

  // ── Unknown keys ─────────────────────────────────────────────────────
  it('returns undefined for unknown keys', async () => {
    const result = await readCacheable('nonExistentKey');
    expect(result).toBeUndefined();
  });

  // ── #4: User list keys fall back to filesystem ─────────────────────
  it('falls back to filesystem for user list keys on session miss', async () => {
    const result = await readCacheable('list:my-custom-list');
    expect(result).toEqual({ slug: 'my-custom-list', name: 'My Custom List', qbTrees: [], pins: [{ id: 'page:abc', pinnedAt: 100 }], parentList: 'list:system/root', childLists: [] });
    expect(offscreenCalls.some(c => c.action === 'loadListEntity' && c.listId === 'my-custom-list')).toBe(true);
    // Should be cached after first load
    expect(session._store['list:my-custom-list']).toEqual({ slug: 'my-custom-list', name: 'My Custom List', qbTrees: [], pins: [{ id: 'page:abc', pinnedAt: 100 }], parentList: 'list:system/root', childLists: [] });
  });

  it('returns null for user list key that does not exist on disk', async () => {
    const result = await readCacheable('list:nonexistent-list');
    expect(result).toBeNull();
    expect(offscreenCalls.some(c => c.action === 'loadListEntity' && c.listId === 'nonexistent-list')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #2: toggleListPin should accept url (not pre-computed id) — structural
// ---------------------------------------------------------------------------
describe('options.js toggleResultPin sends url to background', () => {
  const optionsSource = readFileSync(resolve(extDir, 'options.js'), 'utf-8');

  it('toggleResultPin sends url, not pre-computed id, in toggleListPin message', () => {
    const fnBody = optionsSource.match(/async function toggleResultPin[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    const fn = fnBody[0];
    // Should send url to let background resolve the id
    expect(fn).toMatch(/action:\s*'toggleListPin'.*url/);
    // Should NOT send a pre-computed id field
    expect(fn).not.toMatch(/action:\s*'toggleListPin'.*\bid:\s*pinId\b/);
  });

  it('does not have urlToPinId function', () => {
    // urlToPinId should be removed — background resolves pin IDs
    expect(optionsSource).not.toMatch(/function urlToPinId\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// #2: toggleListPin handler checks both page:<slug> and shallow:<url> forms
// ---------------------------------------------------------------------------
describe('background.js toggleListPin handles both pin ID forms', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('toggleListPin checks both page: and shallow: forms for isPinned', () => {
    const caseBlock = bgSource.match(/case\s+'toggleListPin'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(caseBlock).not.toBeNull();
    const handler = caseBlock[1];
    // Should check for shallow: variant when resolving pin match
    expect(handler).toMatch(/shallow:/);
  });
});

// ---------------------------------------------------------------------------
// #2: addListPins accepts urls and resolves via resolvePageId
// ---------------------------------------------------------------------------
describe('background.js addListPins accepts urls', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('addListPins handler accepts request.urls', () => {
    const caseBlock = bgSource.match(/case\s+'addListPins'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(caseBlock).not.toBeNull();
    expect(caseBlock[1]).toMatch(/request\.urls/);
  });

  it('addListPins resolves urls via resolvePageId', () => {
    const caseBlock = bgSource.match(/case\s+'addListPins'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(caseBlock).not.toBeNull();
    expect(caseBlock[1]).toMatch(/resolvePageId/);
  });
});

describe('options.js pin operations send urls or use copyListPins', () => {
  const optionsSource = readFileSync(resolve(extDir, 'options.js'), 'utf-8');

  it('list drag-drop sends urls to addListPins', () => {
    expect(optionsSource).toMatch(/action:\s*'addListPins'.*urls:\s*newUrls/);
  });

  it('saveExploreAsList uses copyListPins instead of sending local pin IDs', () => {
    const fnBody = optionsSource.match(/async function saveExploreAsList[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    expect(fnBody[0]).toMatch(/action:\s*'copyListPins'/);
    expect(fnBody[0]).not.toMatch(/action:\s*'addListPins'/);
  });

  it('no addListPins call sends ids', () => {
    // All addListPins calls should use urls, never ids
    const calls = optionsSource.match(/action:\s*'addListPins'[^}]*/g) || [];
    for (const call of calls) {
      expect(call).toMatch(/urls:/);
      expect(call).not.toMatch(/\bids:/);
    }
  });
});

// ---------------------------------------------------------------------------
// #3: getPageRelations reads actual list entities, not listCache:* keys
// ---------------------------------------------------------------------------
describe('background.js getPageRelations reads list entities', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('does not use listCache: session keys for list membership check', () => {
    const caseBlock = bgSource.match(/case\s+'getPageRelations'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(caseBlock).not.toBeNull();
    // Should NOT read from the options-only listCache: session keys
    expect(caseBlock[1]).not.toMatch(/listCache:/);
  });

  it('reads list entities via readCacheable for list membership', () => {
    const caseBlock = bgSource.match(/case\s+'getPageRelations'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(caseBlock).not.toBeNull();
    // Should use readCacheable (which has disk fallback) for list entities
    expect(caseBlock[1]).toMatch(/readCacheable\s*\(\s*'list:/);
  });
});

// ---------------------------------------------------------------------------
// #4: readFs handles user list keys — structural
// ---------------------------------------------------------------------------
describe('background.js readFs handles user list keys', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('readFs has a fallback for list: keys', () => {
    const fnBody = bgSource.match(/async function readFs[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    // Should handle list: prefix in the default branch or a dedicated case
    expect(fnBody[0]).toMatch(/loadListEntity/);
  });
});

// ---------------------------------------------------------------------------
// offscreen.js field mismatch — structural verification
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// options.js loadGatewayDomains — structural verification
// ---------------------------------------------------------------------------
describe('options.js loadGatewayDomains uses readCacheable', () => {
  const optionsSource = readFileSync(resolve(extDir, 'options.js'), 'utf-8');

  it('reads gateways via readCacheable with entity key', () => {
    expect(optionsSource).toMatch(/readCacheable\s*\(\s*'list:system\/gateways'\s*\)/);
  });
});
