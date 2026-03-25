#!/usr/bin/env node
/**
 * migrate-current-file.mjs — Move deviceName from manifest/settings.json to
 * plaintext CURRENT file, rename `remotes` → `timestamps` in page entities,
 * and strip stale `update_setting key=deviceName` entries from JSONL history.
 *
 * Changes:
 * 1. Read deviceName from manifest/settings.json → write plaintext CURRENT file
 * 2. Remove deviceName from manifest/settings.json
 * 3. Rename `remotes` → `timestamps` in all pages/*.json
 * 4. Strip `update_setting key=deviceName` entries from all JSONL log files
 *
 * Idempotent: skips steps that are already done.
 *
 * Usage:
 *   node scripts/migrate-current-file.mjs              # dry run
 *   node scripts/migrate-current-file.mjs --apply      # apply changes
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const MANIFEST_DIR = join(DATA_DIR, 'manifest');
const PAGES_DIR = join(DATA_DIR, 'pages');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');
const SETTINGS_PATH = join(MANIFEST_DIR, 'settings.json');
const CURRENT_PATH = join(DATA_DIR, 'CURRENT');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// --- Step 1: Create CURRENT file from settings.deviceName ---

if (existsSync(CURRENT_PATH)) {
  const deviceId = readFileSync(CURRENT_PATH, 'utf-8').trim();
  console.log(`CURRENT already exists: "${deviceId}" — skipping CURRENT creation.`);
} else if (!existsSync(SETTINGS_PATH)) {
  console.log('No settings.json found — nothing to migrate.');
  process.exit(0);
} else {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  if (!settings.deviceName) {
    console.log('settings.json has no deviceName — nothing to migrate.');
    process.exit(0);
  }

  const deviceId = settings.deviceName;
  console.log(`Moving deviceName="${deviceId}" from settings.json to plaintext CURRENT`);

  // Write CURRENT as plaintext
  if (!dryRun) {
    writeFileSync(CURRENT_PATH, deviceId);
    console.log('  wrote CURRENT');
  } else {
    console.log('  would write CURRENT');
  }

  // Remove deviceName from settings
  const { deviceName: _, ...rest } = settings;
  if (!dryRun) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(rest));
    console.log('  removed deviceName from settings.json');
  } else {
    console.log('  would remove deviceName from settings.json');
  }
}

// --- Step 2: Rename remotes → timestamps in all pages/*.json ---

console.log('\n--- Renaming remotes → timestamps in page entities ---');

if (existsSync(PAGES_DIR)) {
  const pageFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.json'));
  let renamed = 0;

  for (const file of pageFiles) {
    const filePath = join(PAGES_DIR, file);
    const page = JSON.parse(readFileSync(filePath, 'utf-8'));

    if (!page.remotes) continue;

    page.timestamps = page.remotes;
    delete page.remotes;
    renamed++;

    if (!dryRun) {
      writeFileSync(filePath, JSON.stringify(page));
    }
    console.log(`  ${dryRun ? 'would rename' : 'renamed'} remotes → timestamps in ${file}`);
  }
  console.log(`${renamed} page files ${dryRun ? 'would be' : ''} updated.`);
} else {
  console.log('No pages/ directory — skipping.');
}

// --- Step 3: Strip update_setting key=deviceName from JSONL history ---

console.log('\n--- Stripping update_setting key=deviceName from JSONL logs ---');

if (existsSync(LOGS_DIR)) {
  const devices = readdirSync(LOGS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
  let strippedTotal = 0;

  for (const device of devices) {
    const deviceDir = join(LOGS_DIR, device.name);
    const logFiles = readdirSync(deviceDir).filter(f => f.endsWith('.jsonl'));

    for (const file of logFiles) {
      const filePath = join(deviceDir, file);
      const text = readFileSync(filePath, 'utf-8');
      const lines = text.split('\n');
      let stripped = 0;
      const kept = [];

      for (const line of lines) {
        if (!line.trim()) { kept.push(line); continue; }
        try {
          const entry = JSON.parse(line);
          if (entry.action === 'update_setting' && entry.key === 'deviceName') {
            stripped++;
            continue;
          }
        } catch {}
        kept.push(line);
      }

      if (stripped > 0) {
        strippedTotal += stripped;
        if (!dryRun) {
          writeFileSync(filePath, kept.join('\n'));
        }
        console.log(`  ${dryRun ? 'would strip' : 'stripped'} ${stripped} entries from ${device.name}/${file}`);
      }
    }
  }
  console.log(`${strippedTotal} entries ${dryRun ? 'would be' : ''} stripped total.`);
} else {
  console.log('No data/logs/ directory — skipping.');
}
