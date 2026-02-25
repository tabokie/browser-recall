#!/usr/bin/env node
/**
 * Fix script: Convert raw URLs and {url,title} objects in page
 * childIds/parentIds to typed refs, and backfill shallow-page.json.
 *
 * Usage: node scripts/fix-raw-refs.js <path-to-portal-data>
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node fix-raw-refs.js <path-to-portal-data>');
  process.exit(1);
}

const dataDir = path.resolve(args[0]);
if (!fs.existsSync(dataDir)) {
  console.error(`Directory not found: ${dataDir}`);
  process.exit(1);
}

// ── Inline slug generation ──

function generateSlug(text, hashInput) {
  if (!text || text.trim() === '') text = 'untitled';
  const base = text.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 30)
    .replace(/-+$/, '');
  let hash = 0;
  for (let i = 0; i < hashInput.length; i++) {
    hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
  }
  const hashStr = Math.abs(hash).toString(36);
  const slug = `${base}-${hashStr}`;
  return slug.substring(0, 80);
}

function generateSlugFromUrl(url) {
  try {
    const parsed = new URL(url);
    let domain = parsed.hostname.toLowerCase();
    if (domain.startsWith('www.')) domain = domain.slice(4);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot > 0) domain = domain.slice(0, lastDot);
    const text = domain + parsed.pathname;
    return generateSlug(text, url);
  } catch {
    return 'untitled';
  }
}

// ── Step 1: Build checkpointed slug set ──

const pagesDir = path.join(dataDir, 'pages');
const checkpointedSlugs = new Set();
const urlToSlug = new Map();

for (const f of fs.readdirSync(pagesDir).filter(f => f.endsWith('.json'))) {
  const slug = f.replace('.json', '');
  checkpointedSlugs.add(slug);
  try {
    const d = JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf-8'));
    if (d.url) urlToSlug.set(d.url, slug);
  } catch {}
}
console.log(`Checkpointed pages: ${checkpointedSlugs.size}, URL-mapped: ${urlToSlug.size}`);

// Helper: extract URL from a ref (string or {url, title} object)
function extractUrl(ref) {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && typeof ref.url === 'string') return ref.url;
  return null;
}

// Helper: convert a raw URL string to typed key
function urlToTypedRef(url) {
  const slug = urlToSlug.get(url) || generateSlugFromUrl(url);
  if (checkpointedSlugs.has(slug)) return 'page:' + slug;
  return 'shallow:' + url;
}

// Helper: normalize any ref (string, object, or already-typed) to a typed key
function toTypedRef(ref) {
  if (typeof ref === 'string') {
    if (ref.startsWith('page:') || ref.startsWith('note:') || ref.startsWith('shallow:')) return ref;
    // Raw URL or bare slug
    try {
      new URL(ref);
      return urlToTypedRef(ref);
    } catch {
      if (checkpointedSlugs.has(ref)) return 'page:' + ref;
      return ref;
    }
  }
  // Object {url, title}
  const url = extractUrl(ref);
  if (url) return urlToTypedRef(url);
  return null; // unrecognized format, will be filtered out
}

// ── Step 2: Fix pages ──

console.log('\nFixing page entities...');
let fixedPages = 0;
const allShallowRefs = new Set();
// Collect titles from object refs for shallow-page backfill
const shallowTitles = new Map(); // url → title

for (const f of fs.readdirSync(pagesDir).filter(f => f.endsWith('.json'))) {
  const filePath = path.join(pagesDir, f);
  try {
    const d = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    let changed = false;

    for (const field of ['parentIds', 'childIds']) {
      if (!Array.isArray(d[field])) continue;
      const converted = [];
      for (const ref of d[field]) {
        const typed = toTypedRef(ref);
        if (typed === null) {
          changed = true; // dropping unrecognized entry
          continue;
        }
        if (typed !== ref) changed = true;
        converted.push(typed);
      }
      d[field] = converted;
    }

    // Collect shallow refs and titles from original object refs
    for (const field of ['parentIds', 'childIds']) {
      if (!Array.isArray(d[field])) continue;
      for (const ref of d[field]) {
        if (typeof ref === 'string' && ref.startsWith('shallow:')) {
          allShallowRefs.add(ref.slice(8));
        }
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, JSON.stringify(d));
      fixedPages++;
    }
  } catch (e) {
    console.warn(`  Warning: ${f}: ${e.message}`);
  }
}
console.log(`Fixed ${fixedPages} page files`);

// Re-scan to collect all shallow refs (including from already-correct files)
for (const f of fs.readdirSync(pagesDir).filter(f => f.endsWith('.json'))) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf-8'));
    for (const field of ['parentIds', 'childIds']) {
      if (!Array.isArray(d[field])) continue;
      for (const ref of d[field]) {
        if (typeof ref === 'string' && ref.startsWith('shallow:')) {
          allShallowRefs.add(ref.slice(8));
        }
      }
    }
  } catch {}
}

// ── Step 3: Collect shallow refs from lists ──

const listsDir = path.join(dataDir, 'lists');
function scanListPins(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) { scanListPins(fp); continue; }
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (!Array.isArray(d.pins)) return;
      for (const pin of d.pins) {
        if (pin.id && typeof pin.id === 'string' && pin.id.startsWith('shallow:')) {
          allShallowRefs.add(pin.id.slice(8));
        }
      }
    } catch {}
  }
}
scanListPins(listsDir);
console.log(`\nTotal shallow refs across all entities: ${allShallowRefs.size}`);

// ── Step 4: Backfill shallow-page.json ──

const spPath = path.join(listsDir, 'system', 'shallow-page.json');
const spData = JSON.parse(fs.readFileSync(spPath, 'utf-8'));
let added = 0;

// Build parent map: which pages have this URL as a shallow child?
const parentMap = new Map();
for (const f of fs.readdirSync(pagesDir).filter(f => f.endsWith('.json'))) {
  const slug = f.replace('.json', '');
  try {
    const d = JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf-8'));
    if (!Array.isArray(d.childIds)) continue;
    for (const ref of d.childIds) {
      if (typeof ref === 'string' && ref.startsWith('shallow:')) {
        const url = ref.slice(8);
        if (!parentMap.has(url)) parentMap.set(url, new Set());
        parentMap.get(url).add('page:' + slug);
      }
    }
  } catch {}
}

// Build list membership map
const urlToLists = new Map();
function scanListMembership(dir, prefix) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) { scanListMembership(fp, prefix + f + '/'); continue; }
    if (!f.endsWith('.json')) continue;
    const listId = prefix + f.replace('.json', '');
    if (listId.startsWith('system/') || listId.startsWith('index/')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (!Array.isArray(d.pins)) return;
      for (const pin of d.pins) {
        if (pin.id && typeof pin.id === 'string' && pin.id.startsWith('shallow:')) {
          const url = pin.id.slice(8);
          if (!urlToLists.has(url)) urlToLists.set(url, new Set());
          urlToLists.get(url).add('list:' + listId);
        }
      }
    } catch {}
  }
}
scanListMembership(listsDir, '');

// Scan JSONL for titles of shallow URLs
const histDir = path.join(dataDir, 'history');
const urlTitleMap = new Map();
if (fs.existsSync(histDir)) {
  for (const f of fs.readdirSync(histDir).filter(f => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(histDir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.action !== 'page' || !e.url || !allShallowRefs.has(e.url)) continue;
        if (!e.title) continue;
        const prev = urlTitleMap.get(e.url);
        if (!prev || e.timestamp > prev.timestamp) {
          urlTitleMap.set(e.url, { title: e.title, user_title: e.user_title || null, timestamp: e.timestamp });
        }
      } catch {}
    }
  }
}

for (const url of allShallowRefs) {
  if (!spData.index[url]) {
    const parents = parentMap.has(url) ? [...parentMap.get(url)] : [];
    const lists = urlToLists.has(url) ? [...urlToLists.get(url)] : [];
    const titleInfo = urlTitleMap.get(url);
    spData.index[url] = {
      parents,
      lists,
      title: titleInfo?.title || null,
      user_title: titleInfo?.user_title || null,
    };
    added++;
  } else {
    // Backfill parents and lists for existing entries
    const entry = spData.index[url];
    if (parentMap.has(url)) {
      for (const pk of parentMap.get(url)) {
        if (!entry.parents.includes(pk)) entry.parents.push(pk);
      }
    }
    if (urlToLists.has(url)) {
      for (const lk of urlToLists.get(url)) {
        if (!entry.lists.includes(lk)) entry.lists.push(lk);
      }
    }
    // Backfill title if missing
    if (entry.title === null && urlTitleMap.has(url)) {
      entry.title = urlTitleMap.get(url).title;
      entry.user_title = urlTitleMap.get(url).user_title;
    }
  }
}

fs.writeFileSync(spPath, JSON.stringify(spData));
console.log(`Added ${added} new entries to shallow-page.json`);
console.log(`Total entries now: ${Object.keys(spData.index).length}`);

// ── Verify ──

console.log('\n=== VERIFICATION ===');
let remaining = 0;
for (const f of fs.readdirSync(pagesDir).filter(f => f.endsWith('.json'))) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(pagesDir, f), 'utf-8'));
    for (const field of ['parentIds', 'childIds']) {
      if (!Array.isArray(d[field])) continue;
      for (const ref of d[field]) {
        if (typeof ref !== 'string') {
          remaining++;
          if (remaining <= 5) console.log(`  NON-STRING: ${f} ${field}: ${JSON.stringify(ref)}`);
        } else if (!ref.startsWith('page:') && !ref.startsWith('note:') && !ref.startsWith('shallow:')) {
          remaining++;
          if (remaining <= 5) console.log(`  RAW: ${f} ${field}: ${ref}`);
        }
      }
    }
  } catch {}
}

let spMissing = 0;
const finalSP = JSON.parse(fs.readFileSync(spPath, 'utf-8'));
for (const url of allShallowRefs) {
  if (!finalSP.index[url]) spMissing++;
}

console.log(`Remaining issues in pages: ${remaining}`);
console.log(`Missing from shallow-page.json: ${spMissing}`);
