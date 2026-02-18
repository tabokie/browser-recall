#!/usr/bin/env node
/**
 * Migration: Self-Describing Collections + RecycleBin Out of Settings
 *
 * Migrates ~/portal-data to the new format:
 * 1. Merges collection metadata (name, query, qbTree) from settings.json into
 *    each lists/user/{id}.json file (making them self-describing).
 * 2. Extracts recycleBin from settings.json → lists/recycle-bin.json.
 * 3. Extracts collection ordering → collectionOrder in settings.json.
 * 4. Removes `collections` and `recycleBin` keys from settings.json.
 * 5. Assigns UUIDs to collections that use timestamp-based IDs.
 *
 * Usage: node scripts/migrate-self-describing-collections.js [portal-data-path]
 *   Default path: ~/portal-data
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';

function shortId() {
  return randomBytes(4).toString('hex'); // 8 hex chars
}

const portalDir = process.argv[2] || join(process.env.HOME, 'portal-data');

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

async function main() {
  console.log(`Migrating: ${portalDir}`);

  // 1. Load settings.json
  const settingsPath = join(portalDir, 'settings.json');
  const settings = await readJson(settingsPath);
  if (!settings) {
    console.log('No settings.json found — nothing to migrate.');
    return;
  }

  const collections = settings.collections || [];
  const recycleBin = settings.recycleBin || [];

  if (collections.length === 0 && recycleBin.length === 0) {
    console.log('No collections or recycleBin in settings.json — nothing to migrate.');
    return;
  }

  console.log(`Found ${collections.length} collections, ${recycleBin.length} recycle bin items.`);

  // Ensure lists/user/ exists
  const userDir = join(portalDir, 'lists', 'user');
  if (!existsSync(userDir)) {
    await mkdir(userDir, { recursive: true });
  }

  // 2. Merge metadata into collection files + assign UUIDs
  const idMap = new Map(); // old ID → new UUID
  const collectionOrder = [];

  for (const col of collections) {
    const oldId = col.id;
    // Assign short ID if the current ID looks like a timestamp (all digits) or UUID (36 chars with dashes)
    const needsNewId = /^\d+$/.test(oldId) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(oldId);
    const newId = needsNewId ? shortId() : oldId;
    idMap.set(oldId, newId);
    collectionOrder.push(newId);

    const filePath = join(userDir, `${oldId}.json`);
    let fileData = await readJson(filePath);

    if (!fileData) {
      // File doesn't exist — create it
      fileData = { timestamp: 0, pins: [] };
    }

    // If file is a bare array (legacy format), wrap it
    if (Array.isArray(fileData)) {
      fileData = { timestamp: 0, pins: fileData };
    }

    // Merge metadata from settings
    fileData.id = newId;
    fileData.name = col.name || col.query || oldId;
    fileData.query = col.query || '';
    fileData.qbTree = col.qbTree || null;

    // If ID changed, write to new path and remove old
    if (newId !== oldId) {
      const newPath = join(userDir, `${newId}.json`);
      await writeJson(newPath, fileData);
      // Remove old file
      try {
        const { unlink } = await import('fs/promises');
        await unlink(filePath);
        console.log(`  Renamed ${oldId}.json → ${newId}.json`);
      } catch {
        console.log(`  Created ${newId}.json (old file ${oldId}.json not found)`);
      }
    } else {
      await writeJson(filePath, fileData);
      console.log(`  Updated ${oldId}.json with metadata`);
    }
  }

  // 3. Extract recycleBin → lists/recycle-bin.json
  if (recycleBin.length > 0) {
    const rbPath = join(portalDir, 'lists', 'recycle-bin.json');
    await writeJson(rbPath, { timestamp: 0, items: recycleBin });
    console.log(`Wrote ${recycleBin.length} items to lists/recycle-bin.json`);
  }

  // 4. Update settings.json: add collectionOrder, remove collections & recycleBin
  settings.collectionOrder = collectionOrder;
  delete settings.collections;
  delete settings.recycleBin;

  // 5. Update workspace.collectionIds to use new UUIDs
  if (settings.workspace?.collectionIds) {
    settings.workspace.collectionIds = settings.workspace.collectionIds.map(
      id => idMap.get(id) || id
    );
  }

  await writeJson(settingsPath, settings);
  console.log('Updated settings.json (removed collections/recycleBin, added collectionOrder)');

  // 6. Update JSONL history files: rewrite collectionId references in log entries
  // (pins_replace entries reference the old collection ID)
  const historyDir = join(portalDir, 'history');
  if (existsSync(historyDir)) {
    const { readdir } = await import('fs/promises');
    const files = await readdir(historyDir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(historyDir, file);
      const content = await readFile(filePath, 'utf-8');
      let changed = false;
      const lines = content.split('\n').map(line => {
        if (!line.trim()) return line;
        try {
          const entry = JSON.parse(line);
          if (entry.collectionId && idMap.has(entry.collectionId)) {
            entry.collectionId = idMap.get(entry.collectionId);
            changed = true;
            return JSON.stringify(entry);
          }
          // Update 'set' entries that reference collection IDs
          if (entry.action === 'set' && entry.key === 'collections' && Array.isArray(entry.value)) {
            entry.value = entry.value.map(col => ({
              ...col,
              id: idMap.get(col.id) || col.id,
            }));
            changed = true;
            return JSON.stringify(entry);
          }
        } catch {}
        return line;
      });
      if (changed) {
        await writeFile(filePath, lines.join('\n'), 'utf-8');
        console.log(`  Updated collection IDs in ${file}`);
      }
    }
  }

  console.log('\nMigration complete!');
  if (idMap.size > 0) {
    console.log('\nID mapping (old → new):');
    for (const [old, neu] of idMap) {
      if (old !== neu) console.log(`  ${old} → ${neu}`);
    }
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
