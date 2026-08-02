import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { generateSlugFromUrl } from '../../packages/core/page-identity.js';
import {
  collectDaemonMessages as collectMessages,
  ensureTestDaemonBuilt,
  installTestControlWireAdapter,
  launchTestDaemon,
  nextDaemonMessage as nextMessage,
  stopTestDaemon as stopDaemon,
  waitForDaemonListening as waitForListening,
} from './daemon-test-harness.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const PORT_CANDIDATES = [28671, 28672, 28673];

function shardFor(value) {
  return createHash('sha256')
    .update(value)
    .digest()
    .subarray(0, 1)
    .toString('hex');
}

function notePath(root, slug) {
  return path.join(root, 'objects', 'notes', `${slug}.json`);
}

function snapshotPath(root, slug, timestamp, ext) {
  const stem = `${slug}-${timestamp}`;
  return path.join(
    root,
    'objects',
    'snapshots',
    shardFor(stem),
    `${stem}.${ext}`,
  );
}

function snapshotRelativePath(slug, timestamp) {
  const stem = `${slug}-${timestamp}`;
  return `objects/snapshots/${shardFor(stem)}/${stem}`;
}

function pagePath(root, slug) {
  return path.join(root, 'views', 'pages', shardFor(slug), `${slug}.json`);
}

function listPath(root, listId) {
  return path.join(root, 'views', 'lists', `${listId}.json`);
}

function manifestPath(root, name) {
  return path.join(root, 'views', 'manifest', name);
}

async function waitForFileContent(filePath, predicate = () => true) {
  const deadline = Date.now() + 2_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      if (predicate(raw)) return raw;
      lastError = new Error(`File content did not match: ${filePath}`);
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw lastError;
}

async function waitForMissing(filePath) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!existsSync(filePath)) return;
    await delay(20);
  }
  throw new Error(`Expected file to be removed: ${filePath}`);
}

async function waitForFirstLog(root) {
  const deadline = Date.now() + 2_000;
  let lastError;
  const logsDir = path.join(root, 'logs');
  while (Date.now() < deadline) {
    try {
      for (const deviceDir of readdirSync(logsDir)) {
        const devicePath = path.join(logsDir, deviceDir);
        for (const logFile of readdirSync(devicePath)) {
          return readFileSync(path.join(devicePath, logFile), 'utf8');
        }
      }
      lastError = new Error(`No log files under: ${logsDir}`);
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw lastError;
}

function launchDaemon(configDir, approveMode = 'allow') {
  return launchTestDaemon(configDir, {
    ports: PORT_CANDIDATES,
    approveMode,
    testControl: true,
  });
}

async function pairSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Origin: ORIGIN },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const pairingMessages = collectMessages(socket, 2);
  socket.send(
    JSON.stringify({
      type: 'pair_request',
      protocolVersion: 3,
      browserId: 'browser-install-1',
      browserName: 'Chrome',
      extensionId: 'abcdefghijklmnop',
      browserProfile: null,
    }),
  );
  const [, approved] = await pairingMessages;
  expect(approved.type).toBe('pair_approved');
  return installTestControlWireAdapter(socket);
}

describe.sequential('phase 2 daemon event flow integration', () => {
  let tempDirs = [];
  let childProcesses = [];

  beforeAll(() => ensureTestDaemonBuilt(), 300_000);

  afterEach(async () => {
    await Promise.all(
      childProcesses.splice(0).map((child) => stopDaemon(child)),
    );
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists streamed events and reports status', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-events-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000000,
          action: 'visit_page',
          url: 'https://example.com/streamed',
          title: 'Streamed',
          referrerUrl: null,
        },
      }),
    );
    const ack = await nextMessage(socket);
    expect(ack).toEqual({ type: 'ack' });

    socket.send(JSON.stringify({ type: 'get_status' }));
    const status = await nextMessage(socket);
    expect(status).toMatchObject({
      type: 'status',
      maxMessageBytes: 64 * 1024 * 1024,
      authority: { state: 'running' },
    });

    const logRaw = await waitForFirstLog(path.join(dir, 'browser-data'));
    expect(logRaw).toContain('"action":"visit_page"');
    expect(logRaw).toContain('"url":"https://example.com/streamed"');

    socket.close();
  });

  it('persists streamed snapshots as html plus log entry', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-snapshot-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        slug: 'example-streamed',
        ts: 1710000001000,
        url: 'https://example.com/streamed',
        title: 'Snapshot',
        markdown: 'streamed snapshot',
        html: '<html><body>streamed snapshot</body></html>',
      }),
    );
    const ack = await nextMessage(socket);
    expect(ack.type).toBe('ack');

    const dataRoot = path.join(dir, 'browser-data');
    const htmlPath = snapshotPath(
      dataRoot,
      'example-streamed',
      1710000001000,
      'html',
    );
    expect(readFileSync(htmlPath, 'utf8')).toContain('streamed snapshot');
    const markdownPath = snapshotPath(
      dataRoot,
      'example-streamed',
      1710000001000,
      'md',
    );
    expect(readFileSync(markdownPath, 'utf8')).toContain('streamed snapshot');

    const logsDir = path.join(dataRoot, 'logs');
    const [deviceDir] = await import('node:fs/promises').then((fs) =>
      fs.readdir(logsDir),
    );
    const logFiles = await import('node:fs/promises').then((fs) =>
      fs.readdir(path.join(logsDir, deviceDir)),
    );
    const logRaw = readFileSync(
      path.join(logsDir, deviceDir, logFiles[0]),
      'utf8',
    );
    expect(logRaw).toContain('"action":"create_snapshot"');

    socket.close();
  });

  it('serves note and snapshot search RPCs from ingested desktop data', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-search-rpcs-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000000,
          action: 'visit_page',
          url: 'https://example.com/searchable',
          title: 'Banana Searchable',
          referrerUrl: null,
        },
      }),
    );
    expect(await nextMessage(socket)).toMatchObject({ type: 'ack' });

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'search-note',
        excerpt: ['highlight'],
        note: 'banana note body',
        cssPath: [''],
        oldSlug: null,
        url: 'https://example.com/searchable',
        title: 'Banana Searchable',
        ts: 1710000000100,
      }),
    );
    expect(await nextMessage(socket)).toMatchObject({ type: 'ack' });

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        slug: 'searchable-page',
        ts: 1710000000200,
        url: 'https://example.com/searchable',
        title: 'Banana Searchable',
        markdown: 'banana snapshot body',
        html: '<html><body>banana snapshot body</body></html>',
      }),
    );
    expect(await nextMessage(socket)).toMatchObject({ type: 'ack' });

    socket.send(
      JSON.stringify({ type: 'search_notes', query: 'banana', limit: null }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'search_notes_result',
      success: true,
      results: [
        {
          url: 'https://example.com/searchable',
          noteSlug: 'search-note',
          score: 1,
        },
      ],
      error: null,
    });

    socket.send(
      JSON.stringify({
        type: 'search_snapshots',
        query: 'banana',
        limit: null,
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'search_snapshots_result',
      success: true,
      results: [
        { slug: 'searchable-page', timestamp: 1710000000200, score: 1 },
      ],
      error: null,
    });

    socket.close();
  });

  it('serves popup read RPCs from daemon-owned entities', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-popup-rpcs-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);
    const slug = generateSlugFromUrl('https://example.com/popup');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000900,
          action: 'create_list',
          listOwner: 'test-device',
          name: 'Reading',
          listId: 'reading',
          parentListId: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000950,
          action: 'pin_to_list',
          listOwner: 'test-device',
          name: 'Reading',
          urls: ['https://example.com/popup'],
          titles: ['Popup Page'],
          source: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001000,
          action: 'visit_page',
          url: 'https://example.com/popup',
          title: 'Popup Page',
          referrerUrl: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'popup-note',
        excerpt: ['hello'],
        note: 'popup annotation',
        cssPath: [''],
        oldSlug: null,
        url: 'https://example.com/popup',
        title: 'Popup Page',
        ts: 1710000001100,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        slug: 'popup-page',
        ts: 1710000001200,
        url: 'https://example.com/popup',
        title: 'Popup Page',
        markdown: 'popup snapshot body',
        html: '<html><body>popup snapshot body</body></html>',
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(JSON.stringify({ type: 'get_page_info', slug }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'page_info_result',
      success: true,
      slug,
      entry: {
        url: 'https://example.com/popup',
      },
      notes: [
        {
          slug: 'popup-note',
          excerpt: ['hello'],
          note: 'popup annotation',
          url: 'https://example.com/popup',
        },
      ],
      snapshots: [{ hasMd: true, hasHtml: true }],
    });

    socket.send(
      JSON.stringify({
        type: 'get_snapshot_html',
        slug: 'popup-page',
        ts: 1710000001200,
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'snapshot_html_result',
      success: true,
      html: '<html><body>popup snapshot body</body></html>',
      error: null,
    });

    const dataRoot = path.join(dir, 'browser-data');
    rmSync(snapshotPath(dataRoot, 'popup-page', 1710000001200, 'html'));
    rmSync(snapshotPath(dataRoot, 'popup-page', 1710000001200, 'md'));

    socket.send(JSON.stringify({ type: 'get_page_info', slug }));
    const staleSnapshotInfo = await nextMessage(socket);
    expect(staleSnapshotInfo).toMatchObject({
      type: 'page_info_result',
      success: false,
      slug,
      error: expect.stringContaining('references missing snapshot'),
    });
    expect(staleSnapshotInfo.snapshots).toEqual([]);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001300,
          action: 'delete_snapshot',
          url: 'https://example.com/popup',
          path: snapshotRelativePath('popup-page', 1710000001200),
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(JSON.stringify({ type: 'get_page_info', slug }));
    const cleanedSnapshotInfo = await nextMessage(socket);
    expect(cleanedSnapshotInfo).toMatchObject({
      type: 'page_info_result',
      success: true,
      slug,
    });
    expect(cleanedSnapshotInfo.snapshots || []).toEqual([]);

    socket.send(
      JSON.stringify({
        type: 'get_page_summary',
        url: 'https://example.com/popup',
        title: null,
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'page_summary_result',
      success: true,
      lists: expect.arrayContaining([
        {
          slug: 'reading',
          name: 'Reading',
          containsPage: true,
          lastActivity: 1710000000950,
        },
      ]),
    });

    socket.close();
  });

  it('serves test-only history rpc responses', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-read-rpcs-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);
    const localDate = new Date(1710000000000);
    const logFile = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}.jsonl`;

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000000,
          action: 'visit_page',
          url: 'https://example.com/rpc-page',
          title: 'RPC Page',
          referrerUrl: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({ type: 'list_history_files', includeSizes: true }),
    );
    const historyFiles = await nextMessage(socket);
    expect(historyFiles).toMatchObject({
      type: 'history_files_result',
      success: true,
    });
    expect(historyFiles.files).toContain(logFile);
    expect(historyFiles.sizes[logFile]).toEqual(expect.any(Number));

    socket.send(
      JSON.stringify({
        type: 'load_history_batch',
        files: [logFile],
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'history_batch_result',
      success: true,
      entries: [
        {
          action: 'visit_page',
          url: 'https://example.com/rpc-page',
          title: 'RPC Page',
          deviceId: expect.any(String),
        },
      ],
    });

    socket.close();
  });

  it('serves daemon-side sync manifest and local sync file rpc flows', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-sync-rpcs-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);
    const now = Date.now();

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: now,
          action: 'visit_page',
          url: 'https://example.com/sync-page',
          title: 'Sync Page',
          referrerUrl: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'sync-note',
        excerpt: ['sync excerpt'],
        note: 'sync note body',
        cssPath: [''],
        oldSlug: null,
        url: 'https://example.com/sync-page',
        title: 'Sync Page',
        ts: now + 100,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'set_device_id',
        deviceId: 'fresh-sync-device',
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'set_device_id_result',
      success: true,
      deviceId: 'fresh-sync-device',
      error: null,
    });

    socket.send(JSON.stringify({ type: 'get_status' }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'status',
      deviceId: 'fresh-sync-device',
    });

    socket.close();
  });

  it('permanently deletes orphaned note list and snapshot artifacts', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-permanent-delete-'),
    );
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    const url = 'https://example.com/delete-me';
    const pageSlug = generateSlugFromUrl(url);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000020000,
          action: 'create_list',
          listOwner: 'test-device',
          name: 'Reading',
          listId: 'reading-list',
          parentListId: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'n1',
        excerpt: ['hello'],
        note: 'delete me',
        cssPath: [''],
        oldSlug: null,
        url,
        title: 'Delete Me',
        ts: 1710000020100,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        slug: pageSlug,
        ts: 1710000020200,
        url,
        title: 'Delete Me',
        markdown: 'delete snapshot',
        html: '<html><body>delete snapshot</body></html>',
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    for (const entry of [
      {
        timestamp: 1710000020300,
        action: 'delete_note',
        url,
        path: 'objects/notes/n1.json',
      },
      {
        timestamp: 1710000020400,
        action: 'delete_snapshot',
        url,
        path: snapshotRelativePath(pageSlug, 1710000020200),
      },
      {
        timestamp: 1710000020500,
        action: 'delete_list',
        listOwner: 'test-device',
        name: 'Reading',
      },
    ]) {
      socket.send(
        JSON.stringify({
          type: 'event',
          source: 'extension',
          entry,
        }),
      );
      expect((await nextMessage(socket)).type).toBe('ack');
    }

    socket.send(
      JSON.stringify({
        type: 'permanent_delete',
        keys: [
          'note:n1',
          `snapshot:${pageSlug}-1710000020200`,
          'list:reading-list',
        ],
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'permanent_delete_result',
      success: true,
      deletedKeys: [
        'note:n1',
        `snapshot:${pageSlug}-1710000020200`,
        'list:reading-list',
      ],
      error: null,
    });

    const dataRoot = path.join(dir, 'browser-data');
    await waitForMissing(notePath(dataRoot, 'n1'));
    await waitForMissing(
      snapshotPath(dataRoot, pageSlug, 1710000020200, 'html'),
    );
    await waitForMissing(snapshotPath(dataRoot, pageSlug, 1710000020200, 'md'));
    await waitForMissing(listPath(dataRoot, 'reading-list'));

    const orphanedRaw = await waitForFileContent(
      manifestPath(dataRoot, 'orphaned.json'),
      (raw) =>
        !raw.includes('"note:n1"') &&
        !raw.includes(`"snapshot:${pageSlug}-1710000020200"`) &&
        !raw.includes('"list:reading-list"'),
    );
    expect(orphanedRaw).not.toContain('"note:n1"');
    expect(orphanedRaw).not.toContain(`"snapshot:${pageSlug}-1710000020200"`);
    expect(orphanedRaw).not.toContain('"list:reading-list"');

    socket.close();
  });

  it('applies page-only mutations through the streamed event path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-page-events-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000000,
          action: 'rate_page',
          url: 'https://example.com/page-only',
          title: 'Original Title',
          likes: 1,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000100,
          action: 'rename_page',
          url: 'https://example.com/page-only',
          user_title: 'Renamed Page',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    const pageRaw = await waitForFileContent(
      pagePath(
        path.join(dir, 'browser-data'),
        generateSlugFromUrl('https://example.com/page-only'),
      ),
      (raw) => raw.includes('"user_title": "Renamed Page"'),
    );
    expect(pageRaw).toContain('"likes": 1');
    expect(pageRaw).toContain('"title": "Original Title"');
    expect(pageRaw).toContain('"user_title": "Renamed Page"');

    socket.close();
  });

  it('persists streamed notes and links them on the page entity', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-note-events-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'n1',
        excerpt: ['hello'],
        note: 'world',
        cssPath: [''],
        oldSlug: null,
        url: 'https://example.com/note-page',
        title: 'Note Page',
        ts: 1710000000200,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    const dataRoot = path.join(dir, 'browser-data');
    const noteRaw = await waitForFileContent(notePath(dataRoot, 'n1'), (raw) =>
      raw.includes('"excerpt": ['),
    );
    expect(noteRaw).toContain('"excerpt": [');
    expect(noteRaw).toContain('"hello"');
    expect(noteRaw).toContain('"note": "world"');

    const pageRaw = await waitForFileContent(
      pagePath(dataRoot, generateSlugFromUrl('https://example.com/note-page')),
      (raw) =>
        raw.includes('"note:n1"') && raw.includes('"title": "Note Page"'),
    );
    expect(pageRaw).toContain('"note:n1"');
    expect(pageRaw).toContain('"title": "Note Page"');

    socket.close();
  });

  it('applies streamed note replace/delete/restore mutations', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-note-mutations-'),
    );
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'n1',
        excerpt: ['hello'],
        note: 'world',
        cssPath: [''],
        oldSlug: null,
        url: 'https://example.com/note-page',
        title: 'Note Page',
        ts: 1710000000200,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'n2',
        oldSlug: 'n1',
        excerpt: ['hello'],
        note: 'updated world',
        cssPath: [''],
        title: null,
        url: 'https://example.com/note-page',
        ts: 1710000000300,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000400,
          action: 'delete_note',
          url: 'https://example.com/note-page',
          path: 'objects/notes/n2.json',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000500,
          action: 'restore_note',
          url: 'https://example.com/note-page',
          path: 'objects/notes/n2.json',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    const replacedNoteRaw = await waitForFileContent(
      notePath(path.join(dir, 'browser-data'), 'n1'),
      (raw) =>
        raw.includes('"deleted": true') &&
        raw.includes('"deletedTs": 1710000000300'),
    );
    expect(replacedNoteRaw).toContain('"deleted": true');

    const newNoteRaw = await waitForFileContent(
      notePath(path.join(dir, 'browser-data'), 'n2'),
      (raw) =>
        raw.includes('"note": "updated world"') &&
        !raw.includes('"deleted": true') &&
        raw.includes('"deletedTs": 1710000000500'),
    );
    expect(newNoteRaw).toContain('"note": "updated world"');
    expect(newNoteRaw).not.toContain('"deleted": true');
    expect(newNoteRaw).toContain('"deletedTs": 1710000000500');

    const pageRaw = await waitForFileContent(
      pagePath(
        path.join(dir, 'browser-data'),
        generateSlugFromUrl('https://example.com/note-page'),
      ),
      (raw) => raw.includes('"note:n2"') && !raw.includes('"note:n1"'),
    );
    expect(pageRaw).toContain('"note:n2"');
    expect(pageRaw).not.toContain('"note:n1"');

    socket.close();
  });

  it('applies streamed snapshot delete/restore without dropping the html payload', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-snapshot-mutations-'),
    );
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        slug: 'snapshot-page',
        ts: 1710000000600,
        url: 'https://example.com/snapshot-page',
        title: 'Snapshot Page',
        markdown: 'snapshot page',
        html: '<html><body>snapshot page</body></html>',
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000700,
          action: 'delete_snapshot',
          url: 'https://example.com/snapshot-page',
          path: snapshotRelativePath('snapshot-page', 1710000000600),
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000800,
          action: 'restore_snapshot',
          url: 'https://example.com/snapshot-page',
          path: snapshotRelativePath('snapshot-page', 1710000000600),
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    const htmlPath = snapshotPath(
      path.join(dir, 'browser-data'),
      'snapshot-page',
      1710000000600,
      'html',
    );
    expect(readFileSync(htmlPath, 'utf8')).toContain('snapshot page');

    const pageRaw = await waitForFileContent(
      pagePath(
        path.join(dir, 'browser-data'),
        generateSlugFromUrl('https://example.com/snapshot-page'),
      ),
      (raw) => raw.includes('"snapshot:snapshot-page-1710000000600"'),
    );
    expect(pageRaw).toContain('"snapshot:snapshot-page-1710000000600"');

    socket.close();
  });

  it('persists streamed list, rule, pin, and settings mutations', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-list-events-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000000900,
          action: 'create_list',
          listOwner: 'test-device',
          name: 'Reading',
          listId: 'reading-list',
          parentListId: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001000,
          action: 'pin_to_list',
          listOwner: 'test-device',
          name: 'Reading',
          urls: ['https://example.com/reading'],
          titles: ['Reading Page'],
          source: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001100,
          action: 'add_rule',
          listOwner: 'test-device',
          name: 'Reading',
          rule: {
            id: 'rule-k-reading',
            type: 'keyword',
            config: { pattern: 'reading' },
          },
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001200,
          action: 'update_setting',
          key: 'theme',
          value: 'dark',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001300,
          action: 'delete_list',
          listOwner: 'test-device',
          name: 'Reading',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001400,
          action: 'restore_list',
          listOwner: 'test-device',
          name: 'Reading',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    const listRaw = await waitForFileContent(
      listPath(path.join(dir, 'browser-data'), 'reading-list'),
      (raw) =>
        raw.includes('"name": "Reading"') &&
        raw.includes('"rule-k-reading"') &&
        raw.includes('"id": "page:') &&
        !raw.includes('"deleted": true') &&
        raw.includes('"deletedTs": 1710000001400'),
    );
    expect(listRaw).toContain('"name": "Reading"');
    expect(listRaw).toContain('"rule-k-reading"');
    expect(listRaw).toContain('"id": "page:');
    expect(listRaw).not.toContain('"deleted": true');
    expect(listRaw).toContain('"deletedTs": 1710000001400');

    const nameMapRaw = readFileSync(
      manifestPath(path.join(dir, 'browser-data'), 'list-name-to-id.json'),
      'utf8',
    );
    expect(nameMapRaw).toContain('"test-device/Reading": "reading-list"');

    const listOrderRaw = readFileSync(
      manifestPath(path.join(dir, 'browser-data'), 'list-order.json'),
      'utf8',
    );
    expect(listOrderRaw).toContain('"id": "list:reading-list"');

    const settingsRaw = readFileSync(
      manifestPath(path.join(dir, 'browser-data'), 'settings.json'),
      'utf8',
    );
    expect(settingsRaw).toContain('"theme": "dark"');

    const orphanedRaw = readFileSync(
      manifestPath(path.join(dir, 'browser-data'), 'orphaned.json'),
      'utf8',
    );
    expect(orphanedRaw).not.toContain('"list:reading-list"');

    socket.close();
  });

  it('auto-pins streamed visits for matching function rules', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-rule-events-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001500,
          action: 'create_list',
          listOwner: 'test-device',
          name: 'Custom Hubs',
          listId: 'custom-hubs',
          parentListId: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001600,
          action: 'add_rule',
          listOwner: 'test-device',
          name: 'Custom Hubs',
          rule: {
            id: 'rule-f-hubs',
            type: 'function',
            config: {
              description: 'Hub pages',
              fnSource:
                "const u = new URL(page.url); return u.pathname === '/' && !u.searchParams.has('q');",
            },
          },
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001700,
          action: 'visit_page',
          url: 'https://example.com/',
          title: 'Example Home',
          referrerUrl: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    const listRaw = await waitForFileContent(
      listPath(path.join(dir, 'browser-data'), 'custom-hubs'),
      (raw) =>
        raw.includes('"rule-f-hubs"') &&
        raw.includes('"source": "auto"') &&
        raw.includes('"id": "page:'),
    );
    expect(listRaw).toContain('"rule-f-hubs"');
    expect(listRaw).toContain('"source": "auto"');
    expect(listRaw).toContain('"id": "page:');

    const logsDir = path.join(dir, 'browser-data', 'logs');
    const [deviceDir] = await import('node:fs/promises').then((fs) =>
      fs.readdir(logsDir),
    );
    const [logFile] = await import('node:fs/promises').then((fs) =>
      fs.readdir(path.join(logsDir, deviceDir)),
    );
    const logRaw = readFileSync(path.join(logsDir, deviceDir, logFile), 'utf8');
    expect(logRaw).toContain('"action":"visit_page"');
    expect(logRaw).toContain('"action":"pin_to_list"');
    expect(logRaw).toContain('"source":"auto"');

    socket.close();
  });

  it('clears daemon-owned data and recreates an empty layout', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-clear-data-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000025000,
          action: 'visit_page',
          url: 'https://example.com/clear-me',
          title: 'Clear Me',
          referrerUrl: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(JSON.stringify({ type: 'clear_all_data' }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'clear_all_data_result',
      success: true,
      deletedCount: expect.any(Number),
    });

    socket.send(
      JSON.stringify({ type: 'list_history_files', includeSizes: false }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'history_files_result',
      success: true,
      devices: [expect.any(String)],
    });

    const pagesDir = path.join(dir, 'browser-data', 'views', 'pages');
    const listsDir = path.join(dir, 'browser-data', 'views', 'lists');
    const manifestDir = path.join(dir, 'browser-data', 'views', 'manifest');
    const logsDir = path.join(dir, 'browser-data', 'logs');
    expect(readFileSync(path.join(dir, 'config.json'), 'utf8')).toContain(
      '"device_id"',
    );
    expect(
      await import('node:fs/promises').then((fs) => fs.readdir(pagesDir)),
    ).toEqual([]);
    expect(
      await import('node:fs/promises').then((fs) => fs.readdir(listsDir)),
    ).toEqual([]);
    expect(
      await import('node:fs/promises').then((fs) => fs.readdir(manifestDir)),
    ).toEqual([]);
    const logDeviceDirs = await import('node:fs/promises').then((fs) =>
      fs.readdir(logsDir),
    );
    expect(logDeviceDirs).toHaveLength(1);
    expect(
      await import('node:fs/promises').then((fs) =>
        fs.readdir(path.join(logsDir, logDeviceDirs[0])),
      ),
    ).toEqual([]);

    socket.close();
  });

  it('supports daemon-side rule preview over websocket', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-rule-preview-'),
    );
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'preview_rule',
        rule: {
          type: 'function',
          config: {
            description: 'Long titles',
            fnSource: 'return page.title.length > 10;',
          },
        },
        entries: [
          {
            url: 'https://example.com/long',
            title: 'A Very Long Title',
            bodyPreview: null,
          },
          {
            url: 'https://example.com/short',
            title: 'Short',
            bodyPreview: null,
          },
        ],
      }),
    );
    const preview = await nextMessage(socket);
    expect(preview).toMatchObject({
      type: 'preview_rule_result',
      success: true,
    });
    expect(preview.results).toHaveLength(2);
    expect(preview.results[0].match).toBe(true);
    expect(preview.results[1].match).toBe(false);

    socket.close();
  });

  it('supports daemon-side retro rule batches over websocket', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-rule-batch-'));
    tempDirs.push(dir);
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await pairSocket(port);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001800,
          action: 'create_list',
          listOwner: 'test-device',
          name: 'Reading',
          listId: 'reading',
          parentListId: null,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001900,
          action: 'add_rule',
          listOwner: 'test-device',
          name: 'Reading',
          rule: {
            id: 'rule-k-reading',
            type: 'keyword',
            config: { pattern: 'Repo' },
          },
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'run_rule_batch',
        listIds: ['reading'],
        entries: [
          {
            url: 'https://github.com/example/repo',
            title: 'Repo',
            bodyPreview: null,
          },
          {
            url: 'https://example.com/',
            title: 'Example',
            bodyPreview: null,
          },
        ],
      }),
    );
    const batch = await nextMessage(socket);
    expect(batch).toMatchObject({
      type: 'rule_batch_result',
      success: true,
    });
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0].listId).toBe('reading');
    expect(batch.results[0].url).toBe('https://github.com/example/repo');

    const listRaw = await waitForFileContent(
      listPath(path.join(dir, 'browser-data'), 'reading'),
      (raw) => raw.includes('"source": "auto"'),
    );
    expect(listRaw).toContain('"source": "auto"');

    socket.close();
  });
});
