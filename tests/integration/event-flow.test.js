import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const ROOT = process.cwd();
const BINARY_PATH = path.join(ROOT, 'target', 'debug', 'browser-recall-daemon');
const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const PORT_CANDIDATES = [28671, 28672, 28673];

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('daemon did not start')),
      15_000,
    );
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const match = text.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited early with code ${code}`));
    });
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    socket.once('error', reject);
  });
}

function collectMessages(socket, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (raw) => {
      messages.push(JSON.parse(raw.toString()));
      if (messages.length === count) {
        socket.off('message', onMessage);
        socket.off('error', onError);
        resolve(messages);
      }
    };
    const onError = (error) => {
      socket.off('message', onMessage);
      socket.off('error', onError);
      reject(error);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

function generateSlug(text, hashInput) {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 30)
    .replace(/-+$/, '');

  let hash = 0;
  for (let i = 0; i < hashInput.length; i += 1) {
    hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
  }
  return `${base}-${Math.abs(hash).toString(36)}`.substring(0, 80);
}

function generateSlugFromUrl(url) {
  const parsed = new URL(url);
  let domain = parsed.hostname.toLowerCase();
  if (domain.startsWith('www.')) domain = domain.slice(4);
  const lastDot = domain.lastIndexOf('.');
  if (lastDot > 0) domain = domain.slice(0, lastDot);
  return generateSlug(domain + parsed.pathname, url);
}

function launchDaemon(configDir, approveMode = 'allow') {
  return spawn(
    BINARY_PATH,
    ['--config-dir', configDir, '--approve-mode', approveMode],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        BROWSER_RECALL_PORTS: PORT_CANDIDATES.join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function pairSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Origin: ORIGIN },
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'pair_request',
      browserId: 'browser-install-1',
      browserName: 'Chrome',
      extensionId: 'abcdefghijklmnop',
    }),
  );
  const [, approved] = await collectMessages(socket, 2);
  expect(approved.type).toBe('pair_approved');
  return socket;
}

describe.sequential('phase 2 daemon event flow integration', () => {
  let tempDirs = [];
  let childProcesses = [];

  beforeAll(() => {
    const build = spawnSync(
      'cargo',
      [
        'build',
        '-p',
        'browser-recall-daemon',
        '--bin',
        'browser-recall-daemon',
      ],
      {
        cwd: ROOT,
        stdio: 'inherit',
      },
    );
    expect(build.status).toBe(0);
  });

  afterEach(() => {
    for (const child of childProcesses.splice(0)) {
      child.kill('SIGINT');
    }
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
          checkpoint: true,
        },
      }),
    );
    const ack = await nextMessage(socket);
    expect(ack.type).toBe('ack');
    expect(ack.bufferDepth).toBe(0);
    expect(ack.lastDrainedAt).toBe(1710000000000);

    socket.send(JSON.stringify({ type: 'get_status' }));
    const status = await nextMessage(socket);
    expect(status).toMatchObject({
      type: 'status',
      connectedBrowsers: ['Chrome'],
      bufferDepth: 0,
      dataFolder: path.join(dir, 'portal-data'),
    });
    expect(status.lastDrainedAt).toBe(1710000000000);

    const pagesDir = path.join(dir, 'portal-data', 'pages');
    const pageFiles = await import('node:fs/promises').then((fs) =>
      fs.readdir(pagesDir),
    );
    expect(pageFiles.length).toBe(1);
    const pageRaw = readFileSync(path.join(pagesDir, pageFiles[0]), 'utf8');
    expect(pageRaw).toContain('"title": "Streamed"');
    expect(pageRaw).toContain('"url": "https://example.com/streamed"');

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
        source: 'extension',
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

    const htmlPath = path.join(
      dir,
      'portal-data',
      'data',
      'snapshots',
      'example-streamed-1710000001000.html',
    );
    expect(readFileSync(htmlPath, 'utf8')).toContain('streamed snapshot');
    const markdownPath = path.join(
      dir,
      'portal-data',
      'data',
      'snapshots',
      'example-streamed-1710000001000.md',
    );
    expect(readFileSync(markdownPath, 'utf8')).toContain('streamed snapshot');

    const logsDir = path.join(dir, 'portal-data', 'data', 'logs');
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

  it('serves streamed search RPCs from ingested desktop data', async () => {
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
          checkpoint: true,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'search-note',
        excerpt: 'highlight',
        note: 'banana note body',
        cssPath: null,
        url: 'https://example.com/searchable',
        title: 'Banana Searchable',
        ts: 1710000000100,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        source: 'extension',
        slug: 'searchable-page',
        ts: 1710000000200,
        url: 'https://example.com/searchable',
        title: 'Banana Searchable',
        markdown: 'banana snapshot body',
        html: '<html><body>banana snapshot body</body></html>',
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(JSON.stringify({ type: 'search_history', query: 'banana' }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'search_history_result',
      success: true,
      results: [
        {
          url: 'https://example.com/searchable',
          title: 'Banana Searchable',
        },
      ],
    });

    socket.send(JSON.stringify({ type: 'search_notes', query: 'banana' }));
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'search_notes_result',
      success: true,
      results: [
        {
          url: 'https://example.com/searchable',
          noteSlug: 'search-note',
        },
      ],
    });

    socket.send(JSON.stringify({ type: 'search_snapshots', query: 'banana' }));
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'search_snapshots_result',
      success: true,
      results: [{ slug: 'searchable-page' }],
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
          items: ['https://example.com/popup'],
          titles: {
            'https://example.com/popup': 'Popup Page',
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
          timestamp: 1710000001000,
          action: 'visit_page',
          url: 'https://example.com/popup',
          title: 'Popup Page',
          checkpoint: true,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'popup-note',
        excerpt: 'hello',
        note: 'popup annotation',
        cssPath: null,
        url: 'https://example.com/popup',
        title: 'Popup Page',
        ts: 1710000001100,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        source: 'extension',
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
          excerpt: 'hello',
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
    });

    rmSync(
      path.join(
        dir,
        'portal-data',
        'data',
        'snapshots',
        'popup-page-1710000001200.html',
      ),
    );
    rmSync(
      path.join(
        dir,
        'portal-data',
        'data',
        'snapshots',
        'popup-page-1710000001200.md',
      ),
    );

    socket.send(JSON.stringify({ type: 'get_page_info', slug }));
    const staleSnapshotInfo = await nextMessage(socket);
    expect(staleSnapshotInfo).toMatchObject({
      type: 'page_info_result',
      success: true,
      slug,
    });
    expect(staleSnapshotInfo.snapshots).toEqual([
      { timestamp: 1710000001200, hasMd: false, hasHtml: false },
    ]);

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: 1710000001300,
          action: 'delete_snapshot',
          url: 'https://example.com/popup',
          path: 'snapshots/popup-page-1710000001200',
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
        type: 'get_entity',
        key: `page:${slug}`,
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'entity_result',
      success: true,
      key: `page:${slug}`,
      entity: {
        url: 'https://example.com/popup',
      },
    });

    socket.send(
      JSON.stringify({
        type: 'get_entity',
        key: 'note:popup-note',
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'entity_result',
      success: true,
      key: 'note:popup-note',
      entity: {
        slug: 'popup-note',
        excerpt: 'hello',
        note: 'popup annotation',
        url: 'https://example.com/popup',
      },
    });

    socket.send(JSON.stringify({ type: 'get_popup_lists' }));
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'popup_lists_result',
      success: true,
      lists: [
        {
          slug: 'reading',
          name: 'Reading',
          pins: [
            {
              id: expect.stringMatching(/^page:/),
              pinnedAt: 1710000000950,
            },
          ],
        },
      ],
    });

    socket.close();
  });

  it('serves directory history and page-scan rpc responses', async () => {
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
          checkpoint: true,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(JSON.stringify({ type: 'get_directory_info' }));
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'directory_info_result',
      success: true,
      info: {
        name: 'portal-data',
        hasPermission: true,
      },
    });

    socket.send(JSON.stringify({ type: 'get_directory_size' }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'directory_size_result',
      success: true,
      size: expect.any(Number),
    });

    socket.send(
      JSON.stringify({ type: 'list_history_files', includeSizes: true }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'history_files_result',
      success: true,
      files: [logFile],
      sizes: {
        [logFile]: expect.any(Number),
      },
    });

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

    socket.send(JSON.stringify({ type: 'get_all_pages' }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'all_pages_result',
      success: true,
      pages: {
        [generateSlugFromUrl('https://example.com/rpc-page')]: {
          url: 'https://example.com/rpc-page',
          title: 'RPC Page',
        },
      },
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
          checkpoint: true,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'sync-note',
        excerpt: 'sync excerpt',
        note: 'sync note body',
        cssPath: null,
        url: 'https://example.com/sync-page',
        title: 'Sync Page',
        ts: now + 100,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'save_sync_manifest',
        key: 'sync-cursors',
        data: {
          cursors: {
            peer1: {
              treeSha: 'abc',
              files: { 'data/logs/peer1/a.jsonl': 'x' },
            },
          },
        },
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'sync_manifest_result',
      success: true,
      key: 'sync-cursors',
      data: {
        cursors: {
          peer1: { treeSha: 'abc', files: { 'data/logs/peer1/a.jsonl': 'x' } },
        },
      },
    });

    socket.send(
      JSON.stringify({
        type: 'load_sync_manifest',
        key: 'sync-cursors',
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'sync_manifest_result',
      success: true,
      key: 'sync-cursors',
      data: {
        cursors: {
          peer1: { treeSha: 'abc', files: { 'data/logs/peer1/a.jsonl': 'x' } },
        },
      },
    });

    socket.send(JSON.stringify({ type: 'get_status' }));
    const status = await nextMessage(socket);
    expect(status.type).toBe('status');
    const deviceId = status.deviceId;

    socket.send(
      JSON.stringify({
        type: 'collect_sync_files',
        deviceId,
        retentionDays: 7,
      }),
    );
    const syncFiles = await nextMessage(socket);
    expect(syncFiles).toMatchObject({
      type: 'sync_files_result',
      success: true,
    });
    expect(
      syncFiles.files.some((file) =>
        file.path.startsWith(`data/logs/${deviceId}/`),
      ),
    ).toBe(true);
    expect(
      syncFiles.files.some((file) => file.path === 'data/notes/sync-note.json'),
    ).toBe(true);

    socket.send(
      JSON.stringify({
        type: 'write_sync_files',
        files: [
          {
            path: 'data/logs/peer-sync/2026-04-19.jsonl',
            content:
              '{"timestamp":1710000010200,"action":"visit_page","url":"https://peer.example/path","title":"Peer"}\n',
          },
          {
            path: 'data/notes/peer-note.json',
            content: '{"slug":"peer-note","note":"remote"}',
          },
        ],
      }),
    );
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'write_sync_files_result',
      success: true,
    });

    expect(
      readFileSync(
        path.join(
          dir,
          'portal-data',
          'data',
          'logs',
          'peer-sync',
          '2026-04-19.jsonl',
        ),
        'utf8',
      ),
    ).toContain('"url":"https://peer.example/path"');
    expect(
      readFileSync(
        path.join(dir, 'portal-data', 'data', 'notes', 'peer-note.json'),
        'utf8',
      ),
    ).toContain('"peer-note"');

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
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: 'n1',
        excerpt: 'hello',
        note: 'delete me',
        cssPath: null,
        url,
        title: 'Delete Me',
        ts: 1710000020100,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        source: 'extension',
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
        path: 'notes/n1.json',
      },
      {
        timestamp: 1710000020400,
        action: 'delete_snapshot',
        url,
        path: `snapshots/${pageSlug}-1710000020200`,
      },
      {
        timestamp: 1710000020500,
        action: 'delete_list',
        listOwner: 'test-device',
        name: 'Reading',
      },
    ]) {
      socket.send(
        JSON.stringify({ type: 'event', source: 'extension', entry }),
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
    });

    expect(() =>
      readFileSync(path.join(dir, 'portal-data', 'data', 'notes', 'n1.json')),
    ).toThrow();
    expect(() =>
      readFileSync(
        path.join(
          dir,
          'portal-data',
          'data',
          'snapshots',
          `${pageSlug}-1710000020200.html`,
        ),
      ),
    ).toThrow();
    expect(() =>
      readFileSync(
        path.join(
          dir,
          'portal-data',
          'data',
          'snapshots',
          `${pageSlug}-1710000020200.md`,
        ),
      ),
    ).toThrow();
    expect(() =>
      readFileSync(path.join(dir, 'portal-data', 'lists', 'reading-list.json')),
    ).toThrow();

    const orphanedRaw = readFileSync(
      path.join(dir, 'portal-data', 'manifest', 'orphaned.json'),
      'utf8',
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

    const pagesDir = path.join(dir, 'portal-data', 'pages');
    const pageFiles = await import('node:fs/promises').then((fs) =>
      fs.readdir(pagesDir),
    );
    expect(pageFiles.length).toBe(1);
    const pageRaw = readFileSync(path.join(pagesDir, pageFiles[0]), 'utf8');
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
        excerpt: 'hello',
        note: 'world',
        cssPath: null,
        url: 'https://example.com/note-page',
        title: 'Note Page',
        ts: 1710000000200,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    const noteRaw = readFileSync(
      path.join(dir, 'portal-data', 'data', 'notes', 'n1.json'),
      'utf8',
    );
    expect(noteRaw).toContain('"excerpt": "hello"');
    expect(noteRaw).toContain('"note": "world"');

    const pagesDir = path.join(dir, 'portal-data', 'pages');
    const pageFiles = await import('node:fs/promises').then((fs) =>
      fs.readdir(pagesDir),
    );
    const pageRaw = readFileSync(path.join(pagesDir, pageFiles[0]), 'utf8');
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
        excerpt: 'hello',
        note: 'world',
        cssPath: null,
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
        excerpt: 'hello',
        note: 'updated world',
        cssPath: null,
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
          path: 'notes/n2.json',
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
          path: 'notes/n2.json',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    expect(
      existsSync(path.join(dir, 'portal-data', 'data', 'notes', 'n1.json')),
    ).toBe(false);

    const newNoteRaw = readFileSync(
      path.join(dir, 'portal-data', 'data', 'notes', 'n2.json'),
      'utf8',
    );
    expect(newNoteRaw).toContain('"note": "updated world"');
    expect(newNoteRaw).not.toContain('"deleted": true');
    expect(newNoteRaw).toContain('"deletedTs": 1710000000500');

    const pagesDir = path.join(dir, 'portal-data', 'pages');
    const [pageFile] = await import('node:fs/promises').then((fs) =>
      fs.readdir(pagesDir),
    );
    const pageRaw = readFileSync(path.join(pagesDir, pageFile), 'utf8');
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
        source: 'extension',
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
          path: 'snapshots/snapshot-page-1710000000600',
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
          path: 'snapshots/snapshot-page-1710000000600',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    const htmlPath = path.join(
      dir,
      'portal-data',
      'data',
      'snapshots',
      'snapshot-page-1710000000600.html',
    );
    expect(readFileSync(htmlPath, 'utf8')).toContain('snapshot page');

    const pagesDir = path.join(dir, 'portal-data', 'pages');
    const [pageFile] = await import('node:fs/promises').then((fs) =>
      fs.readdir(pagesDir),
    );
    const pageRaw = readFileSync(path.join(pagesDir, pageFile), 'utf8');
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
          items: ['https://example.com/reading'],
          titles: {
            'https://example.com/reading': 'Reading Page',
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
          timestamp: 1710000001100,
          action: 'add_rule',
          listOwner: 'test-device',
          name: 'Reading',
          rule: {
            id: 'rule-k-reading',
            type: 'keyword',
            config: { pattern: 'reading', fields: ['title'] },
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
          value: 'sepia',
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

    const listRaw = readFileSync(
      path.join(dir, 'portal-data', 'lists', 'reading-list.json'),
      'utf8',
    );
    expect(listRaw).toContain('"name": "Reading"');
    expect(listRaw).toContain('"rule-k-reading"');
    expect(listRaw).toContain('"id": "page:');
    expect(listRaw).not.toContain('"deleted": true');
    expect(listRaw).toContain('"deletedTs": 1710000001400');

    const nameMapRaw = readFileSync(
      path.join(dir, 'portal-data', 'manifest', 'list-name-to-id.json'),
      'utf8',
    );
    expect(nameMapRaw).toContain('"test-device/Reading": "reading-list"');

    const listOrderRaw = readFileSync(
      path.join(dir, 'portal-data', 'manifest', 'list-order.json'),
      'utf8',
    );
    expect(listOrderRaw).toContain('"id": "list:reading-list"');

    const settingsRaw = readFileSync(
      path.join(dir, 'portal-data', 'manifest', 'settings.json'),
      'utf8',
    );
    expect(settingsRaw).toContain('"theme": "sepia"');

    const orphanedRaw = readFileSync(
      path.join(dir, 'portal-data', 'manifest', 'orphaned.json'),
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
          name: 'Hubs',
          listId: 'hubs',
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
          name: 'Hubs',
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
          checkpoint: true,
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    const listRaw = readFileSync(
      path.join(dir, 'portal-data', 'lists', 'hubs.json'),
      'utf8',
    );
    expect(listRaw).toContain('"rule-f-hubs"');
    expect(listRaw).toContain('"source": "auto"');
    expect(listRaw).toContain('"id": "page:');

    const logsDir = path.join(dir, 'portal-data', 'data', 'logs');
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
          checkpoint: true,
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

    socket.send(JSON.stringify({ type: 'get_directory_info' }));
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'directory_info_result',
      success: true,
      info: {
        name: 'portal-data',
        hasPermission: true,
      },
    });

    socket.send(JSON.stringify({ type: 'list_history_files' }));
    await expect(nextMessage(socket)).resolves.toEqual({
      type: 'history_files_result',
      success: true,
    });

    const pagesDir = path.join(dir, 'portal-data', 'pages');
    const listsDir = path.join(dir, 'portal-data', 'lists');
    const manifestDir = path.join(dir, 'portal-data', 'manifest');
    const logsDir = path.join(dir, 'portal-data', 'data', 'logs');
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
          },
          {
            url: 'https://example.com/short',
            title: 'Short',
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
            config: { pattern: 'github', fields: ['url'] },
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
          },
          {
            url: 'https://example.com/',
            title: 'Example',
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

    const listRaw = readFileSync(
      path.join(dir, 'portal-data', 'lists', 'reading.json'),
      'utf8',
    );
    expect(listRaw).toContain('"source": "auto"');

    socket.close();
  });
});
