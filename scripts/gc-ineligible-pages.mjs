#!/usr/bin/env node
/**
 * gc-ineligible-pages.mjs — Remove ineligible page checkpoint files.
 *
 * A page is eligible if ANY of:
 * - Pinned in at least one list (cross-referenced from list files — NOT from
 *   page parentIds, which may be stale on disk)
 * - childIds contains at least one note: or snapshot: key
 * - user_title is set and truthy
 * - likes is set and non-zero
 *
 * Also removes manifest/page-info.json if it exists.
 *
 * Usage:
 *   node scripts/gc-ineligible-pages.mjs              # dry run
 *   node scripts/gc-ineligible-pages.mjs --apply      # move ineligible to deleted/
 */
import { readFileSync, readdirSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const PAGES_DIR = join(DATA_DIR, 'pages');
const LISTS_DIR = join(DATA_DIR, 'lists');
const DELETED_DIR = join(DATA_DIR, 'deleted');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// --- Build set of page slugs pinned in any list (source of truth) ---

const pinnedSlugs = new Set();

function scanListFile(filePath) {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    for (const pin of (data.pins || [])) {
      if (pin.id && pin.id.startsWith('page:')) {
        pinnedSlugs.add(pin.id.slice(5));
      }
    }
  } catch {}
}

// Scan lists/ (user lists)
if (existsSync(LISTS_DIR)) {
  for (const f of readdirSync(LISTS_DIR)) {
    if (f.endsWith('.json')) scanListFile(join(LISTS_DIR, f));
  }
  // Scan lists/auto/
  const autoDir = join(LISTS_DIR, 'auto');
  if (existsSync(autoDir)) {
    for (const f of readdirSync(autoDir)) {
      if (f.endsWith('.json')) scanListFile(join(autoDir, f));
    }
  }
  // Scan lists/system/
  const sysDir = join(LISTS_DIR, 'system');
  if (existsSync(sysDir)) {
    for (const f of readdirSync(sysDir)) {
      if (f.endsWith('.json')) scanListFile(join(sysDir, f));
    }
  }
}

console.log(`Found ${pinnedSlugs.size} page slugs pinned in lists\n`);

// --- Eligibility check using list pins + page entity fields ---

function isPageEligible(slug, entity) {
  if (pinnedSlugs.has(slug)) return true;
  if (entity.childIds?.some(id => id.startsWith('note:') || id.startsWith('snapshot:'))) return true;
  if (entity.user_title) return true;
  if (entity.likes) return true;
  return false;
}

// --- GC ineligible pages ---

if (!existsSync(PAGES_DIR)) {
  console.log('No pages/ directory found at', PAGES_DIR);
  process.exit(0);
}

const files = readdirSync(PAGES_DIR).filter(f => f.endsWith('.json'));
let eligible = 0, ineligible = 0, errors = 0;

for (const file of files) {
  const filePath = join(PAGES_DIR, file);
  const slug = file.replace('.json', '');
  try {
    const entity = JSON.parse(readFileSync(filePath, 'utf8'));
    if (isPageEligible(slug, entity)) {
      eligible++;
    } else {
      ineligible++;
      console.log(`GC: ${slug} (visitDates: ${(entity.visitDates || []).length}, url: ${entity.url || '?'})`);
      if (!dryRun) {
        mkdirSync(DELETED_DIR, { recursive: true });
        renameSync(filePath, join(DELETED_DIR, file));
      }
    }
  } catch (e) {
    errors++;
    console.error(`Error reading ${file}:`, e.message);
  }
}

console.log(`\nPages: ${eligible} eligible, ${ineligible} ineligible (GC'd), ${errors} errors`);

// --- Remove manifest/page-info.json ---

const pageInfoPath = join(DATA_DIR, 'manifest', 'page-info.json');
if (existsSync(pageInfoPath)) {
  console.log(`\nRemoving manifest/page-info.json`);
  if (!dryRun) {
    mkdirSync(DELETED_DIR, { recursive: true });
    renameSync(pageInfoPath, join(DELETED_DIR, 'page-info.json'));
  }
} else {
  console.log('\nmanifest/page-info.json not found (already removed)');
}

if (dryRun) console.log('\n=== DRY RUN — no files changed (pass --apply to execute) ===');
