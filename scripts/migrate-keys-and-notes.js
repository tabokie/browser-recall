#!/usr/bin/env node
/**
 * Migration script: Unified Key Schema + Notes as Entities
 *
 * Transforms portal-data directory from old schema to new schema:
 * - Rename atoms/ → pages/
 * - Rename lists/user/*.json → lists/*.json
 * - Rename lists/recycle-bin.json → lists/system/recycle-bin.json
 * - Rename lists/permanent-deletes.json → lists/system/permanent-deletes.json
 * - Rename lists/index/parent-index.json → lists/index/parent.json
 * - Extract highlights from page checkpoints → notes/ directory
 * - Update JSONL entries (highlight/unhighlight/highlights_replace → note, list IDs, recycle keys)
 * - Update checkpoint files (remove highlights array, add children refs, prefix parents/children)
 *
 * Usage: node scripts/migrate-keys-and-notes.js <path-to-portal-data>
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import utils from extension
const utilsPath = path.resolve(__dirname, '../extension/utils.js');
const { generateSlugFromUrl, generateNoteSlug } = await import('file://' + utilsPath);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node migrate-keys-and-notes.js <path-to-portal-data>');
  process.exit(1);
}

const dataDir = path.resolve(args[0]);
if (!fs.existsSync(dataDir)) {
  console.error(`Directory not found: ${dataDir}`);
  process.exit(1);
}

console.log(`Migrating portal-data at: ${dataDir}`);
console.log('');

// ──────────────────────────────────────────────────────────────────────────
// Step 1: JSONL Rewrite (history/*.jsonl)
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 1: Rewriting JSONL history files...');

const historyDir = path.join(dataDir, 'history');
if (!fs.existsSync(historyDir)) {
  console.log('  No history/ directory found, skipping JSONL rewrite');
} else {
  const jsonlFiles = fs.readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort();
  console.log(`  Found ${jsonlFiles.length} JSONL files`);

  // Track note timestamps for unhighlight → recycle-bin conversion
  const noteTimestampToSlug = new Map(); // timestamp → noteSlug

  for (const filename of jsonlFiles) {
    const filePath = path.join(historyDir, filename);
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const newLines = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Transform highlight → note
        if (entry.action === 'highlight' && entry.highlight) {
          const pageSlug = entry.slug || generateSlugFromUrl(entry.url);
          const quote = entry.highlight.text;
          const noteSlug = generateNoteSlug(entry.highlight.timestamp || entry.timestamp, quote);
          noteTimestampToSlug.set(entry.highlight.timestamp || entry.timestamp, noteSlug);

          const noteEntry = {
            timestamp: entry.timestamp,
            action: 'note',
            slug: noteSlug,
            excerpt: entry.highlight.text,
            note: entry.highlight.note || '',
            cssPath: entry.highlight.cssPath || null,
            parents: [`page:${pageSlug}`],
            children: []
          };
          newLines.push(JSON.stringify(noteEntry));
          continue;
        }

        // Transform unhighlight → recycle-bin add
        if (entry.action === 'unhighlight') {
          const matchTs = entry.matchTimestamp;
          const noteSlug = noteTimestampToSlug.get(matchTs);
          if (noteSlug) {
            const recycleEntry = {
              timestamp: entry.timestamp,
              action: 'list',
              id: 'system/recycle-bin',
              op: 'add',
              keys: [`note:${noteSlug}`]
            };
            newLines.push(JSON.stringify(recycleEntry));
          }
          continue;
        }

        // Transform highlights_replace → series of note entries
        if (entry.action === 'highlights_replace' && entry.highlights) {
          const pageSlug = entry.slug || generateSlugFromUrl(entry.url);
          for (const h of entry.highlights) {
            const noteSlug = generateNoteSlug(h.timestamp || entry.timestamp, h.text);
            noteTimestampToSlug.set(h.timestamp || entry.timestamp, noteSlug);
            const noteEntry = {
              timestamp: entry.timestamp,
              action: 'note',
              slug: noteSlug,
              excerpt: h.text,
              note: h.note || '',
              cssPath: h.cssPath || null,
              parents: [`page:${pageSlug}`],
              children: []
            };
            newLines.push(JSON.stringify(noteEntry));
          }
          continue;
        }

        // Transform list entries: update id format
        if (entry.action === 'list') {
          // recycle-bin → system/recycle-bin
          if (entry.id === 'recycle-bin') {
            entry.id = 'system/recycle-bin';
            // Convert urls → keys
            if (entry.urls) {
              entry.keys = entry.urls.map(url => 'page:' + generateSlugFromUrl(url));
              delete entry.urls;
            }
          }
          // permanent-deletes → system/permanent-deletes
          else if (entry.id === 'permanent-deletes') {
            entry.id = 'system/permanent-deletes';
            // Convert urls → keys
            if (entry.urls) {
              entry.keys = entry.urls.map(url => 'page:' + generateSlugFromUrl(url));
              delete entry.urls;
            }
          }
          // user/xxx → xxx
          else if (entry.id && entry.id.startsWith('user/')) {
            entry.id = entry.id.slice(5);
          }
          newLines.push(JSON.stringify(entry));
          continue;
        }

        // Transform list_meta entries: update id format
        if (entry.action === 'list_meta') {
          if (entry.id && entry.id.startsWith('user/')) {
            entry.id = entry.id.slice(5);
          }
          newLines.push(JSON.stringify(entry));
          continue;
        }

        // Transform del_list entries: update id format
        if (entry.action === 'del_list') {
          if (entry.id && entry.id.startsWith('user/')) {
            entry.id = entry.id.slice(5);
          }
          newLines.push(JSON.stringify(entry));
          continue;
        }

        // All other entries pass through unchanged
        newLines.push(line);
      } catch (e) {
        // Keep malformed lines as-is
        newLines.push(line);
      }
    }

    fs.writeFileSync(filePath, newLines.join('\n') + '\n', 'utf-8');
    console.log(`  Rewrote ${filename}: ${lines.length} → ${newLines.length} entries`);
  }
}

console.log('');

// ──────────────────────────────────────────────────────────────────────────
// Step 2: Directory Renames
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 2: Renaming directories and files...');

// atoms/ → pages/
const atomsDir = path.join(dataDir, 'atoms');
const pagesDir = path.join(dataDir, 'pages');
if (fs.existsSync(atomsDir)) {
  fs.renameSync(atomsDir, pagesDir);
  console.log('  Renamed atoms/ → pages/');
} else {
  console.log('  No atoms/ directory found');
}

// lists/user/*.json → lists/*.json
const listsUserDir = path.join(dataDir, 'lists', 'user');
const listsDir = path.join(dataDir, 'lists');
if (fs.existsSync(listsUserDir)) {
  const userFiles = fs.readdirSync(listsUserDir).filter(f => f.endsWith('.json'));
  for (const file of userFiles) {
    const oldPath = path.join(listsUserDir, file);
    const newPath = path.join(listsDir, file);
    fs.renameSync(oldPath, newPath);
  }
  // Remove directory (may contain .DS_Store or other hidden files)
  fs.rmSync(listsUserDir, { recursive: true, force: true });
  console.log(`  Moved ${userFiles.length} files from lists/user/ → lists/`);
} else {
  console.log('  No lists/user/ directory found');
}

// lists/recycle-bin.json → lists/system/recycle-bin.json
const oldRecyclePath = path.join(listsDir, 'recycle-bin.json');
const systemDir = path.join(listsDir, 'system');
if (fs.existsSync(oldRecyclePath)) {
  if (!fs.existsSync(systemDir)) fs.mkdirSync(systemDir, { recursive: true });
  fs.renameSync(oldRecyclePath, path.join(systemDir, 'recycle-bin.json'));
  console.log('  Renamed lists/recycle-bin.json → lists/system/recycle-bin.json');
}

// lists/permanent-deletes.json → lists/system/permanent-deletes.json
const oldDeletesPath = path.join(listsDir, 'permanent-deletes.json');
if (fs.existsSync(oldDeletesPath)) {
  if (!fs.existsSync(systemDir)) fs.mkdirSync(systemDir, { recursive: true });
  fs.renameSync(oldDeletesPath, path.join(systemDir, 'permanent-deletes.json'));
  console.log('  Renamed lists/permanent-deletes.json → lists/system/permanent-deletes.json');
}

// lists/index/parent-index.json → lists/index/parent.json
const oldParentIndexPath = path.join(listsDir, 'index', 'parent-index.json');
const newParentIndexPath = path.join(listsDir, 'index', 'parent.json');
if (fs.existsSync(oldParentIndexPath)) {
  fs.renameSync(oldParentIndexPath, newParentIndexPath);
  console.log('  Renamed lists/index/parent-index.json → lists/index/parent.json');
}

console.log('');

// ──────────────────────────────────────────────────────────────────────────
// Step 3: Checkpoint Rewrites
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 3: Rewriting checkpoint files...');

// Create notes/ directory
const notesDir = path.join(dataDir, 'notes');
if (!fs.existsSync(notesDir)) {
  fs.mkdirSync(notesDir, { recursive: true });
}

// Update page checkpoints (pages/*.json)
if (fs.existsSync(pagesDir)) {
  const pageFiles = fs.readdirSync(pagesDir).filter(f => f.endsWith('.json'));
  console.log(`  Processing ${pageFiles.length} page checkpoints...`);

  for (const file of pageFiles) {
    const filePath = path.join(pagesDir, file);
    const page = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Derive slug from filename if page.slug is null/undefined
    const pageSlug = page.slug || file.replace('.json', '');

    // Extract highlights → create note entities
    const highlights = page.highlights || [];
    const noteKeys = [];
    for (const h of highlights) {
      const noteSlug = generateNoteSlug(h.timestamp || Date.now(), h.text);
      const note = {
        slug: noteSlug,
        timestamp: h.timestamp || Date.now(),
        excerpt: h.text,
        note: h.note || '',
        cssPath: h.cssPath || null,
        parents: [`page:${pageSlug}`],
        children: []
      };
      fs.writeFileSync(path.join(notesDir, `${noteSlug}.json`), JSON.stringify(note, null, 2));
      noteKeys.push(`note:${noteSlug}`);
    }

    // Ensure page.slug is set from filename if missing
    if (!page.slug) {
      page.slug = pageSlug;
    }

    // Remove highlights array, add note children
    delete page.highlights;
    page.children = [...(page.children || []), ...noteKeys];

    // Prefix parents/children with 'page:' (convert bare slugs and URLs)
    if (page.parents) {
      page.parents = page.parents.map(p => {
        if (typeof p !== 'string') return p; // keep objects as-is
        if (p.startsWith('http')) return p; // keep URLs as-is for now
        if (p.startsWith('page:')) return p; // already prefixed
        return 'page:' + p; // bare slug → page:slug
      });
    }
    if (page.children) {
      page.children = page.children.map(c => {
        if (typeof c !== 'string') return c;
        if (c.startsWith('http')) return c;
        if (c.startsWith('page:') || c.startsWith('note:')) return c; // already prefixed
        return 'page:' + c; // bare slug → page:slug
      });
    }

    fs.writeFileSync(filePath, JSON.stringify(page, null, 2));
  }

  console.log(`  Extracted ${fs.readdirSync(notesDir).length} notes`);
}

// Update recycle bin checkpoint (lists/system/recycle-bin.json)
const recycleBinPath = path.join(listsDir, 'system', 'recycle-bin.json');
if (fs.existsSync(recycleBinPath)) {
  const recycleBin = JSON.parse(fs.readFileSync(recycleBinPath, 'utf-8'));
  if (recycleBin.items) {
    recycleBin.items = recycleBin.items.map(item => {
      if (item.url) {
        const key = 'page:' + generateSlugFromUrl(item.url);
        return { key, title: item.title, deletedAt: item.deletedAt };
      }
      return item; // already has key
    });
    fs.writeFileSync(recycleBinPath, JSON.stringify(recycleBin, null, 2));
    console.log(`  Updated recycle bin: ${recycleBin.items.length} items`);
  }
}

// Update permanent deletes checkpoint (lists/system/permanent-deletes.json)
const deletesPath = path.join(listsDir, 'system', 'permanent-deletes.json');
if (fs.existsSync(deletesPath)) {
  const deletes = JSON.parse(fs.readFileSync(deletesPath, 'utf-8'));
  if (deletes.urls) {
    deletes.keys = deletes.urls.map(url => 'page:' + generateSlugFromUrl(url));
    delete deletes.urls;
    fs.writeFileSync(deletesPath, JSON.stringify(deletes, null, 2));
    console.log(`  Updated permanent deletes: ${deletes.keys.length} keys`);
  }
}

// Update parent-index checkpoint (lists/index/parent.json)
if (fs.existsSync(newParentIndexPath)) {
  const parentIndex = JSON.parse(fs.readFileSync(newParentIndexPath, 'utf-8'));
  // Index values are already bare slugs, which is correct (absorption logic adds page: prefix)
  console.log(`  Parent index OK: ${Object.keys(parentIndex.index || {}).length} entries`);
}

console.log('');
console.log('Migration complete!');
console.log('');
console.log('Next steps:');
console.log('1. Verify the migrated data looks correct');
console.log('2. Back up the original ~/portal-data if needed');
console.log('3. Replace ~/portal-data with the migrated version');
console.log('4. Load the extension to test');
