#!/usr/bin/env node
/**
 * Migration: Selective Checkpoints + Parents/Children
 *
 * Prunes atom files that don't meet checkpoint criteria, adds `visitDates`,
 * converts `referrers` → `parents` (slugs), builds `children` arrays,
 * creates `lists/index/parent-index.json` for non-checkpointed pages,
 * and deletes the old `lists/index/referrer-index.json`.
 *
 * Run on ~/portal-data before deploying the new extension.
 *
 * Checkpoint criteria (keep if ANY met):
 *   (a) Has highlights, mdPath, or htmlPath (rich data)
 *   (b) Visited on 2+ distinct days
 *   (c) Is a referrer with children (key in referrer-index with non-empty array)
 *
 * Usage: node scripts/migrate-selective-checkpoints.js [portal-data-path]
 */
import { readFileSync, readdirSync, unlinkSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const dataDir = resolve(process.argv[2] || join(process.env.HOME, 'portal-data'));
const atomsDir = join(dataDir, 'atoms');
const historyDir = join(dataDir, 'history');
const listsDir = join(dataDir, 'lists');
const indexDir = join(listsDir, 'index');

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

// --- Load referrer index ---
let referrerIndex = {};
const oldRefPath = join(indexDir, 'referrer-index.json');
const legacyRefPath = join(listsDir, 'referrer-index.json');
try {
  const refPath = existsSync(oldRefPath) ? oldRefPath : legacyRefPath;
  if (existsSync(refPath)) {
    const data = JSON.parse(readFileSync(refPath, 'utf8'));
    referrerIndex = data.index || data;
  }
} catch (e) {
  console.warn('Could not load referrer-index.json:', e.message);
}

// Build set of referrer slugs (slugs that have children)
const referrerSlugs = new Set();
for (const refUrl of Object.keys(referrerIndex)) {
  if (referrerIndex[refUrl] && referrerIndex[refUrl].length > 0) {
    referrerSlugs.add(generateSlugFromUrl(refUrl));
  }
}

// --- Scan JSONL history to build visit dates per slug + referrer data ---
console.log('Scanning JSONL history files...');
const visitDatesBySlug = new Map(); // slug → Set<YYYYMMDD>
const titleByUrl = new Map(); // url → title (last seen)
// Track referrer relationships from JSONL (source of truth)
const referrersByChildUrl = new Map(); // child URL → Set<parent URLs>
const childrenByParentUrl = new Map(); // parent URL → Set<child URLs>

if (existsSync(historyDir)) {
  const jsonlFiles = readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort();
  for (const file of jsonlFiles) {
    const text = readFileSync(join(historyDir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.url) titleByUrl.set(entry.url, entry.title || '');
        if (!entry.slug || entry.action) continue; // only visit entries
        if (!visitDatesBySlug.has(entry.slug)) visitDatesBySlug.set(entry.slug, new Set());
        const d = new Date(entry.timestamp);
        const yyyymmdd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
        visitDatesBySlug.get(entry.slug).add(yyyymmdd);
        // Track referrer relationships (source of truth for parents/children)
        if (entry.referrer) {
          if (!referrersByChildUrl.has(entry.url)) referrersByChildUrl.set(entry.url, new Set());
          referrersByChildUrl.get(entry.url).add(entry.referrer);
          if (!childrenByParentUrl.has(entry.referrer)) childrenByParentUrl.set(entry.referrer, new Set());
          childrenByParentUrl.get(entry.referrer).add(entry.url);
        }
      } catch { /* skip malformed */ }
    }
  }
}
console.log(`Found visit data for ${visitDatesBySlug.size} slugs`);

// --- Process atom files ---
if (!existsSync(atomsDir)) {
  console.log('No atoms directory found, nothing to migrate.');
  process.exit(0);
}

const atomFiles = readdirSync(atomsDir).filter(f => f.endsWith('.json'));
console.log(`Processing ${atomFiles.length} atom files...`);

let kept = 0;
let deleted = 0;
const keptSlugs = new Set(); // track which slugs survive for referrer resolution

// First pass: determine which to keep
for (const file of atomFiles) {
  const slug = file.replace('.json', '');
  const atomPath = join(atomsDir, file);
  let atom;
  try {
    atom = JSON.parse(readFileSync(atomPath, 'utf8'));
  } catch {
    console.warn(`  Skipping malformed: ${file}`);
    continue;
  }

  const visitDates = visitDatesBySlug.get(slug);
  const visitDatesArray = visitDates ? [...visitDates].sort() : [];

  // Criterion (a): rich data
  const hasRichData = (atom.highlights && atom.highlights.length > 0) || atom.mdPath || atom.htmlPath;

  // Criterion (b): multi-day visits
  const isMultiDay = visitDatesArray.length >= 2;

  // Criterion (c): is a referrer with children
  const isReferrer = referrerSlugs.has(slug);

  if (hasRichData || isMultiDay || isReferrer) {
    keptSlugs.add(slug);
  }
}

// Scan for capture directories (atoms/{slug}/ with .md or .html files)
// These indicate rich data even if the atom JSON is missing or lacks mdPath/htmlPath
const captureOrphans = []; // slugs with capture dirs but no atom JSON
for (const entry of readdirSync(atomsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const slug = entry.name;
  if (keptSlugs.has(slug)) continue;
  const dirPath = join(atomsDir, slug);
  const hasSnapshots = readdirSync(dirPath).some(f => f.endsWith('.md') || f.endsWith('.html'));
  if (hasSnapshots) {
    keptSlugs.add(slug);
    if (!atomFiles.includes(slug + '.json')) {
      captureOrphans.push(slug);
    }
  }
}
if (captureOrphans.length > 0) {
  console.log(`Found ${captureOrphans.length} capture orphans (snapshot dir but no atom JSON)`);
}

// Build parents/children from JSONL referrer data (source of truth, not atom.referrers)
// Mixed format: slug for checkpointed refs, {url, title} for non-checkpointed
const parentsBySlug = new Map(); // slug → [slug | {url, title}]
const childrenBySlug = new Map(); // slug → [slug | {url, title}]

for (const [childUrl, parentUrls] of referrersByChildUrl) {
  const childSlug = generateSlugFromUrl(childUrl);
  if (!keptSlugs.has(childSlug)) continue;
  if (!parentsBySlug.has(childSlug)) parentsBySlug.set(childSlug, []);
  const parents = parentsBySlug.get(childSlug);
  for (const parentUrl of parentUrls) {
    const parentSlug = generateSlugFromUrl(parentUrl);
    if (keptSlugs.has(parentSlug)) {
      if (!parents.includes(parentSlug)) parents.push(parentSlug);
    } else {
      if (!parents.some(p => typeof p === 'object' && p.url === parentUrl)) {
        parents.push({ url: parentUrl, title: titleByUrl.get(parentUrl) || '' });
      }
    }
  }
}

for (const [parentUrl, childUrls] of childrenByParentUrl) {
  const parentSlug = generateSlugFromUrl(parentUrl);
  if (!keptSlugs.has(parentSlug)) continue;
  if (!childrenBySlug.has(parentSlug)) childrenBySlug.set(parentSlug, []);
  const children = childrenBySlug.get(parentSlug);
  for (const childUrl of childUrls) {
    const childSlug = generateSlugFromUrl(childUrl);
    if (keptSlugs.has(childSlug)) {
      if (!children.includes(childSlug)) children.push(childSlug);
    } else {
      if (!children.some(c => typeof c === 'object' && c.url === childUrl)) {
        children.push({ url: childUrl, title: titleByUrl.get(childUrl) || '' });
      }
    }
  }
}

// Second pass: update kept atoms and delete others
for (const file of atomFiles) {
  const slug = file.replace('.json', '');
  const atomPath = join(atomsDir, file);

  if (!keptSlugs.has(slug)) {
    unlinkSync(atomPath);
    deleted++;
    continue;
  }

  let atom;
  try {
    atom = JSON.parse(readFileSync(atomPath, 'utf8'));
  } catch {
    continue;
  }

  // Add visitDates
  const visitDates = visitDatesBySlug.get(slug);
  atom.visitDates = visitDates ? [...visitDates].sort() : [];

  // Set parents/children from JSONL data (ignore atom.referrers — may be corrupted by old format resolution)
  atom.parents = parentsBySlug.get(slug) || [];
  atom.children = childrenBySlug.get(slug) || [];
  delete atom.referrers;

  writeFileSync(atomPath, JSON.stringify(atom, null, 2));
  kept++;
}

// Create atom JSONs for capture orphans (snapshot dir exists but no atom JSON)
for (const slug of captureOrphans) {
  // Find latest snapshot timestamp for mdPath/htmlPath
  const dirPath = join(atomsDir, slug);
  const snapFiles = readdirSync(dirPath).filter(f => f.endsWith('.md') || f.endsWith('.html'));
  let latestTs = 0;
  let hasMd = false, hasHtml = false;
  for (const f of snapFiles) {
    const match = f.match(/^(\d+)\.(md|html)$/);
    if (match) {
      const ts = parseInt(match[1], 10);
      if (ts > latestTs) latestTs = ts;
      if (match[2] === 'md') hasMd = true;
      if (match[2] === 'html') hasHtml = true;
    }
  }
  // Find URL/title from JSONL history
  let url = '', title = '';
  for (const [u, t] of titleByUrl) {
    if (generateSlugFromUrl(u) === slug) { url = u; title = t; break; }
  }
  const visitDates = visitDatesBySlug.get(slug);
  const atom = {
    slug, url, title,
    timestamp: latestTs,
    highlights: [],
    parents: parentsBySlug.get(slug) || [],
    children: childrenBySlug.get(slug) || [],
    visitDates: visitDates ? [...visitDates].sort() : [],
  };
  if (hasMd) atom.mdPath = `pages/${slug}/${latestTs}.md`;
  if (hasHtml) atom.htmlPath = `pages/${slug}/${latestTs}.html`;
  writeFileSync(join(atomsDir, slug + '.json'), JSON.stringify(atom, null, 2));
  kept++;
}

console.log(`Done: ${kept} atoms kept (${captureOrphans.length} restored from captures), ${deleted} atoms deleted`);

// --- Build parent-index.json for non-checkpointed pages ---
// Scan JSONL for visits with referrers where child slug was NOT checkpointed
const parentIndexData = { timestamp: 0, index: {} };

for (const [childUrl, parentUrls] of referrersByChildUrl) {
  const childSlug = generateSlugFromUrl(childUrl);
  if (keptSlugs.has(childSlug)) continue; // parents are in atom.parents
  const parentSlugs = [];
  for (const parentUrl of parentUrls) {
    const parentSlug = generateSlugFromUrl(parentUrl);
    if (!parentSlugs.includes(parentSlug)) parentSlugs.push(parentSlug);
  }
  if (parentSlugs.length > 0) {
    parentIndexData.index[childUrl] = parentSlugs;
    // Track max timestamp from JSONL (approximate — use current time)
  }
}

// Write parent-index.json
if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });
const parentIndexPath = join(indexDir, 'parent-index.json');
writeFileSync(parentIndexPath, JSON.stringify(parentIndexData, null, 2));
console.log(`Parent-index created: ${Object.keys(parentIndexData.index).length} non-checkpointed entries`);

// Delete old referrer-index.json
for (const refPath of [oldRefPath, legacyRefPath]) {
  if (existsSync(refPath)) {
    unlinkSync(refPath);
    console.log(`Deleted: ${refPath}`);
  }
}
