#!/usr/bin/env node
/**
 * migrate-note-url.mjs — Migrate note entities from parentIds/childIds to url field,
 * and orphaned.json from keys array to entries array.
 *
 * Note entity shape change:
 *   Before: { slug, timestamp, excerpt, note, cssPath, parentIds: ['page:x'], childIds: [] }
 *   After:  { slug, timestamp, excerpt, note, cssPath, url: 'https://...' }
 *
 * Orphaned manifest shape change:
 *   Before: { timestamp, keys: ['note:slug', 'snap:slug-ts', 'list:id'] }
 *   After:  { timestamp, entries: [{ key: 'note:slug', url: 'https://...' }, ...] }
 *
 * Usage:
 *   node scripts/migrate-note-url.mjs              # dry run
 *   node scripts/migrate-note-url.mjs --apply      # apply changes
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// --- Helper: load page entity to get URL ---
function getPageUrl(pageSlug) {
  const pagePath = join(DATA_DIR, 'pages', pageSlug + '.json');
  if (!existsSync(pagePath)) return null;
  try {
    const page = JSON.parse(readFileSync(pagePath, 'utf-8'));
    return page.url || null;
  } catch { return null; }
}

// --- Helper: derive page slug from snapshot stem ---
function snapStemToPageSlug(snapStem) {
  const lastDash = snapStem.lastIndexOf('-');
  return lastDash > 0 ? snapStem.slice(0, lastDash) : null;
}

// ============================================================
// 1. Migrate note entities: parentIds/childIds → url
// ============================================================
console.log('--- Migrating note entities ---\n');

const notesDir = join(DATA_DIR, 'data', 'notes');
let notesMigrated = 0;
let notesSkipped = 0;
let notesMissing = 0;

if (existsSync(notesDir)) {
  const noteFiles = readdirSync(notesDir).filter(f => f.endsWith('.json'));

  for (const file of noteFiles) {
    const notePath = join(notesDir, file);
    const note = JSON.parse(readFileSync(notePath, 'utf-8'));

    // Already migrated?
    if (note.url !== undefined && !note.parentIds) {
      console.log(`  SKIP ${file} — already migrated`);
      notesSkipped++;
      continue;
    }

    // Find page URL from parentIds
    const pageParent = (note.parentIds || []).find(p => p.startsWith('page:'));
    let url = null;
    if (pageParent) {
      const pageSlug = pageParent.slice(5); // strip 'page:'
      url = getPageUrl(pageSlug);
    }

    if (!url) {
      console.log(`  WARN ${file} — could not resolve page URL (parentIds: ${JSON.stringify(note.parentIds)})`);
      notesMissing++;
    }

    // Build new note entity
    const migrated = {
      slug: note.slug,
      timestamp: note.timestamp,
      excerpt: note.excerpt,
      note: note.note,
      cssPath: note.cssPath,
      url,
    };
    // Preserve extra fields (deleted, deletionReason, replacedBy, etc.)
    for (const [k, v] of Object.entries(note)) {
      if (!['slug', 'timestamp', 'excerpt', 'note', 'cssPath', 'parentIds', 'childIds', 'url'].includes(k)) {
        migrated[k] = v;
      }
    }

    console.log(`  MIGRATE ${file} — url: ${url || '(null)'}`);

    if (!dryRun) {
      writeFileSync(notePath, JSON.stringify(migrated, null, 2) + '\n');
    }
    notesMigrated++;
  }
} else {
  console.log('  No notes directory found.');
}

console.log(`\nNotes: ${notesMigrated} migrated, ${notesSkipped} already done, ${notesMissing} with missing URL.\n`);

// ============================================================
// 2. Migrate orphaned.json: keys → entries
// ============================================================
console.log('--- Migrating orphaned.json ---\n');

const orphanedPath = join(DATA_DIR, 'manifest', 'orphaned.json');
if (!existsSync(orphanedPath)) {
  console.log('  No orphaned.json found — nothing to migrate.\n');
} else {
  const orphaned = JSON.parse(readFileSync(orphanedPath, 'utf-8'));

  // Merge keys into entries
  const existingEntries = orphaned.entries || [];
  const existingKeys = new Set(existingEntries.map(e => e.key));
  const keysToMigrate = (orphaned.keys || []).filter(k => !existingKeys.has(k));

  if (keysToMigrate.length === 0 && !orphaned.keys) {
    console.log('  Already migrated (no keys field).\n');
  } else {
    const newEntries = [...existingEntries];

    for (const key of keysToMigrate) {
      const entry = { key };

      // Resolve parent URL for notes and snapshots
      if (key.startsWith('note:')) {
        const noteSlug = key.slice(5);
        const notePath = join(DATA_DIR, 'data', 'notes', noteSlug + '.json');
        if (existsSync(notePath)) {
          try {
            const note = JSON.parse(readFileSync(notePath, 'utf-8'));
            // After note migration, use url field; before, use parentIds
            if (note.url) {
              entry.url = note.url;
            } else {
              const pageParent = (note.parentIds || []).find(p => p.startsWith('page:'));
              if (pageParent) entry.url = getPageUrl(pageParent.slice(5));
            }
          } catch {}
        }
      } else if (key.startsWith('snapshot:')) {
        const snapStem = key.slice(9);
        const pageSlug = snapStemToPageSlug(snapStem);
        if (pageSlug) {
          const url = getPageUrl(pageSlug);
          if (url) entry.url = url;
        }
      }
      // Lists don't get a url

      console.log(`  MIGRATE key "${key}" → entry ${JSON.stringify(entry)}`);
      newEntries.push(entry);
    }

    const migrated = {
      timestamp: orphaned.timestamp,
      entries: newEntries,
    };

    console.log(`\n  ${keysToMigrate.length} keys migrated to entries. Total entries: ${newEntries.length}`);

    if (!dryRun) {
      writeFileSync(orphanedPath, JSON.stringify(migrated, null, 2) + '\n');
    }
  }
}

console.log('');
if (dryRun && (notesMigrated > 0)) {
  console.log('Re-run with --apply to write changes.');
}
