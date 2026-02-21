#!/usr/bin/env node
/**
 * Migration: Unified Log Types
 *
 * Transforms JSONL history entries to use unified action names:
 *   - No action field (visit)         → action: 'page'
 *   - action: 'report'                → action: 'page'
 *   - action: 'capture'               → action: 'page', add url from slug map
 *   - action: 'create_checkpoint'     → action: 'page_checkpoint'
 *
 * Two-pass: first pass builds slug→url map (needed for capture entries that
 * only have slug), second pass transforms entries.
 *
 * Usage: node scripts/migrate-log-types.js [portal-data-path]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const dataDir = resolve(process.argv[2] || join(process.env.HOME, 'portal-data'));
const historyDir = join(dataDir, 'history');

if (!existsSync(historyDir)) {
  console.log('No history directory found, nothing to migrate.');
  process.exit(0);
}

// --- Slug generation (matches extension/utils.js) ---
function generateSlugFromUrl(url) {
  try {
    const parsed = new URL(url);
    let domain = parsed.hostname.toLowerCase();
    if (domain.startsWith('www.')) domain = domain.slice(4);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot > 0) domain = domain.slice(0, lastDot);
    const base = (domain + parsed.pathname)
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 30).replace(/-+$/, '');
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
    }
    return `${base}-${Math.abs(hash).toString(36)}`.substring(0, 80);
  } catch {
    return 'untitled';
  }
}

const jsonlFiles = readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort();
console.log(`Found ${jsonlFiles.length} JSONL history files`);

// --- Pass 1: build slug → url map from visit entries ---
const slugToUrl = new Map();

for (const file of jsonlFiles) {
  const text = readFileSync(join(historyDir, file), 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Visit entries (no action) have url → derive slug
      if (!entry.action && entry.url) {
        const slug = entry.slug || generateSlugFromUrl(entry.url);
        slugToUrl.set(slug, entry.url);
      }
    } catch { /* skip malformed */ }
  }
}
console.log(`Built slug→url map: ${slugToUrl.size} entries`);

// --- Pass 2: transform entries ---
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

      if (!entry.action && entry.url) {
        // Visit entry → action: 'page'
        entry.action = 'page';
        modified = true;
      } else if (entry.action === 'report') {
        // Attention report → action: 'page'
        entry.action = 'page';
        modified = true;
      } else if (entry.action === 'capture') {
        // Snapshot capture → action: 'page', resolve slug to url
        entry.action = 'page';
        if (!entry.url && entry.slug) {
          const url = slugToUrl.get(entry.slug);
          if (url) entry.url = url;
        }
        modified = true;
      } else if (entry.action === 'create_checkpoint') {
        // Checkpoint → action: 'page_checkpoint'
        entry.action = 'page_checkpoint';
        modified = true;
      }

      if (modified) {
        newLines.push(JSON.stringify(entry));
        totalChanged++;
        changed = true;
      } else {
        newLines.push(line);
      }
    } catch {
      newLines.push(line); // preserve malformed lines
    }
  }

  if (changed) {
    writeFileSync(join(historyDir, file), newLines.join('\n'));
    filesChanged++;
  }
}

console.log(`Done: ${totalChanged} entries transformed across ${filesChanged} files`);
