#!/usr/bin/env node
/**
 * Migration script: Unify Page References with typed keys.
 *
 * 1. Scan pages → build checkpointedSlugs set and urlToSlug map
 * 2. Transform page entities: parents → parentIds, children → childIds
 * 3. Transform note entities: parents → parentIds, children → childIds
 * 4. Transform list entities: pins[].url → pins[].id, remove pins[].title
 * 5. Transform JSONL history:
 *    - page entries: referrer → referrerId (page:<slug>)
 *    - list entries: urls → ids (page:<slug> or shallow:<url>)
 *    - note entries: parents → parentIds, children → childIds
 * 6. Rename+expand lists/index/parent.json → lists/system/shallow-page.json
 *
 * Usage: node scripts/migrate-shallow-refs.js <path-to-portal-data>
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node migrate-shallow-refs.js <path-to-portal-data>');
  process.exit(1);
}

const dataDir = path.resolve(args[0]);
if (!fs.existsSync(dataDir)) {
  console.error(`Directory not found: ${dataDir}`);
  process.exit(1);
}

console.log(`Migrating portal-data at: ${dataDir}`);
console.log('');

// ──────────────────────────────────────────────────────────────────────────
// Inline slug generation (from extension/utils.js)
// ──────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────
// Step 1: Scan pages → build checkpointedSlugs set and urlToSlug map
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 1: Scanning pages...');

const pagesDir = path.join(dataDir, 'pages');
const checkpointedSlugs = new Set();
const urlToSlug = new Map(); // url → slug

if (fs.existsSync(pagesDir)) {
  const pageFiles = fs.readdirSync(pagesDir).filter(f => f.endsWith('.json'));
  for (const file of pageFiles) {
    const slug = file.replace('.json', '');
    checkpointedSlugs.add(slug);
    try {
      const data = JSON.parse(fs.readFileSync(path.join(pagesDir, file), 'utf-8'));
      if (data.url) urlToSlug.set(data.url, slug);
    } catch (e) {
      console.warn(`  Warning: could not read ${file}: ${e.message}`);
    }
  }
  console.log(`  Found ${checkpointedSlugs.size} pages, ${urlToSlug.size} with URLs`);
} else {
  console.log('  No pages/ directory found');
}

// ──────────────────────────────────────────────────────────────────────────
// Step 2: Transform page entities: parents → parentIds, children → childIds
// ──────────────────────────────────────────────────────────────────────────

// Helper: convert a URL string to typed key
function urlToTypedRef(url) {
  const slug = urlToSlug.get(url) || generateSlugFromUrl(url);
  if (checkpointedSlugs.has(slug)) return 'page:' + slug;
  return 'shallow:' + url;
}

// Helper: convert a raw ref (string or {url,title} object) to typed key
function toTypedRef(ref) {
  if (typeof ref === 'object' && ref !== null && typeof ref.url === 'string') {
    return urlToTypedRef(ref.url);
  }
  if (typeof ref !== 'string') return null;
  if (ref.startsWith('page:') || ref.startsWith('note:') || ref.startsWith('shallow:')) return ref;
  try {
    new URL(ref);
    return urlToTypedRef(ref);
  } catch {
    if (checkpointedSlugs.has(ref)) return 'page:' + ref;
    return ref;
  }
}

console.log('Step 2: Transforming page entities...');

if (fs.existsSync(pagesDir)) {
  let updatedCount = 0;
  const pageFiles = fs.readdirSync(pagesDir).filter(f => f.endsWith('.json'));
  for (const file of pageFiles) {
    const filePath = path.join(pagesDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      let changed = false;
      if (data.parents !== undefined && data.parentIds === undefined) {
        data.parentIds = data.parents;
        delete data.parents;
        changed = true;
      }
      if (data.children !== undefined && data.childIds === undefined) {
        data.childIds = data.children;
        delete data.children;
        changed = true;
      }
      // Convert raw URLs/slugs/{url,title} objects in parentIds/childIds to typed refs
      for (const field of ['parentIds', 'childIds']) {
        if (!Array.isArray(data[field])) continue;
        const converted = [];
        for (const ref of data[field]) {
          const typed = toTypedRef(ref);
          if (typed === null) { changed = true; continue; }
          if (typed !== ref) changed = true;
          converted.push(typed);
        }
        data[field] = converted;
      }
      if (changed) {
        fs.writeFileSync(filePath, JSON.stringify(data));
        updatedCount++;
      }
    } catch (e) {
      console.warn(`  Warning: could not process ${file}: ${e.message}`);
    }
  }
  console.log(`  Updated ${updatedCount}/${pageFiles.length} page files`);
} else {
  console.log('  No pages/ directory found');
}

// ──────────────────────────────────────────────────────────────────────────
// Step 3: Transform note entities: parents → parentIds, children → childIds
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 3: Transforming note entities...');

const notesDir = path.join(dataDir, 'notes');
if (fs.existsSync(notesDir)) {
  let updatedCount = 0;
  const noteFiles = fs.readdirSync(notesDir).filter(f => f.endsWith('.json'));
  for (const file of noteFiles) {
    const filePath = path.join(notesDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      let changed = false;
      if (data.parents !== undefined && data.parentIds === undefined) {
        data.parentIds = data.parents;
        delete data.parents;
        changed = true;
      }
      if (data.children !== undefined && data.childIds === undefined) {
        data.childIds = data.children;
        delete data.children;
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(filePath, JSON.stringify(data));
        updatedCount++;
      }
    } catch (e) {
      console.warn(`  Warning: could not process ${file}: ${e.message}`);
    }
  }
  console.log(`  Updated ${updatedCount}/${noteFiles.length} note files`);
} else {
  console.log('  No notes/ directory found');
}

// ──────────────────────────────────────────────────────────────────────────
// Step 4: Transform list entities: pins[].url → pins[].id
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 4: Transforming list pin entities...');

const listsDir = path.join(dataDir, 'lists');
if (fs.existsSync(listsDir)) {
  let updatedCount = 0;
  const listFiles = fs.readdirSync(listsDir).filter(f => f.endsWith('.json'));
  for (const file of listFiles) {
    const filePath = path.join(listsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!Array.isArray(data.pins)) continue;

      let changed = false;
      for (let i = 0; i < data.pins.length; i++) {
        const pin = data.pins[i];
        if (pin.url !== undefined && pin.id === undefined) {
          // Convert url → typed id
          const slug = urlToSlug.get(pin.url) || generateSlugFromUrl(pin.url);
          const isCheckpointed = checkpointedSlugs.has(slug);
          pin.id = isCheckpointed ? `page:${slug}` : `shallow:${pin.url}`;
          delete pin.url;
          delete pin.title;
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(filePath, JSON.stringify(data));
        updatedCount++;
      }
    } catch (e) {
      console.warn(`  Warning: could not process ${file}: ${e.message}`);
    }
  }

  // Also process lists in subdirectories (user/, system/explore.json)
  for (const subdir of ['user', 'system']) {
    const subdirPath = path.join(listsDir, subdir);
    if (!fs.existsSync(subdirPath)) continue;
    const subFiles = fs.readdirSync(subdirPath).filter(f => f.endsWith('.json'));
    for (const file of subFiles) {
      // Skip non-pin files
      if (file === 'gateways.json' || file === 'recycle-bin.json' || file === 'permanent-deletes.json') continue;
      const filePath = path.join(subdirPath, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!Array.isArray(data.pins)) continue;

        let changed = false;
        for (const pin of data.pins) {
          if (pin.url !== undefined && pin.id === undefined) {
            const slug = urlToSlug.get(pin.url) || generateSlugFromUrl(pin.url);
            const isCheckpointed = checkpointedSlugs.has(slug);
            pin.id = isCheckpointed ? `page:${slug}` : `shallow:${pin.url}`;
            delete pin.url;
            delete pin.title;
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(filePath, JSON.stringify(data));
          updatedCount++;
        }
      } catch (e) {
        console.warn(`  Warning: could not process ${subdir}/${file}: ${e.message}`);
      }
    }
  }
  console.log(`  Updated ${updatedCount} list files`);
} else {
  console.log('  No lists/ directory found');
}

// ──────────────────────────────────────────────────────────────────────────
// Step 5: Transform JSONL history entries
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 5: Transforming JSONL history...');

const historyDir = path.join(dataDir, 'history');
// Collect title data for shallow_page index (step 6)
const urlTitles = new Map(); // url → { title, user_title, timestamp }

if (fs.existsSync(historyDir)) {
  let totalEntries = 0;
  let modifiedEntries = 0;
  const jsonlFiles = fs.readdirSync(historyDir).filter(f => f.endsWith('.jsonl'));

  for (const file of jsonlFiles) {
    const filePath = path.join(historyDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let fileChanged = false;
    const newLines = [];

    for (const line of lines) {
      if (!line.trim()) { newLines.push(line); continue; }
      totalEntries++;
      try {
        const entry = JSON.parse(line);
        let changed = false;

        if (entry.action === 'page') {
          // Track titles for shallow_page index
          if (entry.url && entry.title) {
            const prev = urlTitles.get(entry.url);
            if (!prev || entry.timestamp > prev.timestamp) {
              urlTitles.set(entry.url, {
                title: entry.title,
                user_title: entry.user_title || null,
                timestamp: entry.timestamp,
              });
            }
          }

          // referrer → referrerId
          if (entry.referrer !== undefined && entry.referrerId === undefined) {
            const refSlug = urlToSlug.get(entry.referrer) || generateSlugFromUrl(entry.referrer);
            entry.referrerId = `page:${refSlug}`;
            delete entry.referrer;
            changed = true;
          }
        }

        if (entry.action === 'list') {
          // urls → ids
          if (entry.urls !== undefined && entry.ids === undefined) {
            entry.ids = entry.urls.map(url => {
              const slug = urlToSlug.get(url) || generateSlugFromUrl(url);
              return checkpointedSlugs.has(slug) ? `page:${slug}` : `shallow:${url}`;
            });
            delete entry.urls;
            changed = true;
          }
        }

        if (entry.action === 'note') {
          // parents → parentIds
          if (entry.parents !== undefined && entry.parentIds === undefined) {
            entry.parentIds = entry.parents;
            delete entry.parents;
            changed = true;
          }
          // children → childIds
          if (entry.children !== undefined && entry.childIds === undefined) {
            entry.childIds = entry.children;
            delete entry.children;
            changed = true;
          }
        }

        if (changed) {
          modifiedEntries++;
          fileChanged = true;
          newLines.push(JSON.stringify(entry));
        } else {
          newLines.push(line);
        }
      } catch {
        newLines.push(line); // Preserve unparseable lines
      }
    }

    if (fileChanged) {
      fs.writeFileSync(filePath, newLines.join('\n'));
    }
  }
  console.log(`  Processed ${totalEntries} entries across ${jsonlFiles.length} files, modified ${modifiedEntries}`);
} else {
  console.log('  No history/ directory found');
}

// ──────────────────────────────────────────────────────────────────────────
// Step 6: Rename+expand parent.json → shallow_page.json
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 6: Expanding parent index → shallow-page index...');

const indexDir = path.join(listsDir, 'index');
const systemDir = path.join(listsDir, 'system');
const parentJsonPath = path.join(indexDir, 'parent.json');
const shallowPagePath = path.join(systemDir, 'shallow-page.json');

if (fs.existsSync(parentJsonPath)) {
  try {
    const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
    const oldIndex = parentData.index || {};

    // Build list membership for shallow URLs by scanning list pin files
    const urlToLists = new Map(); // url → Set of list: ids
    if (fs.existsSync(listsDir)) {
      for (const file of fs.readdirSync(listsDir).filter(f => f.endsWith('.json'))) {
        const listId = file.replace('.json', '');
        try {
          const listData = JSON.parse(fs.readFileSync(path.join(listsDir, file), 'utf-8'));
          if (!Array.isArray(listData.pins)) continue;
          for (const pin of listData.pins) {
            if (pin.id && pin.id.startsWith('shallow:')) {
              const url = pin.id.slice(8);
              if (!urlToLists.has(url)) urlToLists.set(url, new Set());
              urlToLists.get(url).add(`list:${listId}`);
            }
          }
        } catch {}
      }
      // Also check subdirectories
      for (const subdir of ['user']) {
        const subdirPath = path.join(listsDir, subdir);
        if (!fs.existsSync(subdirPath)) continue;
        for (const file of fs.readdirSync(subdirPath).filter(f => f.endsWith('.json'))) {
          const listId = file.replace('.json', '');
          try {
            const listData = JSON.parse(fs.readFileSync(path.join(subdirPath, file), 'utf-8'));
            if (!Array.isArray(listData.pins)) continue;
            for (const pin of listData.pins) {
              if (pin.id && pin.id.startsWith('shallow:')) {
                const url = pin.id.slice(8);
                if (!urlToLists.has(url)) urlToLists.set(url, new Set());
                urlToLists.get(url).add(`list:${listId}`);
              }
            }
          } catch {}
        }
      }
    }

    // Convert old format: { url: [parentSlugs] } → { url: { parents, lists, title, user_title } }
    const newIndex = {};
    let prunedCount = 0;

    for (const [url, parentSlugs] of Object.entries(oldIndex)) {
      // Prune entries for checkpointed pages (they store their own parent info)
      const slug = urlToSlug.get(url) || generateSlugFromUrl(url);
      if (checkpointedSlugs.has(slug)) {
        prunedCount++;
        continue;
      }

      const parents = (Array.isArray(parentSlugs) ? parentSlugs : []).map(ps =>
        ps.startsWith('page:') ? ps : `page:${ps}`
      );
      const lists = urlToLists.has(url) ? [...urlToLists.get(url)] : [];
      const titleInfo = urlTitles.get(url);
      newIndex[url] = {
        parents,
        lists,
        title: titleInfo?.title || null,
        user_title: titleInfo?.user_title || null,
      };
    }

    const shallowPageData = {
      timestamp: parentData.timestamp || 0,
      index: newIndex,
    };

    if (!fs.existsSync(systemDir)) fs.mkdirSync(systemDir, { recursive: true });
    fs.writeFileSync(shallowPagePath, JSON.stringify(shallowPageData));
    console.log(`  Converted ${Object.keys(oldIndex).length} entries → ${Object.keys(newIndex).length} (pruned ${prunedCount} checkpointed)`);

    // Remove old parent.json
    fs.unlinkSync(parentJsonPath);
    console.log('  Removed old parent.json');
  } catch (e) {
    console.error(`  Error processing parent index: ${e.message}`);
  }
} else if (fs.existsSync(shallowPagePath)) {
  console.log('  shallow-page.json already exists, skipping');
} else {
  console.log('  No parent.json found, creating empty shallow-page.json');
  if (fs.existsSync(systemDir)) {
    fs.writeFileSync(shallowPagePath, JSON.stringify({ timestamp: 0, index: {} }));
  }
}

console.log('');
console.log('Migration complete!');
