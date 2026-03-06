/**
 * Tests for aggressive context search in ensureCheckpointIfMissing.
 *
 * Verifies that when no title is provided by the caller, ensureCheckpointIfMissing
 * searches SPI and recent history for context before creating a checkpoint.
 * user_title and parentIds are authoritative from SPI only (per SPI completeness
 * guarantee); only title and parentIds fall back to history search.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, '..', 'extension');
const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');
const replaySource = readFileSync(resolve(extDir, 'replay.js'), 'utf-8');

describe('ensureCheckpointIfMissing — context search on miss', () => {
  it('searches for context when caller provides no title', () => {
    expect(bgSource).toMatch(/if \(!title\)\s*\{\s*\n\s*const found = await searchPageContext\(url\);/);
  });

  it('applies found title to checkpoint entry', () => {
    expect(bgSource).toMatch(/if \(found\.title\) entry\.title = found\.title;/);
  });

  it('applies found user_title to checkpoint entry', () => {
    expect(bgSource).toMatch(/if \(found\.user_title\) entry\.user_title = found\.user_title;/);
  });

  it('applies found parentIds to checkpoint entry', () => {
    expect(bgSource).toMatch(/if \(found\.parentIds\.length\) entry\.parentIds = found\.parentIds;/);
  });
});

describe('searchPageContext — SPI as authoritative source', () => {
  it('extracts title, user_title, and parentIds from SPI', () => {
    expect(bgSource).toMatch(/async function searchPageContext\(url\)/);
    expect(bgSource).toMatch(/rec\.title/);
    expect(bgSource).toMatch(/rec\.user_title/);
    expect(bgSource).toMatch(/rec\.parentIds/);
  });

  it('documents all SPI record fields in comment', () => {
    expect(bgSource).toMatch(/SPI record fields/);
    expect(bgSource).toMatch(/title.*auto-detected page title/);
    expect(bgSource).toMatch(/user_title.*user-assigned custom title/);
    expect(bgSource).toMatch(/parentIds.*referrer IDs/);
    expect(bgSource).toMatch(/lists.*list IDs/);
  });

  it('documents SPI completeness guarantee in searchPageContext', () => {
    expect(bgSource).toMatch(/SPI completeness guarantee/);
    expect(bgSource).toMatch(/user_title and parentIds are authoritative/);
  });
});

describe('searchPageContext — history fallback for title and parentIds only', () => {
  it('falls back to history cache for title and parentIds', () => {
    expect(bgSource).toMatch(/cacheGet\('history:' \+ todayStr\)/);
    expect(bgSource).toMatch(/cacheGet\(dateKey\)/);
  });

  it('does NOT extract user_title from history entries', () => {
    const fnMatch = bgSource.match(/function searchHistoryEntries\(entries, url, result\) \{([\s\S]*?)\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[1];
    expect(fnBody).not.toMatch(/user_title/);
  });

  it('documents why user_title is not searched in history', () => {
    expect(bgSource).toMatch(/user_title is NOT searched here/);
    expect(bgSource).toMatch(/user_title is NOT extracted here/);
  });

  it('does NOT query disk (redundant with pageExists check)', () => {
    const fnMatch = bgSource.match(/async function searchPageContext\(url\) \{([\s\S]*?)\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[1];
    expect(fnBody).not.toMatch(/requestOffscreen/);
    expect(fnBody).not.toMatch(/loadPageBatch/);
  });
});

describe('SPI completeness guarantee — documented in replay.js', () => {
  it('applyLogToShallowPage documents the guarantee criteria', () => {
    expect(replaySource).toMatch(/SPI completeness guarantee/);
    expect(replaySource).toMatch(/it has parentIds/);
    expect(replaySource).toMatch(/it belongs to a list/);
    expect(replaySource).toMatch(/it has a user_title/);
  });
});

describe('Callsite correctness — callers pass raw values, no coercion', () => {
  it('referrer parent passes only url (no title)', () => {
    expect(bgSource).toMatch(/await ensureCheckpointIfMissing\(delta\.referrer\);/);
  });

  it('snapshot capture passes url and title', () => {
    expect(bgSource).toMatch(/if \(url\) await ensureCheckpointIfMissing\(url, title\);/);
  });

  it('like shortcut passes tab.url and tab.title', () => {
    expect(bgSource).toMatch(/await ensureCheckpointIfMissing\(tab\.url, tab\.title\);/);
  });

  it('multi-day visit passes url, entry.title, and recentVisitDates', () => {
    expect(bgSource).toMatch(/await ensureCheckpointIfMissing\(url, entry\.title, recentVisitDates\);/);
  });

  it('note drain passes sender tab url and title', () => {
    expect(bgSource).toMatch(/await ensureCheckpointIfMissing\(sender\?\.tab\?\.url, sender\?\.tab\?\.title\);/);
  });
});
