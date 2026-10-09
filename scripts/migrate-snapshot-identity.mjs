import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  canonicalizePageUrl,
  generateSlugFromUrl,
} from '../packages/core/page-identity.js';
import {
  setSnapshotIdentity,
  validateSnapshotIdentity,
} from '../packages/core/snapshot-html.js';

const shardFor = (value) =>
  createHash('sha256').update(value).digest('hex').slice(0, 2);

export async function migrateSnapshotIdentity({ dataDir, checkOnly = false }) {
  if (typeof dataDir !== 'string' || !dataDir.trim())
    throw new Error('Snapshot migration requires an explicit data directory');
  const root = path.resolve(dataDir);
  if (!(await lstat(root)).isDirectory())
    throw new Error(`Snapshot data directory is not a directory: ${root}`);
  const folder = path.join(root, 'objects/snapshots');
  let shards;
  try {
    shards = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { scanned: 0, current: 0, pending: 0, updated: 0 };
  }
  const plans = [];
  const result = { scanned: 0, current: 0, pending: 0, updated: 0 };
  for (const shard of shards.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shard.name === '.DS_Store') continue;
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name))
      throw new Error(`Invalid snapshot shard: ${shard.name}`);
    const entries = await readdir(path.join(folder, shard.name), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store') continue;
      if (!entry.isFile())
        throw new Error(`Invalid snapshot file: ${entry.name}`);
      if (!entry.name.endsWith('.html')) continue;
      const match = /^(.*)-([0-9]+)\.html$/.exec(entry.name);
      if (
        !match ||
        !Number.isSafeInteger(Number(match[2])) ||
        Number(match[2]) < 1
      )
        throw new Error(`Invalid snapshot filename: ${entry.name}`);
      const slug = match[1];
      const stem = entry.name.slice(0, -5);
      if (shardFor(stem) !== shard.name)
        throw new Error(`Snapshot file is in the wrong shard: ${entry.name}`);
      const checkpoint = path.join(
        root,
        'views/pages',
        shardFor(slug),
        `${slug}.json`,
      );
      if (!(await lstat(checkpoint)).isFile())
        throw new Error(`Invalid snapshot page checkpoint: ${checkpoint}`);
      const pageBytes = await readFile(checkpoint, 'utf8');
      const page = JSON.parse(pageBytes);
      let url;
      try {
        url = canonicalizePageUrl(page.url);
      } catch (error) {
        throw new Error(`Snapshot page URL is invalid: ${entry.name}`, {
          cause: error,
        });
      }
      if (page.slug !== slug || generateSlugFromUrl(url) !== slug)
        throw new Error(
          `Snapshot page URL does not match the snapshot slug: ${entry.name}`,
        );
      if (page.url !== url)
        throw new Error(`Snapshot page URL is not canonical: ${entry.name}`);
      const file = path.join(folder, shard.name, entry.name);
      const original = await readFile(file, 'utf8');
      if (!original.trim())
        throw new Error(`Snapshot HTML is empty: ${entry.name}`);
      result.scanned += 1;
      try {
        validateSnapshotIdentity(original, { slug, url });
        result.current += 1;
      } catch {
        const html = setSnapshotIdentity(original, { slug, url });
        validateSnapshotIdentity(html, { slug, url });
        plans.push({ file, original, html, checkpoint, pageBytes });
        result.pending += 1;
      }
    }
  }
  // Validate the entire collection before changing any snapshot.
  if (!checkOnly) {
    for (const { file, original, html, checkpoint, pageBytes } of plans) {
      if (
        (await readFile(file, 'utf8')) !== original ||
        (await readFile(checkpoint, 'utf8')) !== pageBytes
      )
        throw new Error(`Snapshot changed during migration: ${file}`);
      const work = await mkdtemp(path.join(path.dirname(file), '.identity-'));
      try {
        const staged = path.join(work, path.basename(file));
        await writeFile(staged, html, { mode: (await lstat(file)).mode });
        await rename(staged, file);
        result.updated += 1;
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
  }
  return result;
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => null)) ===
    fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        'data-dir': { type: 'string' },
        check: { type: 'boolean', default: false },
      },
    });
    const result = await migrateSnapshotIdentity({
      dataDir: values['data-dir'],
      checkOnly: values.check,
    });
    console.log(JSON.stringify(result));
    if (values.check && result.pending) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
