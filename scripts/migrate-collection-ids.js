#!/usr/bin/env node
/**
 * Migration: Fix collection ids and filenames
 *
 * For collections whose id doesn't match generateSlugFromTitle(name):
 *   1. Generate new slug id from name
 *   2. Rename file to {newId}.json
 *   3. Update id in the JSON file
 *   4. Update all JSONL log entries referencing user/{oldId}
 *   5. Update collectionOrder in settings
 *   6. Strip `query` field from all list_meta log entries
 *   7. Set correct `name` on list_meta entries with name=""
 *
 * Usage: node scripts/migrate-collection-ids.js [portal-data-path]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join, resolve } from 'path';

const dataDir = resolve(process.argv[2] || join(process.env.HOME, 'portal-data'));
const historyDir = join(dataDir, 'history');
const listsDir = join(dataDir, 'lists', 'user');

// --- Slug generation (matches extension/utils.js) ---
function generateSlug(text, hashInput) {
  if (!text || text.trim() === '') text = 'untitled';
  const base = text.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 30)
    .replace(/-+$/, '');
  let hash = 0;
  for (let i = 0; i < hashInput.length; i++) {
    hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
  }
  return `${base}-${Math.abs(hash).toString(36)}`.substring(0, 80);
}

function generateSlugFromTitle(title) {
  const hashInput = title + Date.now();
  return generateSlug(title, hashInput);
}

// --- Build rename map: oldId → { newId, name } ---
const renameMap = new Map();
// Also build id → name map for fixing empty names in logs
const idToName = new Map();

if (!existsSync(listsDir)) {
  console.log('No lists/user directory found.');
  process.exit(0);
}

const jsonFiles = readdirSync(listsDir).filter(f => f.endsWith('.json'));
for (const file of jsonFiles) {
  const path = join(listsDir, file);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const filename = file.replace('.json', '');
  const id = data.id || filename;
  const name = data.name || filename;

  idToName.set(id, name);

  // Check if id looks like a slug from generateSlugFromTitle
  // Slugs look like: "lowercase-words-hash" (base + hyphen + hash)
  // Non-slugs: hex-only ids like "e618c1aa", "02fcc9b5"
  const isHexId = /^[0-9a-f]{8}$/.test(id);
  if (isHexId) {
    const newId = generateSlugFromTitle(name);
    renameMap.set(id, { newId, name });
    console.log(`Will rename: ${id} → ${newId} (${name})`);
  }
}

if (renameMap.size === 0) {
  console.log('No collections need id migration.');
} else {
  // Also register new ids in idToName
  for (const [oldId, { newId, name }] of renameMap) {
    idToName.set(newId, name);
  }
}

// --- Fix JSONL history ---
if (existsSync(historyDir)) {
  const jsonlFiles = readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort();
  console.log(`\nProcessing ${jsonlFiles.length} JSONL history files`);

  let totalChanged = 0;
  let filesChanged = 0;

  for (const file of jsonlFiles) {
    const text = readFileSync(join(historyDir, file), 'utf8');
    const lines = text.split('\n');
    let changed = false;
    const newLines = [];

    for (const line of lines) {
      if (!line.trim()) {
        newLines.push(line);
        continue;
      }
      try {
        const entry = JSON.parse(line);
        let modified = false;

        // Rename collection ids in list/list_meta/del_list entries
        if (entry.id && entry.id.startsWith('user/')) {
          const oldId = entry.id.slice('user/'.length);
          const mapping = renameMap.get(oldId);
          if (mapping) {
            entry.id = `user/${mapping.newId}`;
            modified = true;
          }
        }

        // Fix list_meta entries
        if (entry.action === 'list_meta') {
          // Strip query
          if (entry.query !== undefined) {
            delete entry.query;
            modified = true;
          }
          // Fix empty name
          if (!entry.name || entry.name === '') {
            const cid = entry.id?.slice('user/'.length);
            const correctName = idToName.get(cid);
            if (correctName) {
              entry.name = correctName;
              modified = true;
            }
          }
        }

        // Fix collectionOrder in set entries
        if (entry.action === 'set' && entry.key === 'collectionOrder' && Array.isArray(entry.value)) {
          let orderChanged = false;
          entry.value = entry.value.map(id => {
            const mapping = renameMap.get(id);
            if (mapping) { orderChanged = true; return mapping.newId; }
            return id;
          });
          if (orderChanged) modified = true;
        }

        if (modified) {
          newLines.push(JSON.stringify(entry));
          totalChanged++;
          changed = true;
        } else {
          newLines.push(line);
        }
      } catch {
        newLines.push(line);
      }
    }

    if (changed) {
      writeFileSync(join(historyDir, file), newLines.join('\n'));
      filesChanged++;
    }
  }

  console.log(`JSONL: ${totalChanged} entries fixed across ${filesChanged} files`);
}

// --- Rename collection files and update ids ---
for (const file of jsonFiles) {
  const path = join(listsDir, file);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const filename = file.replace('.json', '');
  const oldId = data.id || filename;
  let modified = false;

  // Strip query from all collection files
  if (data.query !== undefined) {
    delete data.query;
    modified = true;
  }

  const mapping = renameMap.get(oldId);
  if (mapping) {
    data.id = mapping.newId;
    modified = true;
    writeFileSync(path, JSON.stringify(data, null, 2));
    const newPath = join(listsDir, `${mapping.newId}.json`);
    renameSync(path, newPath);
    console.log(`Renamed file: ${file} → ${mapping.newId}.json`);
  } else if (modified) {
    writeFileSync(path, JSON.stringify(data, null, 2));
    console.log(`Updated file: ${file} (stripped query)`);
  }
}

console.log('\nDone.');
