/**
 * readCacheable / readFs tests.
 *
 * Tests the session→filesystem fallback cache layer in background.js:
 * - Session hit returns cached value without offscreen call
 * - Session miss falls back to filesystem and caches the result
 * - Settings keys batch-load all keys on any single miss
 * - `listOrder` stores `{ id, name }` entries for direct consumption
 * - `await hydrationDone` blocks readCacheable until resolved
 *
 * Structural tests verify readCacheable/readFs and getGatewayDomains exist in background.js.
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
    expect(utilsSource).toMatch(/export async function readCacheable\s*\(\s*key\s*\)/);
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
    expect(bgSource).toMatch(/async function readCacheable\s*\(\s*key\s*\)/);
  });

  it('exports readFs function', () => {
    expect(bgSource).toMatch(/async function readFs\s*\(\s*key\s*\)/);
  });

  it('has readCacheable case handler', () => {
    expect(bgSource).toMatch(/case\s+'readCacheable'\s*:/);
  });

  it('has getGatewayDomains case handler', () => {
    expect(bgSource).toMatch(/case\s+'getGatewayDomains'\s*:/);
  });

  it('getLists handler uses getListOrder', () => {
    // Extract the getLists case block
    const getListsMatch = bgSource.match(/case\s+'getLists'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(getListsMatch).not.toBeNull();
    expect(getListsMatch[1]).toMatch(/getListOrder\s*\(\s*\)/);
  });

  it('getRecycleBin handler uses readCacheable', () => {
    const match = bgSource.match(/case\s+'getRecycleBin'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toMatch(/readCacheable\s*\(\s*'list:system\/recycle-bin'\s*\)/);
  });

  it('loadPermanentDeletes handler uses readCacheable', () => {
    const match = bgSource.match(/case\s+'loadPermanentDeletes'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toMatch(/readCacheable\s*\(\s*'list:system\/permanent-deletes'\s*\)/);
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
  // Mimics the readCacheable/readFs/getListOrder functions from background.js
  let readCacheable, readFs, getListOrder;
  let hydrationResolve;
  let hydrationDone;

  const TEST_SETTINGS = { listOrder: [{ id: 'list:b', name: 'B' }, { id: 'list:a', name: 'A' }], urlBlacklist: [], titleTrimRules: [{ urlPrefix: 'https://x.com', action: 'remove_after_pipe' }], captureContent: true };

  function requestOffscreen(msg) {
    offscreenCalls.push(msg);
    switch (msg.action) {
      case 'loadSettings':
        return { success: true, settings: TEST_SETTINGS };
      case 'loadAllListMetadata':
        return { success: true, lists: [{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }] };
      case 'loadRecycleBin':
        return { success: true, items: [{ url: 'https://del.com', deletedAt: 123 }] };
      case 'loadPermanentDeletes':
        return { success: true, keys: ['page:slug1', 'page:slug2'] };
      case 'loadShallowPageIndex':
        return { success: true, timestamp: 42, index: { 'https://a.com': { parents: ['s1'] } } };
      case 'loadGateways':
        return { success: true, origins: ['https://docs.rs'] };
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
        case 'list:system/recycle-bin': {
          const r = requestOffscreen({ action: 'loadRecycleBin' });
          value = r?.items || []; break;
        }
        case 'list:system/permanent-deletes': {
          const r = requestOffscreen({ action: 'loadPermanentDeletes' });
          value = r?.keys || []; break;
        }
        case 'list:system/shallow-page': {
          const r = requestOffscreen({ action: 'loadShallowPageIndex' });
          value = r?.success ? { timestamp: r.timestamp || 0, index: r.index || {} } : { timestamp: 0, index: {} }; break;
        }
        case 'list:system/gateways': {
          const r = requestOffscreen({ action: 'loadGateways' });
          value = r?.origins || []; break;
        }
        default: return undefined;
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

    // Read listOrder from settings. Each entry is { id: 'list:<slug>', name }.
    getListOrder = async () => {
      const settings = await readCacheable('settings');
      return settings?.listOrder || [];
    };
  });

  // ── Session hit ──────────────────────────────────────────────────────
  it('returns cached value from session without offscreen call', async () => {
    await session.set({ 'list:system/gateways': ['https://example.com'] });
    const result = await readCacheable('list:system/gateways');
    expect(result).toEqual(['https://example.com']);
    expect(offscreenCalls).toEqual([]); // No offscreen call
  });

  it('returns listOrder entries from cached settings without offscreen call', async () => {
    await session.set({ settings: { listOrder: [{ id: 'list:x', name: 'X' }] } });
    const result = await getListOrder();
    expect(result).toEqual([{ id: 'list:x', name: 'X' }]);
    expect(offscreenCalls).toEqual([]);
  });

  // ── Session miss → filesystem fallback ───────────────────────────────
  it('getListOrder falls back to filesystem for settings then returns listOrder', async () => {
    // Settings not in session — triggers readFs('settings')
    const result = await getListOrder();
    expect(result).toEqual(TEST_SETTINGS.listOrder);
    expect(offscreenCalls.some(c => c.action === 'loadSettings')).toBe(true);
  });

  it('falls back to filesystem for recycle-bin and caches result', async () => {
    const result = await readCacheable('list:system/recycle-bin');
    expect(result).toEqual([{ url: 'https://del.com', deletedAt: 123 }]);
    expect(offscreenCalls.some(c => c.action === 'loadRecycleBin')).toBe(true);
    expect(session._store['list:system/recycle-bin']).toEqual([{ url: 'https://del.com', deletedAt: 123 }]);
  });

  it('falls back to filesystem for permanent-deletes and caches result', async () => {
    const result = await readCacheable('list:system/permanent-deletes');
    expect(result).toEqual(['page:slug1', 'page:slug2']);
    expect(offscreenCalls.some(c => c.action === 'loadPermanentDeletes')).toBe(true);
    expect(session._store['list:system/permanent-deletes']).toEqual(['page:slug1', 'page:slug2']);
  });

  it('falls back to filesystem for shallow-page and caches result', async () => {
    const result = await readCacheable('list:system/shallow-page');
    expect(result).toEqual({ timestamp: 42, index: { 'https://a.com': { parents: ['s1'] } } });
    expect(offscreenCalls.some(c => c.action === 'loadShallowPageIndex')).toBe(true);
    expect(session._store['list:system/shallow-page']).toEqual({ timestamp: 42, index: { 'https://a.com': { parents: ['s1'] } } });
  });

  it('falls back to filesystem for gateways and caches result', async () => {
    const result = await readCacheable('list:system/gateways');
    expect(result).toEqual(['https://docs.rs']);
    expect(offscreenCalls.some(c => c.action === 'loadGateways')).toBe(true);
    expect(session._store['list:system/gateways']).toEqual(['https://docs.rs']);
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
  it('getListOrder returns entries in listOrder order', async () => {
    await session.set({
      settings: { listOrder: [{ id: 'list:b', name: 'B' }, { id: 'list:a', name: 'A' }] },
    });
    const result = await getListOrder();
    // 'b' should come before 'a' because listOrder = [b, a]
    expect(result[0].id).toBe('list:b');
    expect(result[1].id).toBe('list:a');
    expect(offscreenCalls).toEqual([]);
  });

  it('returns empty array when listOrder is empty', async () => {
    await session.set({ settings: { listOrder: [] } });
    const result = await getListOrder();
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

    await session.set({ settings: { listOrder: [{ id: 'list:a', name: 'A' }] } });

    const promise = readCacheable('settings').then(v => { resolved = true; return v; });

    // Should not have resolved yet
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Resolve hydration
    hydrationResolve();
    const result = await promise;
    expect(resolved).toBe(true);
    expect(result).toEqual({ listOrder: [{ id: 'list:a', name: 'A' }] });
  });

  // ── Unknown keys ─────────────────────────────────────────────────────
  it('returns undefined for unknown keys', async () => {
    const result = await readCacheable('nonExistentKey');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// offscreen.js field mismatch — structural verification
// ---------------------------------------------------------------------------
describe('offscreen.js loadPermanentDeletes response', () => {
  const offscreenSource = readFileSync(resolve(extDir, 'offscreen.js'), 'utf-8');

  it('uses "keys" not "urls" in loadPermanentDeletes response', () => {
    // The response should use `keys` to match all consumers
    const caseBlock = offscreenSource.match(/case\s+'loadPermanentDeletes'\s*:\s*\{([\s\S]*?)\}/);
    expect(caseBlock).not.toBeNull();
    expect(caseBlock[1]).toMatch(/\bkeys\b/);
    expect(caseBlock[1]).not.toMatch(/\burls\b/);
  });
});

// ---------------------------------------------------------------------------
// options.js loadGatewayDomains — structural verification
// ---------------------------------------------------------------------------
describe('options.js loadGatewayDomains uses readCacheable', () => {
  const optionsSource = readFileSync(resolve(extDir, 'options.js'), 'utf-8');

  it('reads gateways via readCacheable with entity key', () => {
    expect(optionsSource).toMatch(/readCacheable\s*\(\s*'list:system\/gateways'\s*\)/);
  });
});
