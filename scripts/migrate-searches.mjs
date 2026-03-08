#!/usr/bin/env node
/**
 * migrate-searches.mjs — Convert qbTrees → savedSearches in list entities and JSONL history.
 *
 * Changes:
 * 1. For each lists/*.json: extract keyword values from qbTrees predicates → savedSearches: string[]
 *    Remove qbTrees and autoEnabled fields.
 * 2. For each JSONL history file: strip qbTrees/autoEnabled from list_meta entries,
 *    replace with savedSearches if keywords were present.
 *
 * Idempotent: skips list files that already have savedSearches and no qbTrees.
 *
 * Usage:
 *   node scripts/migrate-searches.mjs              # dry run
 *   node scripts/migrate-searches.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LISTS_DIR = join(DATA_DIR, 'lists');
const HISTORY_DIR = join(DATA_DIR, 'history');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// Helper: extract keyword values from qbTrees predicates
// ---------------------------------------------------------------------------
function extractKeywords(qbTrees) {
  if (!Array.isArray(qbTrees)) return [];
  const keywords = [];
  for (const node of qbTrees) {
    extractFromNode(node, keywords);
  }
  return [...new Set(keywords)]; // deduplicate
}

function extractFromNode(node, keywords) {
  if (!node) return;
  if (node.type === 'predicate' && node.predicateType === 'keyword' && node.value) {
    keywords.push(node.value);
  }
  // Recurse into operator children
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      extractFromNode(child, keywords);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Migrate list entity files
// ---------------------------------------------------------------------------
console.log('--- List Entity Files ---\n');

function migrateListFile(filePath, slug) {
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));

  // Skip if already migrated
  if (data.savedSearches !== undefined && data.qbTrees === undefined) {
    console.log(`  ${slug}: already migrated, skipping`);
    return false;
  }

  const qbTrees = data.qbTrees || [];
  const savedSearches = extractKeywords(qbTrees);

  console.log(`  ${slug}: qbTrees(${qbTrees.length}) → savedSearches(${savedSearches.length})${savedSearches.length ? ': ' + JSON.stringify(savedSearches) : ''}`);
  if (data.autoEnabled) {
    console.log(`    removing autoEnabled: ${JSON.stringify(data.autoEnabled)}`);
  }

  // Build new entity
  const newData = { ...data };
  delete newData.qbTrees;
  delete newData.autoEnabled;
  newData.savedSearches = savedSearches;

  if (!dryRun) {
    writeFileSync(filePath, JSON.stringify(newData, null, 2));
  }
  return true;
}

// Process all list files (top-level)
let listCount = 0;
for (const entry of readdirSync(LISTS_DIR, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
  const slug = entry.name.replace('.json', '');
  const filePath = join(LISTS_DIR, entry.name);
  if (migrateListFile(filePath, slug)) listCount++;
}

// Process system list files (explore, etc.)
const SYSTEM_DIR = join(LISTS_DIR, 'system');
if (existsSync(SYSTEM_DIR)) {
  for (const entry of readdirSync(SYSTEM_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const slug = 'system/' + entry.name.replace('.json', '');
    const filePath = join(SYSTEM_DIR, entry.name);
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      // Only migrate if file has qbTrees
      if (data.qbTrees !== undefined) {
        if (migrateListFile(filePath, slug)) listCount++;
      }
    } catch { /* skip non-JSON or malformed */ }
  }
}

console.log(`\nMigrated ${listCount} list files\n`);

// ---------------------------------------------------------------------------
// 2. Migrate JSONL history files
// ---------------------------------------------------------------------------
console.log('--- JSONL History Files ---\n');

let historyChanges = 0;

if (existsSync(HISTORY_DIR)) {
  for (const entry of readdirSync(HISTORY_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = join(HISTORY_DIR, entry.name);
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    let fileChanged = false;
    const newLines = [];

    for (const line of lines) {
      if (!line.trim()) { newLines.push(line); continue; }
      try {
        const obj = JSON.parse(line);
        if (obj.action === 'list_meta' && (obj.qbTrees !== undefined || obj.autoEnabled !== undefined)) {
          const savedSearches = obj.qbTrees ? extractKeywords(obj.qbTrees) : undefined;
          delete obj.qbTrees;
          delete obj.autoEnabled;
          if (savedSearches && savedSearches.length > 0) {
            obj.savedSearches = savedSearches;
          }
          newLines.push(JSON.stringify(obj));
          fileChanged = true;
        } else {
          newLines.push(line);
        }
      } catch {
        newLines.push(line); // preserve malformed lines
      }
    }

    if (fileChanged) {
      console.log(`  ${entry.name}: updated list_meta entries`);
      if (!dryRun) {
        writeFileSync(filePath, newLines.join('\n'));
      }
      historyChanges++;
    }
  }
}

console.log(`\nUpdated ${historyChanges} history files\n`);

if (dryRun) {
  console.log('=== DRY RUN complete. Pass --apply to write changes. ===');
} else {
  console.log('=== Migration applied successfully. ===');
}
