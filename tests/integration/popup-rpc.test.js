import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { generateSlugFromUrl } from '../../packages/core/page-identity.js';

const ROOT = process.cwd();
const BINARY_PATH = path.join(ROOT, 'target', 'debug', 'browser-recall-daemon');
const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const PORT_CANDIDATES = [28771, 28772, 28773];

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
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'change') return;
      socket.off('message', onMessage);
      socket.off('error', onError);
      resolve(message);
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

function launchDaemon(configDir) {
  return spawn(
    BINARY_PATH,
    ['--config-dir', configDir, '--approve-mode', 'allow'],
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
  return { socket, deviceId: approved.deviceId };
}

describe.sequential('popup rpc integration', () => {
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

  it('returns a single popup summary payload with page, notes, snapshots, lists, and attention', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-popup-summary-'),
    );
    tempDirs.push(dir);
    const child = launchDaemon(dir);
    childProcesses.push(child);
    const port = await waitForListening(child);
    const { socket, deviceId } = await pairSocket(port);

    const url = 'https://example.com/articles/popup-summary';
    const slug = generateSlugFromUrl(url);
    const noteSlug = '240101-popup-summary-note-abc123';
    const timestamp = 1710000000000;

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp,
          action: 'visit_page',
          url,
          title: 'Popup Summary',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: timestamp + 1,
          action: 'create_list',
          name: 'Reading',
          listOwner: deviceId,
          listId: 'reading-popup',
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'event',
        source: 'extension',
        entry: {
          timestamp: timestamp + 2,
          action: 'pin_to_list',
          name: 'Reading',
          listOwner: deviceId,
          urls: [url],
          titles: ['Popup Summary'],
        },
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'note',
        source: 'extension',
        slug: noteSlug,
        excerpt: ['Summary highlight'],
        note: 'Summary note body',
        url,
        title: 'Popup Summary',
        ts: timestamp + 3,
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        source: 'extension',
        slug,
        ts: timestamp + 4,
        url,
        title: 'Popup Summary',
        html: '<html><body>popup summary</body></html>',
      }),
    );
    expect((await nextMessage(socket)).type).toBe('ack');

    socket.send(
      JSON.stringify({
        type: 'get_page_summary',
        url,
      }),
    );
    const summary = await nextMessage(socket);
    expect(summary).toMatchObject({
      type: 'page_summary_result',
      success: true,
      url,
      page: {
        slug,
        url,
        title: 'Popup Summary',
      },
      attention: {
        totalSeconds: 0,
        lastVisit: timestamp + 4,
      },
    });
    expect(summary.notes).toEqual([
      expect.objectContaining({
        slug: noteSlug,
        excerpt: ['Summary highlight'],
        note: 'Summary note body',
        url,
      }),
    ]);
    expect(summary.snapshots).toEqual([
      expect.objectContaining({
        timestamp: timestamp + 4,
        hasHtml: true,
      }),
    ]);
    expect(summary.lists).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'reading-popup',
          name: 'Reading',
          pins: expect.arrayContaining([
            expect.objectContaining({
              id: `page:${slug}`,
            }),
          ]),
        }),
      ]),
    );

    socket.close();
  });
});
