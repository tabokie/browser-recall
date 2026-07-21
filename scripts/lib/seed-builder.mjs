import { dateKeyFromTimestamp } from '../../apps/extension/utils.js';
import { replayStore } from './replay-store.mjs';
import { createHash } from 'node:crypto';

function shard(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 2);
}

export async function buildSeedFiles(
  events,
  { deviceId, checkpointProgress, baseSettings, settings, entities } = {},
) {
  if (!deviceId) throw new Error('buildSeedFiles: deviceId is required');
  if (checkpointProgress == null) checkpointProgress = events.length;

  const baseStore = {};
  if (baseSettings) {
    baseStore['manifest:settings'] = baseSettings;
  }
  if (entities) {
    for (const [key, value] of Object.entries(entities)) {
      baseStore[key] = value;
    }
  }
  const store = replayStore({
    baseStore,
    steps: events.slice(0, checkpointProgress).map((entry) => ({
      entry,
      device_id: entry.deviceId || deviceId,
    })),
  });

  const files = [];

  const replaySettings = store['manifest:settings'];
  const mergedSettings = { ...(replaySettings || {}), ...(settings || {}) };
  files.push({ path: 'views/manifest/settings.json', data: mergedSettings });
  delete store['manifest:settings'];

  for (const [key, value] of Object.entries(store)) {
    if (!key.startsWith('manifest:')) continue;
    if (key === 'manifest:name-to-id') {
      files.push({ path: 'views/manifest/list-name-to-id.json', data: value });
    } else if (key === 'manifest:list-order') {
      files.push({ path: 'views/manifest/list-order.json', data: value });
    } else if (key === 'manifest:orphaned') {
      if (value.entries?.length) {
        files.push({ path: 'views/manifest/orphaned.json', data: value });
      }
    } else if (key === 'manifest:list-name-to-id') {
      files.push({ path: 'views/manifest/list-name-to-id.json', data: value });
    }
  }

  for (const [key, value] of Object.entries(store)) {
    if (key.startsWith('manifest:')) continue;
    if (key.startsWith('page:')) {
      const slug = key.slice('page:'.length);
      files.push({
        path: `views/pages/${shard(slug)}/${slug}.json`,
        data: value,
      });
    } else if (key.startsWith('note:')) {
      const slug = key.slice('note:'.length);
      files.push({ path: `objects/notes/${slug}.json`, data: value });
    } else if (key.startsWith('list:')) {
      const listId = key.slice('list:'.length);
      files.push({ path: `views/lists/${listId}.json`, data: value });
    }
  }

  if (events.length) {
    const grouped = new Map();
    for (const entry of events) {
      const dev = entry.deviceId || deviceId;
      const date = dateKeyFromTimestamp(entry.timestamp);
      const groupKey = `${dev}/${date}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey).push(entry);
    }
    for (const [groupKey, entries] of grouped) {
      files.push({ path: `logs/${groupKey}.jsonl`, lines: entries });
    }
  }

  return files;
}
