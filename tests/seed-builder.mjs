// seed-builder.mjs — Build seedTestData file arrays from event logs.
//
// Usage:
//   import { buildSeedFiles } from './seed-builder.mjs';
//   const files = await buildSeedFiles(events, { deviceId, checkpointProgress });
//   await resetAndSeed(extContext, extensionId, files);
//
// `events` is an array of log entry objects (with action, timestamp, url, etc.).
// `checkpointProgress` (default: events.length) controls how many events produce
// entity checkpoint files. ALL events always go to JSONL (matching real drain behavior).
//   - checkpointProgress = events.length  → entity checkpoints + JSONL for all events
//   - checkpointProgress = 0              → JSONL only, no entity checkpoints
//   - checkpointProgress = N              → entity checkpoints for first N, JSONL for all
//
// `entities` is an optional map of key → entity for data that exists outside the
// event log. Replay expects these to be loadable. Common use cases:
//   - Note content:  { 'note:slug': { slug, excerpt, note, cssPath, url } }
//   - Pre-existing pages (e.g. for visit_page enrichment)
// These are loaded into the store before replay starts, and appear in output files.

import { effectOf } from '../extension/replay.js';
import { dateKeyFromTimestamp } from '../extension/utils.js';

/**
 * Build the files array for seedTestData from a list of events.
 *
 * @param {object[]} events - Log entries in chronological order.
 * @param {object}   opts
 * @param {string}   opts.deviceId - Device ID (written to CURRENT file).
 * @param {number}   [opts.checkpointProgress=events.length] - How many events to checkpoint.
 * @param {object}   [opts.settings={}] - Initial manifest:settings value.
 * @param {object}   [opts.entities={}] - Pre-existing entities keyed by cache key (e.g. 'note:slug').
 * @returns {object[]} File descriptors for seedTestData.
 */
export async function buildSeedFiles(
  events,
  { deviceId, checkpointProgress, settings, entities } = {},
) {
  if (!deviceId) throw new Error('buildSeedFiles: deviceId is required');
  if (checkpointProgress == null) checkpointProgress = events.length;

  // In-memory entity store — pre-populate with provided entities, then replay.
  const store = new Map();
  if (entities) {
    for (const [key, value] of Object.entries(entities)) {
      store.set(key, value);
    }
  }

  function load(key) {
    return store.get(key) ?? null;
  }

  // Replay events [0..checkpointProgress) to build checkpoint state.
  const checkpointEvents = events.slice(0, checkpointProgress);
  for (const entry of checkpointEvents) {
    const context = { deviceId: entry.deviceId || deviceId };
    const effects = await effectOf(entry, load, context);
    for (const [key, value] of Object.entries(effects)) {
      if (value === null) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
    }
  }

  // Build file descriptors from the store.
  const files = [];

  // CURRENT
  files.push({ path: 'CURRENT', content: deviceId });

  // Settings — merge user-provided settings with whatever replay produced.
  const replaySettings = store.get('manifest:settings');
  const mergedSettings = { ...(replaySettings || {}), ...(settings || {}) };
  files.push({ path: 'manifest/settings.json', data: mergedSettings });
  store.delete('manifest:settings');

  // Manifests
  for (const [key, value] of store) {
    if (!key.startsWith('manifest:')) continue;
    if (key === 'manifest:name-to-id') {
      files.push({ path: 'manifest/name-to-id.json', data: value });
    } else if (key === 'manifest:list-order') {
      files.push({ path: 'manifest/list-order.json', data: value });
    } else if (key === 'manifest:orphaned') {
      if (value.entries?.length) {
        files.push({ path: 'manifest/orphaned.json', data: value });
      }
    } else if (key === 'manifest:list-name-to-id') {
      files.push({ path: 'manifest/list-name-to-id.json', data: value });
    }
  }

  // Entity files
  for (const [key, value] of store) {
    if (key.startsWith('manifest:')) continue;
    if (key.startsWith('page:')) {
      const slug = key.slice('page:'.length);
      files.push({ path: `pages/${slug}.json`, data: value });
    } else if (key.startsWith('note:')) {
      const slug = key.slice('note:'.length);
      files.push({ path: `data/notes/${slug}.json`, data: value });
    } else if (key.startsWith('list:')) {
      const listId = key.slice('list:'.length);
      files.push({ path: `lists/${listId}.json`, data: value });
    }
  }

  // ALL events → JSONL log files (history for display).
  // In the real system, drain writes both entity checkpoints AND JSONL entries.
  if (events.length) {
    const grouped = new Map(); // "deviceId/date" → entries[]
    for (const entry of events) {
      const dev = entry.deviceId || deviceId;
      const date = dateKeyFromTimestamp(entry.timestamp);
      const groupKey = `${dev}/${date}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey).push(entry);
    }
    for (const [groupKey, entries] of grouped) {
      files.push({ path: `data/logs/${groupKey}.jsonl`, lines: entries });
    }
  }

  return files;
}
