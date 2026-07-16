import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSlugFromUrl } from '../../packages/core/utils.js';

function shard(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 2);
}

function mkdirp(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  mkdirp(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  mkdirp(dirname(path));
  writeFileSync(path, value);
}

describe('browser data URL identity migration', () => {
  let tempRoot = null;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it('writes the one current replay shape with explicit nullable fields', () => {
    tempRoot = mkdtempSync(join(os.tmpdir(), 'browser-recall-migrate-'));
    const root = join(tempRoot, 'browser-data');
    const timestamp = 1_710_000_000_000;
    const entries = [
      { timestamp, action: 'visit_page', url: 'https://example.com' },
      { timestamp, action: 'leave_page', url: 'https://example.com' },
      {
        timestamp,
        action: 'pin_to_list',
        name: 'Reading',
        listOwner: 'device',
        urls: ['https://example.com'],
      },
      {
        timestamp,
        action: 'create_list',
        name: 'Reading',
        listOwner: 'device',
      },
      {
        timestamp,
        action: 'create_note',
        url: 'https://example.com',
        path: 'objects/notes/note.json',
      },
    ];
    const logPath = join(root, 'logs', 'device', '2026-07-15.jsonl');
    writeText(logPath, `${entries.map(JSON.stringify).join('\n')}\n`);

    execFileSync(
      process.execPath,
      ['scripts/migrate-browser-data-schema.mjs', '--root', root, '--apply'],
      { cwd: process.cwd(), stdio: 'pipe' },
    );

    const migrated = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(migrated).toEqual([
      { ...entries[0], title: null, referrerUrl: null },
      {
        ...entries[1],
        title: null,
        scrollDepth: null,
        timeOnPage: null,
      },
      { ...entries[2], titles: null, source: null },
      { ...entries[3], listId: null, parentListId: null },
      {
        ...entries[4],
        title: null,
        excerpt: null,
        note: null,
        cssPath: null,
      },
    ]);
  });

  it('normalizes highlight note excerpts and css paths to arrays', () => {
    tempRoot = mkdtempSync(join(os.tmpdir(), 'browser-recall-migrate-'));
    const root = join(tempRoot, 'browser-data');
    const url = 'https://example.com/highlight';
    const timestamp = 1_710_000_000_000;

    writeJson(join(root, 'objects', 'notes', 'note-a.json'), {
      slug: 'note-a',
      url,
      excerpt: 'first line\nsecond line',
      cssPath: 'body > main > pre',
      note: '',
    });
    writeJson(join(root, 'objects', 'notes', 'note-b.json'), {
      slug: 'note-b',
      url,
      excerpt: ['first block', 'second block'],
      note: '',
    });
    writeJson(join(root, 'objects', 'notes', 'page-note.json'), {
      slug: 'page-note',
      url,
      excerpt: null,
      cssPath: 'body',
      note: 'page note',
    });
    writeText(
      join(root, 'logs', 'device', '2026-06-07.jsonl'),
      `${JSON.stringify({
        timestamp,
        action: 'create_note',
        url,
        path: 'objects/notes/note-a.json',
        excerpt: 'first line\nsecond line',
        cssPath: 'body > main > pre',
        note: '',
      })}\n${JSON.stringify({
        timestamp: timestamp + 1,
        action: 'create_note',
        url,
        path: 'objects/notes/page-note.json',
        excerpt: null,
        cssPath: 'body',
        note: 'page note',
      })}\n`,
    );

    execFileSync('node', [
      'scripts/migrate-browser-data-schema.mjs',
      '--root',
      root,
      '--apply',
    ]);

    expect(
      JSON.parse(readFileSync(join(root, 'objects', 'notes', 'note-a.json'))),
    ).toMatchObject({
      excerpt: ['first line\nsecond line'],
      cssPath: ['body > main > pre'],
    });
    expect(
      JSON.parse(readFileSync(join(root, 'objects', 'notes', 'note-b.json'))),
    ).toMatchObject({
      excerpt: ['first block', 'second block'],
      cssPath: ['', ''],
    });
    expect(
      JSON.parse(
        readFileSync(join(root, 'objects', 'notes', 'page-note.json')),
      ),
    ).toMatchObject({
      excerpt: null,
      cssPath: null,
    });
    const logLines = readFileSync(
      join(root, 'logs', 'device', '2026-06-07.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logLines[0]).toMatchObject({
      excerpt: ['first line\nsecond line'],
      cssPath: ['body > main > pre'],
    });
    expect(logLines[1]).toMatchObject({
      excerpt: null,
      cssPath: null,
    });
  });

  it('canonicalizes underscore query params and moves snapshot sidecars', () => {
    tempRoot = mkdtempSync(join(os.tmpdir(), 'browser-recall-migrate-'));
    const root = join(tempRoot, 'browser-data');
    const url =
      'https://www.douban.com/people/49804423/status/8969603475/?_spm_id=NDk4MDQ0MjM&dt_dapp=1&_i=0303152dQy1M97,0303244dQy1M97';
    const canonicalUrl =
      'https://www.douban.com/people/49804423/status/8969603475/?dt_dapp=1';
    const oldSlug = 'douban-people-49804423-status-drv8pu';
    const newSlug = generateSlugFromUrl(url);
    const timestamp = 1_710_000_000_000;
    const oldStem = `${oldSlug}-${timestamp}`;
    const newStem = `${newSlug}-${timestamp}`;

    writeJson(join(root, 'views', 'pages', shard(oldSlug), `${oldSlug}.json`), {
      slug: oldSlug,
      url,
      title: 'Oberkampf的广播',
      childIds: [`snapshot:${oldStem}`],
      parentIds: ['list:douban'],
      timestamps: { device: timestamp },
    });
    writeJson(join(root, 'views', 'lists', 'douban.json'), {
      slug: 'douban',
      name: 'Douban',
      pins: [{ id: `page:${oldSlug}`, pinnedAt: timestamp }],
    });
    writeJson(join(root, 'views', 'manifest', 'replay-progress.json'), {
      device: timestamp,
    });
    writeText(
      join(root, 'objects', 'snapshots', shard(oldStem), `${oldStem}.html`),
      '<html>snapshot</html>',
    );
    writeJson(join(root, 'objects', 'notes', 'note-a.json'), {
      slug: 'note-a',
      url,
      note: 'saved note',
    });
    writeJson(join(root, 'manifest', 'orphaned.json'), {
      entries: [{ key: 'note:note-a', url }],
    });
    writeText(
      join(root, 'logs', 'device', '2024-03-09.jsonl'),
      `${JSON.stringify({
        timestamp,
        action: 'create_snapshot',
        url,
        path: `objects/snapshots/${shard(oldStem)}/${oldStem}`,
        title: 'Oberkampf的广播',
      })}\n`,
    );

    execFileSync(
      process.execPath,
      ['scripts/migrate-browser-data-schema.mjs', '--root', root, '--apply'],
      { cwd: process.cwd(), stdio: 'pipe' },
    );

    const migratedLog = JSON.parse(
      readFileSync(join(root, 'logs', 'device', '2024-03-09.jsonl'), 'utf8'),
    );
    expect(migratedLog.url).toBe(canonicalUrl);
    expect(migratedLog.path).toBe(
      `objects/snapshots/${shard(newStem)}/${newStem}`,
    );
    expect(
      existsSync(
        join(root, 'objects', 'snapshots', shard(newStem), `${newStem}.html`),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(root, 'objects', 'snapshots', shard(oldStem), `${oldStem}.html`),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(root, 'views', 'pages', shard(oldSlug), `${oldSlug}.json`),
      ),
    ).toBe(false);
    expect(existsSync(join(root, 'views', 'lists', 'douban.json'))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(join(root, 'objects', 'notes', 'note-a.json'), 'utf8'),
      ).url,
    ).toBe(canonicalUrl);
    expect(existsSync(join(root, 'views', 'manifest', 'orphaned.json'))).toBe(
      false,
    );
    expect(
      existsSync(join(root, 'views', 'manifest', 'replay-progress.json')),
    ).toBe(false);
  });

  it('does not leave replay progress when current-layout URL identity logs require rebuild', () => {
    tempRoot = mkdtempSync(join(os.tmpdir(), 'browser-recall-migrate-'));
    const root = join(tempRoot, 'browser-data');
    const url =
      'https://www.douban.com/people/49804423/status/8969603475/?_spm_id=x&dt_dapp=1&_i=a,b';
    const canonicalUrl =
      'https://www.douban.com/people/49804423/status/8969603475/?dt_dapp=1';
    const timestamp = 1_710_000_000_000;

    writeText(
      join(root, 'logs', 'device', '2024-03-09.jsonl'),
      `${JSON.stringify({
        timestamp,
        action: 'visit_page',
        url,
        title: 'Oberkampf的广播',
      })}\n`,
    );

    execFileSync(
      process.execPath,
      ['scripts/migrate-browser-data-schema.mjs', '--root', root, '--apply'],
      { cwd: process.cwd(), stdio: 'pipe' },
    );

    const migratedLog = JSON.parse(
      readFileSync(join(root, 'logs', 'device', '2024-03-09.jsonl'), 'utf8'),
    );
    expect(migratedLog.url).toBe(canonicalUrl);
    expect(
      existsSync(join(root, 'views', 'manifest', 'replay-progress.json')),
    ).toBe(false);
  });

  it('moves legacy snapshot sidecars copied from data snapshots to canonical stems', () => {
    tempRoot = mkdtempSync(join(os.tmpdir(), 'browser-recall-migrate-'));
    const root = join(tempRoot, 'browser-data');
    const url =
      'https://www.douban.com/people/49804423/status/8969603475/?_spm_id=x&dt_dapp=1&_i=a,b';
    const oldSlug = 'douban-people-49804423-status-drv8pu';
    const newSlug = generateSlugFromUrl(url);
    const timestamp = 1_710_000_000_000;
    const oldStem = `${oldSlug}-${timestamp}`;
    const newStem = `${newSlug}-${timestamp}`;

    writeText(
      join(root, 'data', 'logs', 'device', '2024-03-09.jsonl'),
      `${JSON.stringify({
        timestamp,
        action: 'create_snapshot',
        url,
        path: `snapshots/${oldStem}`,
        title: 'Oberkampf的广播',
      })}\n`,
    );
    writeText(
      join(root, 'data', 'snapshots', `${oldStem}.html`),
      '<html>legacy snapshot</html>',
    );
    writeText(
      join(root, 'data', 'snapshots', `${oldStem}.md`),
      '# legacy snapshot\n',
    );

    execFileSync(
      process.execPath,
      ['scripts/migrate-browser-data-schema.mjs', '--root', root, '--apply'],
      { cwd: process.cwd(), stdio: 'pipe' },
    );

    const migratedLog = JSON.parse(
      readFileSync(join(root, 'logs', 'device', '2024-03-09.jsonl'), 'utf8'),
    );
    expect(migratedLog.path).toBe(
      `objects/snapshots/${shard(newStem)}/${newStem}`,
    );
    for (const extension of ['.html', '.md']) {
      expect(
        existsSync(
          join(
            root,
            'objects',
            'snapshots',
            shard(newStem),
            `${newStem}${extension}`,
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            root,
            'objects',
            'snapshots',
            shard(oldStem),
            `${oldStem}${extension}`,
          ),
        ),
      ).toBe(false);
    }
  });

  it('rewrites permanent delete keys to canonical page and snapshot identities', () => {
    tempRoot = mkdtempSync(join(os.tmpdir(), 'browser-recall-migrate-'));
    const root = join(tempRoot, 'browser-data');
    const url =
      'https://www.douban.com/people/49804423/status/8969603475/?_spm_id=x&dt_dapp=1&_i=a,b';
    const canonicalUrl =
      'https://www.douban.com/people/49804423/status/8969603475/?dt_dapp=1';
    const oldSlug = 'douban-people-49804423-status-drv8pu';
    const newSlug = generateSlugFromUrl(url);
    const timestamp = 1_710_000_000_000;
    const oldStem = `${oldSlug}-${timestamp}`;
    const newStem = `${newSlug}-${timestamp}`;

    writeText(
      join(root, 'logs', 'device', '2024-03-09.jsonl'),
      [
        JSON.stringify({
          timestamp,
          action: 'create_snapshot',
          url,
          path: `objects/snapshots/${shard(oldStem)}/${oldStem}`,
          title: 'Oberkampf的广播',
        }),
        JSON.stringify({
          timestamp: timestamp + 1,
          action: 'permanent_delete',
          keys: [`page:${oldSlug}`, `snapshot:${oldStem}`],
        }),
      ].join('\n') + '\n',
    );

    execFileSync(
      process.execPath,
      ['scripts/migrate-browser-data-schema.mjs', '--root', root, '--apply'],
      { cwd: process.cwd(), stdio: 'pipe' },
    );

    const migratedEntries = readFileSync(
      join(root, 'logs', 'device', '2024-03-09.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(migratedEntries[0].url).toBe(canonicalUrl);
    expect(migratedEntries[0].path).toBe(
      `objects/snapshots/${shard(newStem)}/${newStem}`,
    );
    expect(migratedEntries[1].keys).toEqual([
      `page:${newSlug}`,
      `snapshot:${newStem}`,
    ]);
  });
});
