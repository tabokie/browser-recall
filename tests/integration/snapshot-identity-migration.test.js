import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  canonicalizePageUrl,
  generateSlugFromUrl,
} from '../../packages/core/page-identity.js';
import { validateSnapshotIdentity } from '../../packages/core/snapshot-html.js';
import { pageCheckpointPath, pageEntityFixture } from '../e2e/helpers.js';

const script = fileURLToPath(
  new URL('../../scripts/migrate-snapshot-identity.mjs', import.meta.url),
);

test('snapshot migration checks before writing, rejects invalid authority, and is idempotent', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'browser-recall-migration-'));
  const write = (file, bytes) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  const run = (...args) =>
    spawnSync(process.execPath, [script, '--data-dir', dataDir, ...args], {
      encoding: 'utf8',
    });
  const original =
    '<!doctype html><html><head><meta name="x-browser-recall-slug" content="obsolete"></head><body>Preserve this content.</body></html>';
  try {
    const snapshots = [
      'https://example.com/first?ordinary=kept',
      'https://www.example.com/second?_tracking=removed&ordinary=kept',
    ].map((input, index) => {
      const url = canonicalizePageUrl(input);
      const slug = generateSlugFromUrl(url);
      const stem = `${slug}-${1700000000000 + index}`;
      const shard = createHash('sha256').update(stem).digest('hex').slice(0, 2);
      const html = path.join(
        dataDir,
        'objects/snapshots',
        shard,
        `${stem}.html`,
      );
      const markdown = html.replace(/\.html$/, '.md');
      const checkpoint = path.join(dataDir, pageCheckpointPath(slug));
      const page = pageEntityFixture({ slug, url, title: 'Migration fixture' });
      write(checkpoint, JSON.stringify(page));
      write(html, original);
      write(markdown, 'Unchanged searchable text');
      return { slug, url, html, markdown, checkpoint, page };
    });
    const checked = run('--check');
    expect(checked.status, checked.stderr).toBe(1);
    expect(JSON.parse(checked.stdout)).toEqual({
      scanned: 2,
      current: 0,
      pending: 2,
      updated: 0,
    });
    snapshots.forEach(({ html }) =>
      expect(readFileSync(html, 'utf8')).toBe(original),
    );

    for (const invalidUrl of [
      'not a URL',
      'file:///tmp/snapshot.html',
      'https://example.com/different-slug',
    ]) {
      write(
        snapshots[1].checkpoint,
        JSON.stringify({ ...snapshots[1].page, url: invalidUrl }),
      );
      const rejected = run();
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('Snapshot page URL');
      snapshots.forEach(({ html }) =>
        expect(readFileSync(html, 'utf8')).toBe(original),
      );
    }
    write(snapshots[1].checkpoint, JSON.stringify(snapshots[1].page));
    const migrated = run();
    expect(migrated.status, migrated.stderr).toBe(0);
    expect(JSON.parse(migrated.stdout)).toEqual({
      scanned: 2,
      current: 0,
      pending: 2,
      updated: 2,
    });
    for (const { html, markdown, slug, url } of snapshots) {
      const content = readFileSync(html, 'utf8');
      expect(validateSnapshotIdentity(content, { slug, url })).toEqual({
        slug,
        url,
      });
      expect(content).toContain('<body>Preserve this content.</body>');
      expect(content).not.toContain('obsolete');
      expect(readFileSync(markdown, 'utf8')).toBe('Unchanged searchable text');
      expect(readdirSync(path.dirname(html)).sort()).toEqual(
        [path.basename(html), path.basename(markdown)].sort(),
      );
    }
    const modified = snapshots.map(({ html }) => statSync(html).mtimeMs);
    const repeated = run();
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual({
      scanned: 2,
      current: 2,
      pending: 0,
      updated: 0,
    });
    expect(snapshots.map(({ html }) => statSync(html).mtimeMs)).toEqual(
      modified,
    );
    expect(run('--check').status).toBe(0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
