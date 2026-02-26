#!/usr/bin/env node
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { generateSlugFromUrl } from '../extension/utils.js';

const HISTORY_DIR = join(process.env.HOME, 'portal-data/history');
const url = process.argv[2] || 'https://jandan.net/p/122112';
const slug = generateSlugFromUrl(url);
console.log('URL:', url);
console.log('slug:', slug);
console.log();

const files = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort();
const allEntries = [];
for (const f of files) {
  for (const line of readFileSync(join(HISTORY_DIR, f), 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try { allEntries.push(JSON.parse(line)); } catch {}
  }
}
allEntries.sort((a, b) => a.timestamp - b.timestamp);

// Find all entries related to this URL/slug
const related = allEntries.filter(e =>
  e.url === url ||
  e.slug === slug ||
  (e.action === 'list' && JSON.stringify(e).includes('122112')) ||
  (e.action === 'page_checkpoint' && e.url === url)
);

for (const e of related) {
  console.log(JSON.stringify(e));
}
