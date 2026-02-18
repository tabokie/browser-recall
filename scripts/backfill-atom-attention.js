#!/usr/bin/env node
/**
 * Migration: Backfill attention data from JSONL history into atom files.
 *
 * Old atoms (pre-event-sourcing) have `attention: ""` even though JSONL history
 * contains visit entries with attention data. This script scans JSONL and applies
 * the latest attention to each atom that lacks it.
 *
 * Usage: node scripts/backfill-atom-attention.js [portal-data-path]
 *   Default path: ~/portal-data
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const portalDir = process.argv[2] || join(process.env.HOME, 'portal-data');
const atomsDir = join(portalDir, 'atoms');
const historyDir = join(portalDir, 'history');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
}

async function main() {
  console.log(`Backfilling atom attention from: ${portalDir}`);

  if (!existsSync(atomsDir) || !existsSync(historyDir)) {
    console.log('No atoms/ or history/ directory — nothing to do.');
    return;
  }

  // 1. Find atoms that lack attention
  const atomFiles = (await readdir(atomsDir)).filter(f => f.endsWith('.json'));
  const staleAtoms = new Map(); // url → { atomFile, atom }

  for (const file of atomFiles) {
    const atom = await readJson(join(atomsDir, file));
    if (!atom || !atom.url) continue;
    if (atom.attention && atom.attention !== '{}') continue; // already has attention
    staleAtoms.set(atom.url, { atomFile: file, atom });
  }

  if (staleAtoms.size === 0) {
    console.log('All atoms already have attention data.');
    return;
  }

  console.log(`Found ${staleAtoms.size} atoms without attention. Scanning JSONL...`);

  // 2. Scan JSONL for the latest visit attention per URL
  const attentionByUrl = new Map(); // url → { attention, timestamp }
  const jsonlFiles = (await readdir(historyDir)).filter(f => f.endsWith('.jsonl')).sort();

  for (const file of jsonlFiles) {
    const content = await readFile(join(historyDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.action) continue; // skip action entries
        if (!entry.url || !entry.attention) continue;
        if (entry.attention === '{}') continue;
        const prev = attentionByUrl.get(entry.url);
        if (!prev || entry.timestamp > prev.timestamp) {
          attentionByUrl.set(entry.url, { attention: entry.attention, timestamp: entry.timestamp });
        }
      } catch {}
    }
  }

  // 3. Apply attention to stale atoms
  let updated = 0;
  for (const [url, { atomFile, atom }] of staleAtoms) {
    const hist = attentionByUrl.get(url);
    if (!hist) continue;

    atom.attention = hist.attention;
    // Also migrate watermark → timestamp if needed
    if (!atom.timestamp && atom.watermark) {
      atom.timestamp = atom.watermark;
      delete atom.watermark;
    }
    await writeFile(join(atomsDir, atomFile), JSON.stringify(atom, null, 2), 'utf-8');
    updated++;
    console.log(`  Updated ${atomFile}`);
  }

  console.log(`\nDone! Updated ${updated} of ${staleAtoms.size} stale atoms.`);
  if (staleAtoms.size - updated > 0) {
    console.log(`${staleAtoms.size - updated} atoms had no matching JSONL visits.`);
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
