import crypto from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  setSnapshotIdentity,
  validateSnapshotIdentity,
} from '../packages/core/snapshot-html.js';
import { generateSlugFromUrl } from '../packages/core/page-identity.js';

function shardFor(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 2);
}

function snapshotParts(filename) {
  const match = filename.match(/^(.+)-(\d{13})\.html$/);
  if (!match) {
    throw new Error(`Snapshot HTML filename is invalid: ${filename}`);
  }
  return { slug: match[1], timestamp: Number(match[2]) };
}

async function writeFileAtomically(filename, content, mode) {
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode });
    await chmod(temporary, mode);
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function migrateSnapshotIdentity({ dataDir, checkOnly = false }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new Error('Snapshot identity migration requires an absolute dataDir');
  }
  const snapshotsDir = path.join(dataDir, 'objects', 'snapshots');
  await access(snapshotsDir, constants.R_OK);

  const result = { scanned: 0, current: 0, pending: 0, updated: 0 };
  const shardEntries = await readdir(snapshotsDir, { withFileTypes: true });
  for (const shardEntry of shardEntries) {
    if (shardEntry.name === '.DS_Store') continue;
    if (!shardEntry.isDirectory()) {
      throw new Error(
        `Unexpected entry in snapshot object directory: ${shardEntry.name}`,
      );
    }
    if (!/^[0-9a-f]{2}$/.test(shardEntry.name)) {
      throw new Error(`Snapshot shard is invalid: ${shardEntry.name}`);
    }
    const shardDir = path.join(snapshotsDir, shardEntry.name);
    const snapshotEntries = await readdir(shardDir, { withFileTypes: true });
    for (const snapshotEntry of snapshotEntries) {
      if (!snapshotEntry.isFile() || !snapshotEntry.name.endsWith('.html')) {
        continue;
      }
      result.scanned += 1;
      const { slug, timestamp } = snapshotParts(snapshotEntry.name);
      const stem = `${slug}-${timestamp}`;
      if (shardFor(stem) !== shardEntry.name) {
        throw new Error(`Snapshot is stored in the wrong shard: ${stem}`);
      }

      const pagePath = path.join(
        dataDir,
        'views',
        'pages',
        shardFor(slug),
        `${slug}.json`,
      );
      const page = JSON.parse(await readFile(pagePath, 'utf8'));
      if (page.slug !== slug) {
        throw new Error(`Snapshot page identity does not match ${pagePath}`);
      }
      if (typeof page.url !== 'string' || !/^https?:\/\//.test(page.url)) {
        throw new Error(`Snapshot page URL is invalid in ${pagePath}`);
      }
      let expectedSlug;
      try {
        expectedSlug = generateSlugFromUrl(page.url);
      } catch (error) {
        throw new Error(
          `Snapshot page URL is invalid in ${pagePath}: ${error.message}`,
        );
      }
      if (expectedSlug !== slug) {
        throw new Error(
          `Snapshot page URL does not match ${pagePath}: expected ${expectedSlug}, found ${slug}`,
        );
      }
      const snapshotPath = path.join(shardDir, snapshotEntry.name);
      const html = await readFile(snapshotPath, 'utf8');
      let identityIsCanonical = false;
      try {
        validateSnapshotIdentity(html, { slug, url: page.url });
        identityIsCanonical = true;
      } catch {
        identityIsCanonical = false;
      }
      if (identityIsCanonical) {
        result.current += 1;
        continue;
      }
      const migrated = setSnapshotIdentity(html, { slug, url: page.url });
      validateSnapshotIdentity(migrated, { slug, url: page.url });
      result.pending += 1;
      if (checkOnly) continue;
      const fileStat = await stat(snapshotPath);
      await writeFileAtomically(snapshotPath, migrated, fileStat.mode);
      result.updated += 1;
    }
  }
  return result;
}

function parseCliArgs(argv) {
  let dataDir = null;
  let checkOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      checkOnly = true;
    } else if (argument === '--data-dir') {
      dataDir = argv[index + 1] || null;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!dataDir) throw new Error('--data-dir is required');
  return { dataDir: path.resolve(dataDir), checkOnly };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await migrateSnapshotIdentity(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (options.checkOnly && result.pending > 0) process.exitCode = 1;
}
