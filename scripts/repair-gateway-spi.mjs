#!/usr/bin/env node
/**
 * repair-gateway-spi.mjs — Add missing SPI entries for shallow gateway pins.
 *
 * After migrate-auto-gateways.mjs, `shallow:` pins in auto/gateways may lack
 * corresponding entries in the shallow-page index (SPI). This script:
 *
 * 1. Reads lists/auto/gateways.json to find all `shallow:` pin URLs
 * 2. Reads lists/system/shallow-page.json to find which are missing
 * 3. Searches history JSONL for titles of those URLs
 * 4. Creates SPI entries with { parentIds: [], lists: ['list:auto/gateways'], title, user_title: null }
 * 5. Also adds 'list:auto/gateways' to the `lists` field of existing SPI entries for gateway pins
 *
 * Usage:
 *   node scripts/repair-gateway-spi.mjs              # dry run
 *   node scripts/repair-gateway-spi.mjs --apply      # apply changes
 */
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// 1. Read gateway pins
const gwPath = join(DATA_DIR, 'lists', 'auto', 'gateways.json');
const gw = JSON.parse(readFileSync(gwPath, 'utf-8'));
const shallowPins = gw.pins.filter(p => p.id.startsWith('shallow:'));
const shallowUrls = shallowPins.map(p => p.id.slice(8)); // strip 'shallow:'
console.log(`Gateway shallow pins: ${shallowPins.length}`);

// 2. Read SPI
const spiPath = join(DATA_DIR, 'lists', 'system', 'shallow-page.json');
const spi = JSON.parse(readFileSync(spiPath, 'utf-8'));
const index = spi.index || {};

const missing = shallowUrls.filter(u => !(u in index));
const existing = shallowUrls.filter(u => u in index);
console.log(`Already in SPI: ${existing.length}`);
console.log(`Missing from SPI: ${missing.length}`);

// 3. Search history for titles
const historyDir = join(DATA_DIR, 'history');
const missingSet = new Set(missing);
const titles = {};

const histFiles = readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort();
for (const f of histFiles) {
  const lines = readFileSync(join(historyDir, f), 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const url = entry.url;
      if (url && missingSet.has(url) && entry.title && !titles[url]) {
        titles[url] = entry.title;
      }
    } catch { /* skip malformed lines */ }
  }
}

console.log(`Found titles in history for missing URLs: ${Object.keys(titles).length}`);
console.log(`Will create with null title: ${missing.length - Object.keys(titles).length}`);

// 4. Create missing SPI entries
let created = 0;
for (const url of missing) {
  index[url] = {
    parentIds: [],
    lists: ['list:auto/gateways'],
    title: titles[url] || null,
    user_title: null,
  };
  created++;
  if (dryRun) {
    console.log(`  + ${url} → title: ${titles[url] || '(null)'}`);
  }
}

// 5. Add list membership to existing SPI entries
let updated = 0;
for (const url of existing) {
  const entry = index[url];
  if (!entry.lists) entry.lists = [];
  if (!entry.lists.includes('list:auto/gateways')) {
    entry.lists.push('list:auto/gateways');
    updated++;
    if (dryRun) console.log(`  ~ ${url} → added list:auto/gateways membership`);
  }
}

console.log(`\nSPI entries created: ${created}`);
console.log(`SPI entries updated (added list membership): ${updated}`);

spi.index = index;

if (!dryRun) {
  writeFileSync(spiPath, JSON.stringify(spi));
  console.log(`\nWritten ${spiPath}`);
} else {
  console.log('\n=== DRY RUN complete — pass --apply to write ===');
}
