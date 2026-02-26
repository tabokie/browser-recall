#!/usr/bin/env node
/**
 * Rebuild list checkpoint files from JSONL history logs.
 *
 * Seeds the cache from existing checkpoint files, then replays only newer
 * list/list_meta/del_list entries through the shared replay module.
 *
 * Usage: node scripts/rebuild-list-checkpoints.js [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { effectOf } from '../extension/replay.js';

const PORTAL_DATA = path.join(process.env.HOME, 'portal-data');
const HISTORY_DIR = path.join(PORTAL_DATA, 'history');
const LISTS_DIR = path.join(PORTAL_DATA, 'lists');

const dryRun = process.argv.includes('--dry-run');

// ── 1. Seed cache from existing checkpoint files ──

const cache = new Map();

for (const file of fs.readdirSync(LISTS_DIR)) {
  if (!file.endsWith('.json')) continue;
  // Skip system/ subdirectory entries
  if (file.startsWith('system') || file.startsWith('index')) continue;
  const listId = file.replace('.json', '');
  try {
    const data = JSON.parse(fs.readFileSync(path.join(LISTS_DIR, file), 'utf-8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Ensure slug is set
      if (!data.slug) data.slug = listId;
      cache.set(`list:${listId}`, data);
      console.log(`  seeded list:${listId} — ts=${data.timestamp} — ${(data.pins || []).length} pins`);
    }
  } catch { /* skip malformed */ }
}

// ── 2. Read all JSONL history and extract list-related entries ──

const historyFiles = fs.readdirSync(HISTORY_DIR)
  .filter(f => f.endsWith('.jsonl'))
  .sort();

const listEntries = [];

for (const file of historyFiles) {
  const filePath = path.join(HISTORY_DIR, file);
  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (['list', 'list_meta', 'del_list'].includes(entry.action)) {
        // Only include user list entries (skip system/)
        if (entry.id && !entry.id.startsWith('system/')) {
          listEntries.push(entry);
        }
      }
    } catch { /* skip malformed lines */ }
  }
}

// Sort by timestamp
listEntries.sort((a, b) => a.timestamp - b.timestamp);

console.log(`\nFound ${listEntries.length} user-list log entries across ${historyFiles.length} history files`);

// ── 3. Replay entries, skipping those already reflected in checkpoints ──

const load = async (key) => cache.get(key) ?? null;

let applied = 0;
for (const entry of listEntries) {
  const key = `list:${entry.id}`;
  const existing = cache.get(key);
  // Skip entries at or before the checkpoint's watermark
  if (existing && existing.timestamp >= entry.timestamp) continue;

  const result = await effectOf(entry, load);
  for (const [k, entity] of Object.entries(result)) {
    cache.set(k, entity);
  }
  applied++;
}

console.log(`Applied ${applied} entries (skipped ${listEntries.length - applied} already checkpointed)`);

// ── 4. Write checkpoint files ──

const userLists = [];
const deletedLists = [];

for (const [key, entity] of cache) {
  if (!key.startsWith('list:') || key.startsWith('list:system/')) continue;
  const listId = key.slice('list:'.length);
  if (entity === null || entity.deleted) {
    deletedLists.push(listId);
  } else {
    userLists.push({ listId, entity });
  }
}

console.log(`\nResult:`);
for (const { listId, entity } of userLists) {
  const pinCount = (entity.pins || []).length;
  const name = entity.name || '(unnamed)';
  console.log(`  list:${listId} — "${name}" — ${pinCount} pins — ts=${entity.timestamp}`);
}
if (deletedLists.length) {
  console.log(`  deleted: ${deletedLists.join(', ')}`);
}

if (dryRun) {
  console.log('\n[DRY RUN] No files written.');
  process.exit(0);
}

for (const { listId, entity } of userLists) {
  const filePath = path.join(LISTS_DIR, `${listId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(entity, null, 2) + '\n');
  console.log(`  wrote ${filePath}`);
}

for (const listId of deletedLists) {
  const filePath = path.join(LISTS_DIR, `${listId}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`  deleted ${filePath}`);
  }
}

console.log('\nDone.');
