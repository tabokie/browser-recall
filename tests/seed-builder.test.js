import { describe, it, expect } from 'vitest';
import { buildSeedFiles } from './seed-builder.mjs';
import { generateSlugFromUrl } from '../extension/utils.js';

const DEVICE = 'test-device';
const NOW = 1700000000000;
const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';
const SLUG_A = generateSlugFromUrl(URL_A);
const SLUG_B = generateSlugFromUrl(URL_B);

function findFile(files, pathPattern) {
  return files.find(f => f.path.includes(pathPattern));
}

describe('buildSeedFiles', () => {
  it('requires deviceId', async () => {
    await expect(buildSeedFiles([])).rejects.toThrow('deviceId is required');
  });

  it('produces CURRENT and settings for empty events', async () => {
    const files = await buildSeedFiles([], { deviceId: DEVICE });
    expect(findFile(files, 'CURRENT')).toEqual({ path: 'CURRENT', content: DEVICE });
    expect(findFile(files, 'manifest/settings.json')).toEqual({
      path: 'manifest/settings.json', data: {},
    });
  });

  // rate_page creates a page entity (via ensurePageEntity).
  // visit_page only enriches existing pages — it does NOT create them.
  it('checkpoints page entity from rate_page event', async () => {
    const events = [
      { action: 'rate_page', url: URL_A, title: 'Page A', timestamp: NOW, likes: 1 },
      { action: 'leave_page', url: URL_A, title: 'Page A', timestamp: NOW + 1000, timeOnPage: 5000, scrollDepth: 50 },
    ];
    const files = await buildSeedFiles(events, { deviceId: DEVICE });

    const pageFile = findFile(files, `pages/${SLUG_A}.json`);
    expect(pageFile).toBeDefined();
    expect(pageFile.data.url).toBe(URL_A);
    expect(pageFile.data.likes).toBe(1);
    // leave_page enriches the existing page with attention data
    expect(pageFile.data.timeOnPage).toBe(5000);
    expect(pageFile.data.scrollDepth).toBe(50);

    // All events always go to JSONL (history for display).
    const logFile = files.find(f => f.path.endsWith('.jsonl'));
    expect(logFile).toBeDefined();
    expect(logFile.lines).toHaveLength(2);
  });

  it('visit_page alone does NOT create page entity (passive visit)', async () => {
    const events = [
      { action: 'visit_page', url: URL_A, title: 'Page A', timestamp: NOW },
    ];
    const files = await buildSeedFiles(events, { deviceId: DEVICE });
    expect(findFile(files, `pages/`)).toBeUndefined();
  });

  it('visit_page enriches pre-existing page entity', async () => {
    const events = [
      { action: 'visit_page', url: URL_A, title: 'Updated Title', timestamp: NOW },
    ];
    const files = await buildSeedFiles(events, {
      deviceId: DEVICE,
      entities: {
        [`page:${SLUG_A}`]: { slug: SLUG_A, url: URL_A, title: 'Old', parentIds: [], childIds: [] },
      },
    });
    const pageFile = findFile(files, `pages/${SLUG_A}.json`);
    expect(pageFile).toBeDefined();
    expect(pageFile.data.title).toBe('Updated Title');
    expect(pageFile.data.timestamps[DEVICE]).toBe(NOW);
  });

  it('checkpointProgress=0 puts all events in log, no entity files', async () => {
    const events = [
      { action: 'rate_page', url: URL_A, title: 'Page A', timestamp: NOW, likes: 1 },
    ];
    const files = await buildSeedFiles(events, { deviceId: DEVICE, checkpointProgress: 0 });

    expect(findFile(files, `pages/`)).toBeUndefined();

    const logFile = files.find(f => f.path.endsWith('.jsonl'));
    expect(logFile).toBeDefined();
    expect(logFile.lines).toHaveLength(1);
    expect(logFile.lines[0].action).toBe('rate_page');
  });

  it('partial checkpoint: entities only for checkpointed events, JSONL for all', async () => {
    const events = [
      { action: 'rate_page', url: URL_A, title: 'Page A', timestamp: NOW, likes: 1 },
      { action: 'rate_page', url: URL_B, title: 'Page B', timestamp: NOW + 1000, likes: 1 },
    ];
    const files = await buildSeedFiles(events, { deviceId: DEVICE, checkpointProgress: 1 });

    // First event checkpointed → page A entity on disk.
    expect(findFile(files, `pages/${SLUG_A}.json`)).toBeDefined();
    // Second event NOT checkpointed → no page B entity file.
    expect(findFile(files, `pages/${SLUG_B}.json`)).toBeUndefined();

    // ALL events go to JSONL regardless of checkpoint progress.
    const logFile = files.find(f => f.path.endsWith('.jsonl'));
    expect(logFile).toBeDefined();
    expect(logFile.lines).toHaveLength(2);
  });

  it('groups log entries by device and date', async () => {
    const day1 = new Date('2025-03-01T12:00:00Z').getTime();
    const day2 = new Date('2025-03-02T12:00:00Z').getTime();
    const events = [
      { action: 'visit_page', url: URL_A, title: 'A', timestamp: day1, deviceId: 'dev-a' },
      { action: 'visit_page', url: URL_B, title: 'B', timestamp: day2, deviceId: 'dev-b' },
    ];
    const files = await buildSeedFiles(events, { deviceId: DEVICE, checkpointProgress: 0 });

    const logFiles = files.filter(f => f.path.endsWith('.jsonl'));
    expect(logFiles).toHaveLength(2);
    expect(logFiles.find(f => f.path.includes('dev-a/2025-03-01'))).toBeDefined();
    expect(logFiles.find(f => f.path.includes('dev-b/2025-03-02'))).toBeDefined();
  });

  it('merges user-provided settings', async () => {
    const files = await buildSeedFiles([], {
      deviceId: DEVICE,
      settings: { trimRules: ['foo'] },
    });
    expect(findFile(files, 'manifest/settings.json').data).toEqual({ trimRules: ['foo'] });
  });

  it('create_note links note to page; note content from entities', async () => {
    const noteSlug = 'test-note';
    const events = [
      { action: 'create_note', url: URL_A, title: 'Page A', timestamp: NOW, path: `notes/${noteSlug}.json` },
    ];
    const files = await buildSeedFiles(events, {
      deviceId: DEVICE,
      entities: {
        [`note:${noteSlug}`]: {
          slug: noteSlug, excerpt: 'hello', note: 'hello world', cssPath: 'p', url: URL_A,
        },
      },
    });

    // create_note calls ensurePageEntity → page is created
    const pageFile = findFile(files, `pages/${SLUG_A}.json`);
    expect(pageFile).toBeDefined();
    expect(pageFile.data.childIds).toContain(`note:${noteSlug}`);

    // Note entity comes from entities + effectOf updates (url set)
    const noteFile = findFile(files, `data/notes/${noteSlug}.json`);
    expect(noteFile).toBeDefined();
    expect(noteFile.data.excerpt).toBe('hello');
    expect(noteFile.data.url).toBe(URL_A);
  });

  it('entities without events are written as checkpoint files', async () => {
    const files = await buildSeedFiles([], {
      deviceId: DEVICE,
      entities: {
        [`page:${SLUG_A}`]: { slug: SLUG_A, url: URL_A, title: 'Pre-made', parentIds: [], childIds: [] },
      },
    });
    const pageFile = findFile(files, `pages/${SLUG_A}.json`);
    expect(pageFile).toBeDefined();
    expect(pageFile.data.title).toBe('Pre-made');
  });

  it('deleted entities are orphaned and page is GCed if ineligible', async () => {
    const noteSlug = 'doomed';
    const events = [
      { action: 'create_note', url: URL_A, timestamp: NOW, path: `notes/${noteSlug}.json` },
      { action: 'delete_note', url: URL_A, timestamp: NOW + 1000, path: `notes/${noteSlug}.json` },
    ];
    const files = await buildSeedFiles(events, {
      deviceId: DEVICE,
      entities: {
        [`note:${noteSlug}`]: { slug: noteSlug, excerpt: 'bye', note: 'bye', cssPath: '', url: URL_A },
      },
    });

    // Page becomes ineligible after note deletion (no children, no likes, no user_title)
    // so effectOf GCs it to null — no page file in output.
    expect(findFile(files, `pages/${SLUG_A}.json`)).toBeUndefined();

    // Orphaned manifest should track the deleted note.
    const orphanedFile = findFile(files, 'manifest/orphaned.json');
    expect(orphanedFile).toBeDefined();
    expect(orphanedFile.data.entries.some(e => e.key === `note:${noteSlug}`)).toBe(true);
  });
});
