#!/usr/bin/env node
// Migration: remove parent-child relations between gateway root pages and sub-pages.
// Gateway roots accumulate too many childIds; these relations are noise.
//
// What this script does:
// 1. Clears childIds on gateway root page checkpoints
// 2. Removes gateway root refs from parentIds on child page checkpoints
// 3. Removes gateway root refs from parents in shallow-page index entries

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readdirSync } from 'fs';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const PAGES_DIR = join(DATA_DIR, 'pages');
const GATEWAYS_PATH = join(DATA_DIR, 'lists', 'system', 'gateways.json');
const SPI_PATH = join(DATA_DIR, 'lists', 'system', 'shallow-page.json');

const gateways = JSON.parse(readFileSync(GATEWAYS_PATH, 'utf8'));
const origins = new Set(gateways.origins);

// --- Step 1 & 2: Identify gateway root page keys, then clean all page checkpoints ---

const gatewayRootKeys = new Set();

// First pass: identify gateway root page keys
const pageFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.json'));
for (const f of pageFiles) {
  const path = join(PAGES_DIR, f);
  const page = JSON.parse(readFileSync(path, 'utf8'));
  const url = page.url || '';
  try {
    const urlObj = new URL(url);
    const isRoot = (urlObj.pathname === '/' || urlObj.pathname === '') && urlObj.search === '';
    if (origins.has(urlObj.origin) && isRoot) {
      const slug = f.replace('.json', '');
      gatewayRootKeys.add(`page:${slug}`);
    }
  } catch { /* skip invalid URLs */ }
}

console.log(`Found ${gatewayRootKeys.size} gateway root pages`);

// Second pass: clean childIds on gateway roots, parentIds on children
let clearedChildIds = 0;
let cleanedParentIds = 0;

for (const f of pageFiles) {
  const path = join(PAGES_DIR, f);
  const page = JSON.parse(readFileSync(path, 'utf8'));
  const slug = f.replace('.json', '');
  const pageKey = `page:${slug}`;
  let modified = false;

  // Gateway root: clear childIds
  if (gatewayRootKeys.has(pageKey) && page.childIds?.length > 0) {
    console.log(`  Clearing ${page.childIds.length} childIds from ${f} (${page.url})`);
    page.childIds = [];
    modified = true;
    clearedChildIds++;
  }

  // Any page: remove gateway root refs from parentIds
  if (page.parentIds?.length > 0) {
    const before = page.parentIds.length;
    page.parentIds = page.parentIds.filter(pid => !gatewayRootKeys.has(pid));
    if (page.parentIds.length !== before) {
      console.log(`  Removed ${before - page.parentIds.length} gateway parent refs from ${f}`);
      modified = true;
      cleanedParentIds++;
    }
  }

  if (modified) {
    writeFileSync(path, JSON.stringify(page, null, 2) + '\n');
  }
}

console.log(`\nPages: cleared childIds on ${clearedChildIds} gateway roots, cleaned parentIds on ${cleanedParentIds} child pages`);

// --- Step 3: Clean SPI parents ---

const spi = JSON.parse(readFileSync(SPI_PATH, 'utf8'));
const index = spi.index || {};
let spiCleaned = 0;

for (const [url, entry] of Object.entries(index)) {
  if (!entry.parents?.length) continue;
  const before = entry.parents.length;
  entry.parents = entry.parents.filter(p => !gatewayRootKeys.has(p));
  if (entry.parents.length !== before) {
    spiCleaned++;
  }
}

if (spiCleaned > 0) {
  writeFileSync(SPI_PATH, JSON.stringify(spi, null, 2) + '\n');
}

console.log(`SPI: cleaned parents on ${spiCleaned} entries`);
console.log('\nDone.');
