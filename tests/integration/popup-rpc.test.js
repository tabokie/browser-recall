import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { generateSlugFromUrl } from '../../packages/core/page-identity.js';
import {
  collectDaemonMessages as collectMessages,
  ensureTestDaemonBuilt,
  launchTestDaemon,
  nextDaemonMessage as nextMessage,
  stopTestDaemon,
  waitForDaemonListening as waitForListening,
} from './daemon-test-harness.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnop';
const PORT_CANDIDATES = [28771, 28772, 28773];

function launchDaemon(configDir) {
  return launchTestDaemon(configDir, {
    ports: PORT_CANDIDATES,
    approveMode: 'allow',
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
      browserId: 'browser-install-1',
      browserName: 'Chrome',
      extensionId: 'abcdefghijklmnop',
    }),
  );
  const [, approved] = await pairingMessages;
  expect(approved.type).toBe('pair_approved');
  return { socket, deviceId: approved.deviceId };
}

describe.sequential('popup rpc integration', () => {
  let tempDirs = [];
  let childProcesses = [];

  beforeAll(() => ensureTestDaemonBuilt(), 300_000);

  afterEach(async () => {
    await Promise.all(
      childProcesses.splice(0).map((child) => stopTestDaemon(child)),
    );
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
