#!/usr/bin/env node
/**
 * fix-entity-refs.mjs — Fix stale entity references in ~/portal-data checkpoint files.
 *
 * Fixes:
 * 1. List pins: shallow:URL → page:<slug>
 * 2. Page childIds: snap:slug/ts → snapshot:slug-ts
 * 3. Page childIds: shallow:URL → page:<slug>
 * 4. Remove stale mdPath/htmlPath fields from page entities
 *
 * Usage:
 *   node scripts/fix-entity-refs.mjs              # dry run
 *   node scripts/fix-entity-refs.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { generateSlugFromUrl } from '../extension/utils.js';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

let fixedLists = 0, fixedPages = 0, totalPinFixes = 0, totalChildIdFixes = 0, totalFieldRemovals = 0;

// ---------------------------------------------------------------------------
// 1. Fix list pins: shallow:URL → page:<slug>
// ---------------------------------------------------------------------------
console.log('--- Fixing list pin IDs ---');

function fixListDir(dirPath) {
  if (!existsSync(dirPath)) return;
  for (const f of readdirSync(dirPath)) {
    if (!f.endsWith('.json')) continue;
    const filePath = join(dirPath, f);
    const entity = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!entity.pins || entity.pins.length === 0) continue;

    let changed = false;
    const fixedPins = entity.pins.map(pin => {
      if (pin.id && pin.id.startsWith('shallow:')) {
        const url = pin.id.slice('shallow:'.length);
        try {
          const slug = generateSlugFromUrl(url);
          const newId = `page:${slug}`;
          console.log(`  ${f}: ${pin.id} → ${newId}`);
          totalPinFixes++;
          changed = true;
          return { ...pin, id: newId };
        } catch (e) {
          console.warn(`  ${f}: SKIP invalid URL in pin: ${url} (${e.message})`);
          return pin;
        }
      }
      return pin;
    });

    if (changed) {
      entity.pins = fixedPins;
      if (!dryRun) writeFileSync(filePath, JSON.stringify(entity, null, 2) + '\n');
      fixedLists++;
    }
  }
}

fixListDir(join(DATA_DIR, 'lists'));
fixListDir(join(DATA_DIR, 'lists', 'system'));
fixListDir(join(DATA_DIR, 'lists', 'auto'));

// ---------------------------------------------------------------------------
// 2. Fix page childIds: snap:slug/ts → snapshot:slug-ts, shallow:URL → page:<slug>
// 3. Remove stale mdPath/htmlPath fields
// ---------------------------------------------------------------------------
console.log('\n--- Fixing page entity childIds and removing stale fields ---');

const pagesDir = join(DATA_DIR, 'pages');
if (existsSync(pagesDir)) {
  for (const f of readdirSync(pagesDir)) {
    if (!f.endsWith('.json')) continue;
    const filePath = join(pagesDir, f);
    const entity = JSON.parse(readFileSync(filePath, 'utf-8'));
    let changed = false;

    // Fix childIds
    if (entity.childIds && entity.childIds.length > 0) {
      const fixedChildIds = entity.childIds.map(cid => {
        // snap:slug/ts → snapshot:slug-ts
        if (cid.startsWith('snap:')) {
          const rest = cid.slice('snap:'.length); // slug/ts
          const newId = `snapshot:${rest.replace('/', '-')}`;
          console.log(`  ${f}: childId ${cid} → ${newId}`);
          totalChildIdFixes++;
          changed = true;
          return newId;
        }
        // shallow:URL → page:<slug>
        if (cid.startsWith('shallow:')) {
          const url = cid.slice('shallow:'.length);
          try {
            const slug = generateSlugFromUrl(url);
            const newId = `page:${slug}`;
            console.log(`  ${f}: childId ${cid} → ${newId}`);
            totalChildIdFixes++;
            changed = true;
            return newId;
          } catch (e) {
            console.warn(`  ${f}: SKIP invalid URL in childId: ${url} (${e.message})`);
            return cid;
          }
        }
        return cid;
      });
      if (changed) entity.childIds = fixedChildIds;
    }

    // Remove stale mdPath/htmlPath
    if ('mdPath' in entity) {
      console.log(`  ${f}: remove mdPath`);
      delete entity.mdPath;
      totalFieldRemovals++;
      changed = true;
    }
    if ('htmlPath' in entity) {
      console.log(`  ${f}: remove htmlPath`);
      delete entity.htmlPath;
      totalFieldRemovals++;
      changed = true;
    }

    if (changed) {
      if (!dryRun) writeFileSync(filePath, JSON.stringify(entity, null, 2) + '\n');
      fixedPages++;
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n=== SUMMARY ===');
console.log(`  Lists fixed:       ${fixedLists} (${totalPinFixes} pin ID fixes)`);
console.log(`  Pages fixed:       ${fixedPages} (${totalChildIdFixes} childId fixes, ${totalFieldRemovals} field removals)`);

if (dryRun) console.log('\nDry run. Pass --apply to write.');
