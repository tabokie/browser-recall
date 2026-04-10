/**
 * Audit tests for silent default patterns.
 *
 * Ensures that response errors from background message handlers are propagated
 * (not silently defaulted to empty arrays/objects), that filesystem catch blocks
 * distinguish NotFoundError from real errors, and that session cache errors are
 * logged rather than swallowed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, '..', 'extension');
const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');
const optionsSource = readFileSync(resolve(extDir, 'options.js'), 'utf-8');
const popupSource = readFileSync(resolve(extDir, 'popup.js'), 'utf-8');
const contentSource = readFileSync(resolve(extDir, 'content.js'), 'utf-8');
const utilsSource = readFileSync(resolve(extDir, 'utils.js'), 'utf-8');
const fsStorageSource = readFileSync(resolve(extDir, 'filesystem-storage.js'), 'utf-8');

// ---------------------------------------------------------------------------
// background.js — addLog and dedup history cache fallback
// ---------------------------------------------------------------------------

describe('addLog history cache — no silent default on miss', () => {
  it('does not use today || [] pattern', () => {
    expect(bgSource).not.toMatch(/today \|\| \[\]/);
  });

  it('falls back to disk on cache miss', () => {
    // The addLog history append should load from offscreen when cache misses
    const addLogFn = bgSource.match(/async function addLog\(entry\) \{([\s\S]*?)\n\}/);
    expect(addLogFn).not.toBeNull();
    expect(addLogFn[1]).toMatch(/loadHistoryRange/);
  });

  it('does not silently swallow cache errors with .catch(() => {})', () => {
    const addLogFn = bgSource.match(/async function addLog\(entry\) \{([\s\S]*?)\n\}/);
    expect(addLogFn).not.toBeNull();
    expect(addLogFn[1]).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
  });
});

describe('dedup history cache — no silent default on miss', () => {
  it('does not use cacheGet(todayKey)) || [] pattern', () => {
    expect(bgSource).not.toMatch(/cacheGet\(todayKey\)\)\s*\|\|\s*\[\]/);
  });

  it('falls back to disk on cache miss', () => {
    // Dedup section should load from offscreen when cache misses
    // Match the dedup block (between "Dedup logBuffer" comment and the closing brace)
    const dedupMatch = bgSource.match(/Dedup logBuffer[\s\S]*?loadHistoryRange/);
    expect(dedupMatch).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sendAction helper — response error propagation
// ---------------------------------------------------------------------------

describe('sendAction helper', () => {
  it('utils.js exports sendAction', () => {
    expect(utilsSource).toMatch(/export async function sendAction/);
  });

  it('sendAction throws on success === false', () => {
    expect(utilsSource).toMatch(/success === false[\s\S]*?throw/);
  });

  it('options.js imports sendAction', () => {
    expect(optionsSource).toMatch(/import\s*\{[^}]*sendAction[^}]*\}\s*from\s*['"]\.\/utils/);
  });

  it('popup.js imports sendAction', () => {
    expect(popupSource).toMatch(/import\s*\{[^}]*sendAction[^}]*\}\s*from\s*['"]\.\/utils/);
  });
});

// ---------------------------------------------------------------------------
// No silent response defaults — options.js
// ---------------------------------------------------------------------------

describe('No silent response defaults — options.js', () => {
  it('does not use filesResp?.files || []', () => {
    expect(optionsSource).not.toMatch(/filesResp\?\.files\s*\|\|\s*\[\]/);
  });

  it('does not use resp?.entries || [] or batchResp?.entries || []', () => {
    expect(optionsSource).not.toMatch(/(?:resp|batchResp)\?\.entries\s*\|\|\s*\[\]/);
  });

  it('does not use notesResp?.notesMap || {}', () => {
    expect(optionsSource).not.toMatch(/notesResp\?\.notesMap\s*\|\|\s*\{\}/);
  });

  it('does not use pinsResp?.pins || []', () => {
    expect(optionsSource).not.toMatch(/pinsResp\?\.pins\s*\|\|\s*\[\]/);
  });

  it('does not use resp?.pages || {} or pageResp?.pages || {}', () => {
    expect(optionsSource).not.toMatch(/(?:resp|pageResp)\?\.pages\s*\|\|\s*\{\}/);
  });

  it('does not use notesResp?.notes || []', () => {
    expect(optionsSource).not.toMatch(/notesResp\?\.notes\s*\|\|\s*\[\]/);
  });

  it('does not use snapResp?.snapshots || []', () => {
    expect(optionsSource).not.toMatch(/snapResp\?\.snapshots\s*\|\|\s*\[\]/);
  });

  it('does not use fpResp?.pins || []', () => {
    expect(optionsSource).not.toMatch(/fpResp\?\.pins\s*\|\|\s*\[\]/);
  });

  it('does not reference ensurePageCheckpoint', () => {
    expect(optionsSource).not.toMatch(/ensurePageCheckpoint/);
  });

  it('enrichFromEntityStorage does not silently swallow errors with catch {}', () => {
    // enrichFromEntityStorage readCacheable calls should propagate errors
    const fnBody = optionsSource.match(/async function enrichFromEntityStorage[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    expect(fnBody[0]).not.toMatch(/catch\s*\{\s*\}/);
  });
});

// ---------------------------------------------------------------------------
// No silent response defaults — popup.js
// ---------------------------------------------------------------------------

describe('No silent response defaults — popup.js', () => {
  it('does not use resp?.snapshots || []', () => {
    expect(popupSource).not.toMatch(/resp\?\.snapshots\s*\|\|\s*\[\]/);
  });

  it('does not use snapshotsResp?.snapshots || []', () => {
    expect(popupSource).not.toMatch(/snapshotsResp\?\.snapshots\s*\|\|\s*\[\]/);
  });
});

// ---------------------------------------------------------------------------
// content.js — inline success checks
// ---------------------------------------------------------------------------

describe('content.js — response error checks', () => {
  it('loadPageNotes .then() callbacks check for error responses', () => {
    // Each .then() handler for loadPageNotes should bail on error.
    // Match: sendMessage({...loadPageNotes...}).then(resp => { ... })
    // Exclude: await sendMessage({...loadPageNotes...}) which uses different flow
    const thenBlocks = contentSource.match(/loadPageNotes[^)]*\}\)\.then\(\s*\w+\s*=>\s*\{[^}]*\}/g) || [];
    expect(thenBlocks.length).toBeGreaterThan(0);
    for (const block of thenBlocks) {
      expect(block).toMatch(/success\s*===\s*false/);
    }
  });
});

// ---------------------------------------------------------------------------
// filesystem-storage.js — catch blocks
// ---------------------------------------------------------------------------

describe('filesystem-storage.js — no bare catch on non-parse errors', () => {
  it('removeFile does not use bare catch', () => {
    expect(fsStorageSource).not.toMatch(/removeEntry\(name,?\s*opts?\);\s*\}\s*catch\s*\{\s*\}/);
  });
});

// ---------------------------------------------------------------------------
// utils.js — session cache error handling
// ---------------------------------------------------------------------------

describe('utils.js — readCacheable session error handling', () => {
  it('does not have a bare catch {} for session.get', () => {
    const fnMatch = utilsSource.match(/export async function readCacheable[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch[0]).not.toMatch(/catch\s*\{\s*\}/);
  });
});
