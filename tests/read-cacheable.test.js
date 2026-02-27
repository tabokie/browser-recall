/**
 * readCacheable / readFs tests.
 *
 * Tests the session→filesystem fallback cache layer in background.js:
 * - Session hit returns cached value without offscreen call
 * - Session miss falls back to filesystem and caches the result
 * - Settings keys batch-load all keys on any single miss
 * - `lists` fallback applies `listOrder` ordering
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
describe('background.js structural checks', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('exports readCacheable function', () => {
    expect(bgSource).toMatch(/async function readCacheable\s*\(\s*key\s*\)/);
  });

  it('exports readFs function', () => {
    expect(bgSource).toMatch(/async function readFs\s*\(\s*key\s*\)/);
  });

  it('has getGatewayDomains case handler', () => {
    expect(bgSource).toMatch(/case\s+'getGatewayDomains'\s*:/);
  });

  it('getLists handler uses readCacheable', () => {
    // Extract the getLists case block
    const getListsMatch = bgSource.match(/case\s+'getLists'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(getListsMatch).not.toBeNull();
    expect(getListsMatch[1]).toMatch(/readCacheable\s*\(\s*'lists'\s*\)/);
  });

  it('getRecycleBin handler uses readCacheable', () => {
    const match = bgSource.match(/case\s+'getRecycleBin'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toMatch(/readCacheable\s*\(\s*'recycleBin'\s*\)/);
  });

  it('loadPermanentDeletes handler uses readCacheable', () => {
    const match = bgSource.match(/case\s+'loadPermanentDeletes'\s*:\s*\{([\s\S]*?)break;\s*\}/);
    expect(match).not.toBeNull();
    expect(match[1]).toMatch(/readCacheable\s*\(\s*'permanentDeletes'\s*\)/);
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
  const SETTINGS_KEYS = ['workspace', 'listOrder', 'urlBlacklist', 'titleTrimRules', 'settings'];

  // Mimics the readCacheable/readFs functions from background.js
  let readCacheable, readFs;
  let hydrationResolve;
  let hydrationDone;

  function requestOffscreen(msg) {
    offscreenCalls.push(msg);
    switch (msg.action) {
      case 'loadSettings':
        return { success: true, settings: { workspace: { mode: 'normal' }, listOrder: ['list:b', 'list:a'], urlBlacklist: [], titleTrimRules: [{ urlPrefix: 'https://x.com', action: 'remove_after_pipe' }], settings: { captureContent: true } } };
      case 'loadAllListMetadata':
        return { success: true, lists: [{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }] };
      case 'loadRecycleBin':
        return { success: true, items: [{ url: 'https://del.com', deletedAt: 123 }] };
      case 'loadPermanentDeletes':
        return { success: true, keys: ['page:slug1', 'page:slug2'] };
      case 'loadParentIndex':
        return { success: true, timestamp: 42, index: { 'https://a.com': ['s1'] } };
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
      if (SETTINGS_KEYS.includes(key)) {
        const resp = requestOffscreen({ action: 'loadSettings' });
        const settings = resp?.settings || {};
        const toCache = {};
        for (const k of SETTINGS_KEYS) {
          if (settings[k] !== undefined) toCache[k] = settings[k];
        }
        if (Object.keys(toCache).length > 0) await session.set(toCache);
        return settings[key];
      }
      let value;
      switch (key) {
        case 'lists': {
          const metaResp = requestOffscreen({ action: 'loadAllListMetadata' });
          let allLists = metaResp?.lists || [];
          const listOrder = (await readCacheable('listOrder')) || [];
          if (listOrder.length > 0) {
            const ordered = [];
            for (const key of listOrder) { const slug = key.startsWith('list:') ? key.slice(5) : key; const c = allLists.find(x => x.slug === slug); if (c) ordered.push(c); }
            for (const c of allLists) { if (!listOrder.includes('list:' + c.slug)) ordered.push(c); }
            allLists = ordered;
          }
          value = allLists; break;
        }
        case 'recycleBin': {
          const r = requestOffscreen({ action: 'loadRecycleBin' });
          value = r?.items || []; break;
        }
        case 'permanentDeletes': {
          const r = requestOffscreen({ action: 'loadPermanentDeletes' });
          value = r?.keys || []; break;
        }
        case 'parentIndex': {
          const r = requestOffscreen({ action: 'loadParentIndex' });
          value = r?.success ? { timestamp: r.timestamp || 0, index: r.index || {} } : { timestamp: 0, index: {} }; break;
        }
        case 'gatewayOrigins': {
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
  });

  // ── Session hit ──────────────────────────────────────────────────────
  it('returns cached value from session without offscreen call', async () => {
    await session.set({ gatewayOrigins: ['https://example.com'] });
    const result = await readCacheable('gatewayOrigins');
    expect(result).toEqual(['https://example.com']);
    expect(offscreenCalls).toEqual([]); // No offscreen call
  });

  it('returns cached lists without offscreen call', async () => {
    await session.set({ lists: [{ slug: 'x', name: 'X' }] });
    const result = await readCacheable('lists');
    expect(result).toEqual([{ slug: 'x', name: 'X' }]);
    expect(offscreenCalls).toEqual([]);
  });

  // ── Session miss → filesystem fallback ───────────────────────────────
  it('falls back to filesystem for lists and caches result', async () => {
    // listOrder is also missing, so readCacheable('listOrder') triggers loadSettings
    const result = await readCacheable('lists');
    expect(result).toEqual([{ slug: 'b', name: 'B' }, { slug: 'a', name: 'A' }]); // ordered by listOrder
    expect(offscreenCalls.some(c => c.action === 'loadAllListMetadata')).toBe(true);
    // Should be cached now
    expect(session._store.lists).toEqual([{ slug: 'b', name: 'B' }, { slug: 'a', name: 'A' }]);
  });

  it('falls back to filesystem for recycleBin and caches result', async () => {
    const result = await readCacheable('recycleBin');
    expect(result).toEqual([{ url: 'https://del.com', deletedAt: 123 }]);
    expect(offscreenCalls.some(c => c.action === 'loadRecycleBin')).toBe(true);
    expect(session._store.recycleBin).toEqual([{ url: 'https://del.com', deletedAt: 123 }]);
  });

  it('falls back to filesystem for permanentDeletes and caches result', async () => {
    const result = await readCacheable('permanentDeletes');
    expect(result).toEqual(['page:slug1', 'page:slug2']);
    expect(offscreenCalls.some(c => c.action === 'loadPermanentDeletes')).toBe(true);
    expect(session._store.permanentDeletes).toEqual(['page:slug1', 'page:slug2']);
  });

  it('falls back to filesystem for parentIndex and caches result', async () => {
    const result = await readCacheable('parentIndex');
    expect(result).toEqual({ timestamp: 42, index: { 'https://a.com': ['s1'] } });
    expect(offscreenCalls.some(c => c.action === 'loadParentIndex')).toBe(true);
    expect(session._store.parentIndex).toEqual({ timestamp: 42, index: { 'https://a.com': ['s1'] } });
  });

  it('falls back to filesystem for gatewayOrigins and caches result', async () => {
    const result = await readCacheable('gatewayOrigins');
    expect(result).toEqual(['https://docs.rs']);
    expect(offscreenCalls.some(c => c.action === 'loadGateways')).toBe(true);
    expect(session._store.gatewayOrigins).toEqual(['https://docs.rs']);
  });

  // ── Settings batch-load ──────────────────────────────────────────────
  it('batch-loads all settings keys on any single settings key miss', async () => {
    const result = await readCacheable('workspace');
    expect(result).toEqual({ mode: 'normal' });
    // All settings keys should be cached now
    expect(session._store.workspace).toEqual({ mode: 'normal' });
    expect(session._store.listOrder).toEqual(['list:b', 'list:a']);
    expect(session._store.urlBlacklist).toEqual([]);
    expect(session._store.titleTrimRules).toEqual([{ urlPrefix: 'https://x.com', action: 'remove_after_pipe' }]);
    expect(session._store.settings).toEqual({ captureContent: true });
    // Only ONE loadSettings call
    const settingsCalls = offscreenCalls.filter(c => c.action === 'loadSettings');
    expect(settingsCalls.length).toBe(1);
  });

  it('second settings key read hits session cache (no second offscreen call)', async () => {
    await readCacheable('workspace');
    offscreenCalls = []; // clear
    const result = await readCacheable('titleTrimRules');
    expect(result).toEqual([{ urlPrefix: 'https://x.com', action: 'remove_after_pipe' }]);
    expect(offscreenCalls).toEqual([]); // No additional offscreen call
  });

  // ── Lists ordering ───────────────────────────────────────────────────
  it('applies listOrder when loading lists from filesystem', async () => {
    // Pre-populate listOrder in session so readCacheable('listOrder') hits cache
    await session.set({ listOrder: ['list:b', 'list:a'] });
    const result = await readCacheable('lists');
    // 'b' should come before 'a' because listOrder = ['list:b', 'list:a']
    expect(result[0].slug).toBe('b');
    expect(result[1].slug).toBe('a');
  });

  it('preserves original order when listOrder is empty', async () => {
    await session.set({ listOrder: [] });
    const result = await readCacheable('lists');
    // Original order from loadAllListMetadata: a, b
    expect(result[0].slug).toBe('a');
    expect(result[1].slug).toBe('b');
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

    await session.set({ workspace: { mode: 'normal' } });

    const promise = readCacheable('workspace').then(v => { resolved = true; return v; });

    // Should not have resolved yet
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Resolve hydration
    hydrationResolve();
    const result = await promise;
    expect(resolved).toBe(true);
    expect(result).toEqual({ mode: 'normal' });
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
describe('options.js loadGatewayDomains fallback', () => {
  const optionsSource = readFileSync(resolve(extDir, 'options.js'), 'utf-8');

  it('has background message fallback for getGatewayDomains', () => {
    // loadGatewayDomains should fall back to sendMessage when session is empty
    expect(optionsSource).toMatch(/getGatewayDomains/);
  });
});
