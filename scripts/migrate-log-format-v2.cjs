#!/usr/bin/env node
/**
 * Migration script: portal-data log format v2
 *
 * Migrates ~/portal-data in-place:
 *
 * JSONL history entries:
 *   1. Visit entries (no action): remove slug, intent, attention fields
 *   2. ensure_checkpoint → create_checkpoint, remove slug field
 *   3. add_child → remove entirely (dead action)
 *   4. pins_replace → list (id=user/{collectionId}, op=clear + op=add)
 *   5. collection_meta → list_meta (id=user/{collectionId}), remove collectionId
 *   6. collection_delete → del_list (id=user/{collectionId}), remove collectionId
 *   7. recycle_replace → list (id=recycle-bin, op=clear + op=add)
 *   8. deletes_replace → list (id=permanent-deletes, op=clear + op=add)
 *
 * Atom files:
 *   1. attention: strip clicks and highlights, keep only scrollDepth + timeOnPage
 *
 * Usage: node scripts/migrate-log-format-v2.js [portal-data-dir]
 *
 * Prerequisites:
 *   - Extension's write buffer must be empty (no pending writes)
 *   - Back up ~/portal-data before running
 */

const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] || path.join(require('os').homedir(), 'portal-data');

if (!fs.existsSync(DIR)) {
  console.error(`Error: Directory '${DIR}' does not exist`);
  process.exit(1);
}

console.log(`Migrating portal-data in: ${DIR}\n`);

// ─── JSONL History ──────────────────────────────────────────────────────

const historyDir = path.join(DIR, 'history');
if (fs.existsSync(historyDir)) {
  const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort();
  let totalLines = 0;
  let removedLines = 0;
  let transformedLines = 0;
  let addedLines = 0;

  for (const file of files) {
    const filePath = path.join(historyDir, file);
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const outputLines = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      totalLines++;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        outputLines.push(line); // keep malformed lines as-is
        continue;
      }

      // 1. Visit entries (no action): remove slug, intent, attention
      if (!entry.action) {
        delete entry.slug;
        delete entry.intent;
        delete entry.attention;
        outputLines.push(JSON.stringify(entry));
        transformedLines++;
        continue;
      }

      // 2. ensure_checkpoint → create_checkpoint
      if (entry.action === 'ensure_checkpoint') {
        entry.action = 'create_checkpoint';
        delete entry.slug;
        outputLines.push(JSON.stringify(entry));
        transformedLines++;
        continue;
      }

      // 3. add_child → remove
      if (entry.action === 'add_child') {
        removedLines++;
        continue;
      }

      // 4. pins_replace → list clear + add
      if (entry.action === 'pins_replace') {
        const cid = entry.collectionId;
        const pins = entry.pins || [];
        // Emit clear
        outputLines.push(JSON.stringify({
          timestamp: entry.timestamp,
          action: 'list',
          id: `user/${cid}`,
          op: 'clear',
          urls: []
        }));
        // Emit add (if pins non-empty)
        if (pins.length > 0) {
          outputLines.push(JSON.stringify({
            timestamp: entry.timestamp + 1,
            action: 'list',
            id: `user/${cid}`,
            op: 'add',
            urls: pins.map(p => p.url)
          }));
          addedLines++;
        }
        transformedLines++;
        continue;
      }

      // 5. collection_meta → list_meta
      if (entry.action === 'collection_meta') {
        const cid = entry.collectionId;
        const newEntry = { timestamp: entry.timestamp, action: 'list_meta', id: `user/${cid}` };
        if (entry.name !== undefined) newEntry.name = entry.name;
        if (entry.query !== undefined) newEntry.query = entry.query;
        if (entry.qbTree !== undefined) newEntry.qbTree = entry.qbTree;
        outputLines.push(JSON.stringify(newEntry));
        transformedLines++;
        continue;
      }

      // 6. collection_delete → del_list
      if (entry.action === 'collection_delete') {
        outputLines.push(JSON.stringify({
          timestamp: entry.timestamp,
          action: 'del_list',
          id: `user/${entry.collectionId}`
        }));
        transformedLines++;
        continue;
      }

      // 7. recycle_replace → list clear + add
      if (entry.action === 'recycle_replace') {
        const items = entry.items || [];
        outputLines.push(JSON.stringify({
          timestamp: entry.timestamp,
          action: 'list',
          id: 'recycle-bin',
          op: 'clear',
          urls: []
        }));
        if (items.length > 0) {
          outputLines.push(JSON.stringify({
            timestamp: entry.timestamp + 1,
            action: 'list',
            id: 'recycle-bin',
            op: 'add',
            urls: items.map(i => i.url)
          }));
          addedLines++;
        }
        transformedLines++;
        continue;
      }

      // 8. deletes_replace → list clear + add
      if (entry.action === 'deletes_replace') {
        const urls = entry.urls || [];
        outputLines.push(JSON.stringify({
          timestamp: entry.timestamp,
          action: 'list',
          id: 'permanent-deletes',
          op: 'clear',
          urls: []
        }));
        if (urls.length > 0) {
          outputLines.push(JSON.stringify({
            timestamp: entry.timestamp + 1,
            action: 'list',
            id: 'permanent-deletes',
            op: 'add',
            urls
          }));
          addedLines++;
        }
        transformedLines++;
        continue;
      }

      // Passthrough: capture, highlight, unhighlight, highlights_replace, set, etc.
      // Remove slug field from capture entries (slug derived from url during replay)
      if (entry.action === 'capture' || entry.action === 'highlight' ||
          entry.action === 'unhighlight' || entry.action === 'highlights_replace') {
        // Keep slug for backward compat (replay.js uses matchSlug = entrySlug || entry.slug)
        // But these entries may not have url field, so slug is needed
      }
      outputLines.push(JSON.stringify(entry));
    }

    fs.writeFileSync(filePath, outputLines.join('\n') + '\n');
  }

  console.log(`JSONL history:`);
  console.log(`  Files: ${files.length}`);
  console.log(`  Total lines processed: ${totalLines}`);
  console.log(`  Transformed: ${transformedLines}`);
  console.log(`  Removed (add_child): ${removedLines}`);
  console.log(`  Added (split entries): ${addedLines}`);
} else {
  console.log('JSONL history: directory not found, skipping');
}

// ─── Atom Files ─────────────────────────────────────────────────────────

const atomsDir = path.join(DIR, 'atoms');
if (fs.existsSync(atomsDir)) {
  const files = fs.readdirSync(atomsDir).filter(f => f.endsWith('.json'));
  let attentionCleaned = 0;

  for (const file of files) {
    const filePath = path.join(atomsDir, file);
    let modified = false;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      // Clean attention: keep only scrollDepth and timeOnPage
      if (data.attention && typeof data.attention === 'string') {
        try {
          const att = JSON.parse(data.attention);
          const clean = {};
          if (att.scrollDepth !== undefined) clean.scrollDepth = att.scrollDepth;
          if (att.timeOnPage !== undefined) clean.timeOnPage = att.timeOnPage;
          const cleanStr = JSON.stringify(clean);
          if (cleanStr !== data.attention) {
            data.attention = cleanStr;
            modified = true;
            attentionCleaned++;
          }
        } catch { /* malformed attention, skip */ }
      }

      if (modified) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      }
    } catch { /* skip malformed atom files */ }
  }

  console.log(`\nAtom files:`);
  console.log(`  Total: ${files.length}`);
  console.log(`  Attention cleaned: ${attentionCleaned}`);
} else {
  console.log('\nAtom files: directory not found, skipping');
}

console.log('\nMigration complete.');
