#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';

const SETTINGS_KEYS = new Set([
  'theme',
  'colorScheme',
  'historyFileBatch',
  'captureSnapshotVideo',
  'blacklistEnabled',
  'urlBlacklist',
  'titleCleanupEnabled',
  'titleTrimRules',
  'syncEnabled',
  'syncMethod',
  'syncRepoUrl',
  'syncRetentionDays',
]);

const args = process.argv.slice(2);
let root = join(os.homedir(), 'browser-data');
let apply = false;
let verbose = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--root') {
    root = args[++index];
  } else if (arg === '--apply') {
    apply = true;
  } else if (arg === '--dry-run') {
    apply = false;
  } else if (arg === '--verbose') {
    verbose = true;
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

const operations = [];
const writes = new Map();
const removals = new Set();

function shard(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 2);
}

function exists(path) {
  return existsSync(path);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walkFiles(path) {
  if (!exists(path)) return [];
  if (isFile(path)) return [path];
  const files = [];
  for (const name of readdirSync(path)) {
    if (name.startsWith('.')) continue;
    files.push(...walkFiles(join(path, name)));
  }
  return files;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function queueWrite(path, content, reason) {
  writes.set(path, content);
  operations.push({ type: 'write', path, reason });
}

function queueRemove(path, reason) {
  if (!exists(path)) return;
  removals.add(path);
  operations.push({ type: 'remove', path, reason });
}

function queueCopyFile(from, to, transform, reason) {
  const input = readFileSync(from, 'utf8');
  const output = transform ? transform(input, from) : input;
  queueWrite(
    to,
    output,
    `${reason}: ${relative(root, from)} -> ${relative(root, to)}`,
  );
}

function normalizeSettings(settings) {
  const source = { ...settings };
  if (source.titleTrimRules === undefined && source.trimRules !== undefined) {
    source.titleTrimRules = source.trimRules;
  }
  if (source.urlBlacklist === undefined && source.blacklist !== undefined) {
    source.urlBlacklist = source.blacklist;
  }

  const result = {};
  if (source.timestamps && typeof source.timestamps === 'object') {
    result.timestamps = source.timestamps;
  }
  for (const key of SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
}

function normalizeArtifactPath(path) {
  if (typeof path !== 'string') return path;
  if (path.startsWith('objects/notes/')) return path;
  if (path.startsWith('objects/snapshots/')) return path;
  if (path.startsWith('notes/')) return `objects/${path}`;
  if (path.startsWith('snapshots/')) {
    const stem = path.slice('snapshots/'.length);
    return `objects/snapshots/${shard(stem)}/${stem}`;
  }
  return path;
}

function normalizePinEntry(entry) {
  if (entry.action !== 'pin_to_list' && entry.action !== 'unpin_from_list') {
    return;
  }
  const rawUrls = Array.isArray(entry.urls)
    ? entry.urls
    : Array.isArray(entry.items)
      ? entry.items
      : [];
  if (Array.isArray(entry.items)) delete entry.items;
  const rawTitles = entry.titles;
  const urls = [];
  const titles = [];
  rawUrls.forEach((url, index) => {
    if (typeof url !== 'string') return;
    const normalizedUrl = normalizeArtifactPath(url);
    urls.push(normalizedUrl);
    if (entry.action === 'pin_to_list') {
      if (Array.isArray(rawTitles)) {
        titles.push(rawTitles[index] ?? null);
      } else if (rawTitles && typeof rawTitles === 'object') {
        titles.push(rawTitles[normalizedUrl] ?? rawTitles[url] ?? null);
      }
    }
  });
  entry.urls = urls;

  if (entry.action !== 'pin_to_list') {
    delete entry.titles;
    return;
  }
  if (
    Array.isArray(rawTitles) ||
    (rawTitles && typeof rawTitles === 'object')
  ) {
    entry.titles = titles;
  } else if (rawTitles !== undefined) {
    delete entry.titles;
  }
}

function normalizeRuleConfig(rule) {
  if (!rule || typeof rule !== 'object') return;
  const type = rule.type ?? rule.rule_type;
  if (type === 'keyword' && rule.config && typeof rule.config === 'object') {
    delete rule.config.fields;
    delete rule.config.caseSensitive;
    delete rule.config.case_sensitive;
  }
}

function normalizeListView(raw) {
  const list = JSON.parse(raw);
  if (Array.isArray(list.rules)) {
    for (const rule of list.rules) normalizeRuleConfig(rule);
  }
  return `${JSON.stringify(list, null, 2)}\n`;
}

function normalizeLogEntry(entry) {
  delete entry.checkpoint;
  delete entry.bodyPreview;
  normalizePinEntry(entry);
  if (entry.action === 'add_rule') {
    normalizeRuleConfig(entry.rule);
  }
  for (const key of ['path', 'oldPath']) {
    if (entry[key] !== undefined)
      entry[key] = normalizeArtifactPath(entry[key]);
  }
  return entry;
}

function shouldKeepLogEntry(entry) {
  if (entry.action === 'update_setting') return SETTINGS_KEYS.has(entry.key);
  if (entry.action === 'update_rule' && entry.key === 'fields') return false;
  return true;
}

function normalizeLogFile(raw, path) {
  return `${raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        const entry = normalizeLogEntry(JSON.parse(line));
        return shouldKeepLogEntry(entry) ? JSON.stringify(entry) : null;
      } catch (error) {
        throw new Error(`${path}:${index + 1}: ${error.message}`);
      }
    })
    .filter(Boolean)
    .join('\n')}\n`;
}

function collectReplayProgressFromLogs(logsRoot) {
  const progress = {};
  for (const file of walkFiles(logsRoot)) {
    if (extname(file) !== '.jsonl') continue;
    const device = relative(logsRoot, file).split('/')[0];
    for (const [index, line] of readFileSync(file, 'utf8')
      .split('\n')
      .entries()) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = normalizeLogEntry(JSON.parse(line));
      } catch (error) {
        throw new Error(`${file}:${index + 1}: ${error.message}`);
      }
      if (!shouldKeepLogEntry(entry) || typeof entry.timestamp !== 'number')
        continue;
      progress[device] = Math.max(
        progress[device] ?? Number.MIN_SAFE_INTEGER,
        entry.timestamp,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(progress).filter(
      ([, value]) => value !== Number.MIN_SAFE_INTEGER,
    ),
  );
}

function copyDirectoryFiles(
  fromDir,
  toDir,
  transformPath,
  transformContent,
  reason,
  filter = () => true,
) {
  for (const file of walkFiles(fromDir)) {
    const rel = relative(fromDir, file);
    if (!filter(rel)) continue;
    const to = join(toDir, transformPath ? transformPath(rel) : rel);
    queueCopyFile(file, to, transformContent, reason);
  }
}

function planMigration() {
  if (!exists(root)) {
    throw new Error(`Data root does not exist: ${root}`);
  }
  const migratesLegacyCheckpoints =
    exists(join(root, 'pages')) || exists(join(root, 'data', 'logs'));

  copyDirectoryFiles(
    join(root, 'pages'),
    join(root, 'views', 'pages'),
    (rel) => {
      const slug = rel.replace(/\.json$/, '');
      return join(shard(slug), `${slug}.json`);
    },
    null,
    'page checkpoint shard',
    (rel) => extname(rel) === '.json',
  );
  queueRemove(join(root, 'pages'), 'remove old page checkpoint directory');

  copyDirectoryFiles(
    join(root, 'lists'),
    join(root, 'views', 'lists'),
    null,
    normalizeListView,
    'list view move',
    (rel) => extname(rel) === '.json',
  );
  queueRemove(join(root, 'lists'), 'remove old list view directory');

  const oldSettings = join(root, 'manifest', 'settings.json');
  const newSettings = join(root, 'views', 'manifest', 'settings.json');
  if (exists(oldSettings)) {
    queueWrite(
      newSettings,
      `${JSON.stringify(normalizeSettings(readJson(oldSettings)), null, 2)}\n`,
      'settings allowlist and move to views/manifest',
    );
  } else if (exists(newSettings)) {
    queueWrite(
      newSettings,
      `${JSON.stringify(normalizeSettings(readJson(newSettings)), null, 2)}\n`,
      'settings allowlist in place',
    );
  }
  for (const file of walkFiles(join(root, 'manifest'))) {
    if (extname(file) !== '.json') continue;
    if (file === oldSettings) continue;
    const rel = relative(join(root, 'manifest'), file);
    if (migratesLegacyCheckpoints && rel === 'checkpoint-watermark.json') {
      continue;
    }
    const outputName =
      rel === 'checkpoint-watermark.json' ? 'replay-progress.json' : rel;
    queueCopyFile(
      file,
      join(root, 'views', 'manifest', outputName),
      null,
      'manifest view move',
    );
  }
  queueRemove(join(root, 'manifest'), 'remove old manifest directory');

  const oldReplayProgress = join(
    root,
    'views',
    'manifest',
    'checkpoint-watermark.json',
  );
  if (exists(oldReplayProgress)) {
    if (!migratesLegacyCheckpoints) {
      queueCopyFile(
        oldReplayProgress,
        join(root, 'views', 'manifest', 'replay-progress.json'),
        null,
        'replay progress manifest rename',
      );
    }
    queueRemove(oldReplayProgress, 'remove old replay progress filename');
  }

  copyDirectoryFiles(
    join(root, 'views', 'lists'),
    join(root, 'views', 'lists'),
    null,
    normalizeListView,
    'list rule schema rewrite in place',
    (rel) => extname(rel) === '.json',
  );

  copyDirectoryFiles(
    join(root, 'data', 'logs'),
    join(root, 'logs'),
    null,
    normalizeLogFile,
    'log schema rewrite and move',
    (rel) => extname(rel) === '.jsonl',
  );
  copyDirectoryFiles(
    join(root, 'logs'),
    join(root, 'logs'),
    null,
    normalizeLogFile,
    'log schema rewrite in place',
    (rel) => extname(rel) === '.jsonl',
  );

  if (!migratesLegacyCheckpoints) {
    const replayProgress = {
      ...collectReplayProgressFromLogs(join(root, 'logs')),
    };
    if (Object.keys(replayProgress).length > 0) {
      queueWrite(
        join(root, 'views', 'manifest', 'replay-progress.json'),
        `${JSON.stringify(replayProgress, null, 2)}\n`,
        'replay progress from rebuilt checkpoints',
      );
    }
  } else {
    queueRemove(
      join(root, 'views', 'manifest', 'replay-progress.json'),
      'remove unsafe replay progress until legacy checkpoints are rebuilt',
    );
  }

  copyDirectoryFiles(
    join(root, 'data', 'notes'),
    join(root, 'objects', 'notes'),
    null,
    null,
    'note object move',
    (rel) => extname(rel) === '.json',
  );

  copyDirectoryFiles(
    join(root, 'data', 'snapshots'),
    join(root, 'objects', 'snapshots'),
    (rel) => {
      const stem = rel.replace(/\.(html|md)$/, '');
      return join(shard(stem), rel);
    },
    null,
    'snapshot object shard',
    (rel) => extname(rel) === '.html' || extname(rel) === '.md',
  );

  queueRemove(join(root, 'data'), 'remove old data directory');
  queueRemove(join(root, 'deleted'), 'remove legacy deleted directory');
}

function printPlan() {
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} ${root}`);
  console.log(`${operations.length} operations`);
  const counts = new Map();
  for (const operation of operations) {
    const reasonGroup = operation.reason.split(':')[0];
    const key = `${operation.type}: ${reasonGroup}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [key, count] of counts) {
    console.log(`${String(count).padStart(5)}  ${key}`);
  }
  if (!verbose) {
    console.log('Pass --verbose to print every planned file operation.');
    return;
  }
  for (const operation of operations) {
    console.log(
      `${operation.type.padEnd(6)} ${relative(root, operation.path)}  ${operation.reason}`,
    );
  }
}

function applyPlan() {
  const backup = `${root}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  cpSync(root, backup, { recursive: true, verbatimSymlinks: true });
  console.log(`backup ${backup}`);

  for (const [path, content] of writes) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const removalList = [...removals].sort((a, b) => b.length - a.length);
  for (const path of removalList) {
    rmSync(path, { recursive: true, force: true });
  }
}

planMigration();
printPlan();
if (apply) applyPlan();
