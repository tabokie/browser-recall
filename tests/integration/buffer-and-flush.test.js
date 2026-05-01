import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import NodeWebSocket from 'ws';

const ROOT = process.cwd();
const BINARY_PATH = path.join(ROOT, 'target', 'debug', 'browser-recall-daemon');
const TEST_PORTS = [38472, 38473];

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

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
  });
}

function openRawSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = new NodeWebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnop' },
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextRawJson(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

function launchDaemon(configDir, approveMode = 'allow') {
  return spawn(
    BINARY_PATH,
    ['--config-dir', configDir, '--approve-mode', approveMode],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        BROWSER_RECALL_PORTS: TEST_PORTS.join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function waitFor(predicate, timeoutMs = 15_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('condition not met before timeout');
}

function createChromeMock() {
  const store = {};
  const alarms = new Map();
  const alarmListeners = [];
  const local = {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') {
        return keys in store ? { [keys]: store[keys] } : {};
      }
      if (Array.isArray(keys)) {
        const result = {};
        for (const key of keys) {
          if (key in store) result[key] = store[key];
        }
        return result;
      }
      const result = {};
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = key in store ? store[key] : fallback;
      }
      return result;
    },
    async set(values) {
      Object.assign(store, values);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete store[key];
      }
    },
  };

  return {
    chrome: {
      runtime: {
        id: 'abcdefghijklmnop',
      },
      alarms: {
        create(name, info) {
          alarms.set(name, info || {});
        },
        async clear(name) {
          return alarms.delete(name);
        },
        onAlarm: {
          addListener(listener) {
            alarmListeners.push(listener);
          },
        },
        async _trigger(name) {
          for (const listener of alarmListeners) {
            await listener({ name });
          }
        },
      },
      storage: {
        local,
      },
    },
    store,
    alarms,
  };
}

class BrowserLikeWebSocket {
  static CONNECTING = NodeWebSocket.CONNECTING;
  static OPEN = NodeWebSocket.OPEN;
  static CLOSING = NodeWebSocket.CLOSING;
  static CLOSED = NodeWebSocket.CLOSED;
  static delayMessageMs = 0;
  static delayMessagePredicate = null;
  static closeOnNextStatus = false;
  static hangOnNextStatus = false;
  static instances = [];

  constructor(url) {
    this.socket = new NodeWebSocket(url, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnop' },
    });
    BrowserLikeWebSocket.instances.push(this);
  }

  get readyState() {
    return this.socket.readyState;
  }

  addEventListener(type, handler, options = {}) {
    if (type === 'open' && this.socket.readyState === NodeWebSocket.OPEN) {
      setTimeout(() => handler(), 0);
      return;
    }
    const wrapped = (...args) => {
      if (type === 'message') {
        const data = args[0].toString();
        if (
          BrowserLikeWebSocket.delayMessageMs > 0 &&
          BrowserLikeWebSocket.delayMessagePredicate?.(data)
        ) {
          setTimeout(
            () => handler({ data }),
            BrowserLikeWebSocket.delayMessageMs,
          );
          return;
        }
        handler({ data });
      } else if (type === 'error') {
        handler(args[0]);
      } else {
        handler(...args);
      }
    };
    if (options.once) {
      this.socket.once(type, wrapped);
    } else {
      this.socket.on(type, wrapped);
    }
  }

  send(payload) {
    try {
      const message = JSON.parse(payload);
      if (message.type === 'get_status') {
        if (BrowserLikeWebSocket.closeOnNextStatus) {
          BrowserLikeWebSocket.closeOnNextStatus = false;
          this.socket.close();
          return;
        }
        if (BrowserLikeWebSocket.hangOnNextStatus) {
          BrowserLikeWebSocket.hangOnNextStatus = false;
          return;
        }
      }
    } catch {}
    this.socket.send(payload);
  }

  close() {
    this.socket.close();
  }
}

class RefusingWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static urls = [];

  constructor(url) {
    this.url = url;
    this.readyState = RefusingWebSocket.CONNECTING;
    RefusingWebSocket.urls.push(url);
  }

  addEventListener(type, handler) {
    if (type !== 'error') return;
    setTimeout(() => {
      this.readyState = RefusingWebSocket.CLOSED;
      handler(new Error('connection refused'));
    }, 0);
  }

  send() {}

  close() {
    this.readyState = RefusingWebSocket.CLOSED;
  }
}

describe.sequential('phase 2 connector buffer and flush integration', () => {
  let tempDirs = [];
  let childProcesses = [];
  let originalWebSocket;
  let originalChrome;
  let originalNavigator;
  let originalSetTimeout;
  let originalConnectorPorts;

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

  beforeEach(() => {
    originalConnectorPorts = globalThis.__BROWSER_RECALL_CONNECTOR_PORTS;
    globalThis.__BROWSER_RECALL_CONNECTOR_PORTS = TEST_PORTS;
  });

  afterEach(async () => {
    for (const child of childProcesses.splice(0)) {
      child.kill('SIGINT');
      await waitForExit(child).catch(() => {});
    }
    await new Promise((resolve) => originalSetTimeout(resolve, 25));

    vi.resetModules();
    globalThis.WebSocket = originalWebSocket;
    globalThis.chrome = originalChrome;
    if (originalConnectorPorts === undefined) {
      delete globalThis.__BROWSER_RECALL_CONNECTOR_PORTS;
    } else {
      globalThis.__BROWSER_RECALL_CONNECTOR_PORTS = originalConnectorPorts;
    }
    if (originalNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      });
    }
    globalThis.setTimeout = originalSetTimeout;
    BrowserLikeWebSocket.delayMessageMs = 0;
    BrowserLikeWebSocket.delayMessagePredicate = null;
    BrowserLikeWebSocket.closeOnNextStatus = false;
    BrowserLikeWebSocket.hangOnNextStatus = false;
    BrowserLikeWebSocket.instances = [];
    RefusingWebSocket.urls = [];

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('queues connector events while offline and flushes them in order after reconnect', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-buffer-flush-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    let child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });

    child.kill('SIGINT');
    childProcesses.pop();
    await waitForExit(child);
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'offline';
    });

    const queuedEntries = [
      {
        timestamp: 1710000002100,
        action: 'create_list',
        listOwner: 'test-device',
        name: 'Queued Reading',
        listId: 'queued-reading',
      },
      {
        timestamp: 1710000002200,
        action: 'pin_to_list',
        listOwner: 'test-device',
        name: 'Queued Reading',
        items: ['https://example.com/queued'],
        titles: {
          'https://example.com/queued': 'Queued Page',
        },
      },
      {
        timestamp: 1710000002300,
        action: 'update_setting',
        key: 'theme',
        value: 'sepia',
      },
    ];

    for (const entry of queuedEntries) {
      await wsClient.enqueueDesktopEvent(entry);
    }

    expect(store.desktopPendingEvents).toBe(3);
    expect(store.desktopEventBuffer).toHaveLength(3);

    child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.connectDesktopBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.pendingEvents === 0;
    });

    const dataRoot = path.join(dir, 'portal-data');
    const listRaw = readFileSync(
      path.join(dataRoot, 'lists', 'queued-reading.json'),
      'utf8',
    );
    expect(listRaw).toContain('"name": "Queued Reading"');
    expect(listRaw).toContain('"id": "page:');

    const settingsRaw = readFileSync(
      path.join(dataRoot, 'manifest', 'settings.json'),
      'utf8',
    );
    expect(settingsRaw).toContain('"theme": "sepia"');

    const logsDir = path.join(dataRoot, 'data', 'logs');
    const [deviceDir] = await readdir(logsDir);
    const [logFile] = await readdir(path.join(logsDir, deviceDir));
    const lines = readFileSync(path.join(logsDir, deviceDir, logFile), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.slice(-3).map((line) => line.action)).toEqual([
      'create_list',
      'pin_to_list',
      'update_setting',
    ]);

    expect(store.desktopPendingEvents).toBe(0);
    expect(store.desktopEventBuffer).toEqual([]);
  }, 30_000);

  it('flushes queued events, notes, and snapshots in FIFO order after reconnect', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-buffer-flush-mixed-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    let child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });

    child.kill('SIGINT');
    childProcesses.pop();
    await waitForExit(child);
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'offline';
    });

    await wsClient.enqueueDesktopEvent({
      timestamp: 1710000002400,
      action: 'create_list',
      listOwner: 'test-device',
      name: 'Mixed Queue',
      listId: 'mixed-queue',
    });
    await wsClient.enqueueDesktopNote({
      slug: 'offline-note',
      excerpt: 'offline highlight',
      note: 'offline note body',
      cssPath: null,
      url: 'https://example.com/offline',
      title: 'Offline Page',
      ts: 1710000002500,
    });
    await wsClient.enqueueDesktopSnapshot({
      slug: 'offline-page',
      ts: 1710000002600,
      url: 'https://example.com/offline',
      title: 'Offline Page',
      markdown: 'offline snapshot body',
      html: '<html><body>offline snapshot body</body></html>',
    });

    expect(store.desktopPendingEvents).toBe(3);
    expect(store.desktopEventBuffer).toHaveLength(3);

    child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.connectDesktopBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.pendingEvents === 0;
    });

    const dataRoot = path.join(dir, 'portal-data');
    const noteRaw = readFileSync(
      path.join(dataRoot, 'data', 'notes', 'offline-note.json'),
      'utf8',
    );
    expect(noteRaw).toContain('"excerpt": "offline highlight"');
    expect(noteRaw).toContain('"note": "offline note body"');

    const snapshotHtml = readFileSync(
      path.join(
        dataRoot,
        'data',
        'snapshots',
        'offline-page-1710000002600.html',
      ),
      'utf8',
    );
    expect(snapshotHtml).toContain('offline snapshot body');
    const snapshotMd = readFileSync(
      path.join(dataRoot, 'data', 'snapshots', 'offline-page-1710000002600.md'),
      'utf8',
    );
    expect(snapshotMd).toContain('offline snapshot body');

    const pageFiles = await readdir(path.join(dataRoot, 'pages'));
    const offlinePageRaw = readFileSync(
      path.join(
        dataRoot,
        'pages',
        pageFiles.find((name) => name !== undefined),
      ),
      'utf8',
    );
    expect(offlinePageRaw).toContain('"note:offline-note"');
    expect(offlinePageRaw).toContain('"snapshot:offline-page-1710000002600"');

    const logsDir = path.join(dataRoot, 'data', 'logs');
    const [deviceDir] = await readdir(logsDir);
    const [logFile] = await readdir(path.join(logsDir, deviceDir));
    const lines = readFileSync(path.join(logsDir, deviceDir, logFile), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.slice(-3).map((line) => line.action)).toEqual([
      'create_list',
      'create_note',
      'create_snapshot',
    ]);

    expect(store.desktopPendingEvents).toBe(0);
    expect(store.desktopEventBuffer).toEqual([]);
  }, 30_000);

  it('normalizes nullable buffered snapshot fields before flushing', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-buffer-null-snapshot-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    store.desktopEventBuffer = [
      {
        kind: 'snapshot',
        slug: 'nullable-snapshot-page',
        ts: 1710000002700,
        url: 'https://example.com/nullable-snapshot',
        title: null,
        markdown: null,
        html: null,
      },
    ];
    store.desktopPendingEvents = 1;
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.pendingEvents === 0;
    });

    const dataRoot = path.join(dir, 'portal-data');
    const snapshotHtml = readFileSync(
      path.join(
        dataRoot,
        'data',
        'snapshots',
        'nullable-snapshot-page-1710000002700.html',
      ),
      'utf8',
    );
    expect(snapshotHtml).toBe('');
    expect(store.desktopPendingEvents).toBe(0);
    expect(store.desktopEventBuffer).toEqual([]);
  }, 30_000);

  it('drops one invalid buffered event and continues flushing the queue', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-buffer-invalid-event-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    store.desktopEventBuffer = [
      {
        kind: 'event',
        entry: {
          timestamp: 1710000002800,
          action: 'visit_page',
          url: null,
          title: 'Poison event',
        },
      },
      {
        kind: 'event',
        entry: {
          timestamp: 1710000002810,
          action: 'create_list',
          listOwner: 'test-device',
          name: 'After Poison',
          listId: 'after-poison',
        },
      },
    ];
    store.desktopPendingEvents = 2;
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.pendingEvents === 0;
    });

    const dataRoot = path.join(dir, 'portal-data');
    const listRaw = readFileSync(
      path.join(dataRoot, 'lists', 'after-poison.json'),
      'utf8',
    );
    expect(listRaw).toContain('"name": "After Poison"');
    expect(store.desktopPendingEvents).toBe(0);
    expect(store.desktopEventBuffer).toEqual([]);
    expect(store.connectorState).toBe('connected');
  }, 30_000);

  it('keeps a daemon socket alive after a malformed connector frame', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-malformed-frame-'),
    );
    tempDirs.push(dir);

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    const port = await waitForListening(child);
    const socket = await openRawSocket(port);

    socket.send(
      JSON.stringify({
        type: 'pair_request',
        browserId: 'raw-browser',
        browserName: 'Raw Browser',
        extensionId: 'abcdefghijklmnop',
        browserProfile: 'Default profile',
      }),
    );
    expect(await nextRawJson(socket)).toMatchObject({ type: 'pair_pending' });
    expect(await nextRawJson(socket)).toMatchObject({ type: 'pair_approved' });

    socket.send(
      JSON.stringify({
        type: 'snapshot',
        slug: 'bad-snapshot',
        ts: 1710000002820,
        url: 'https://example.com/bad-snapshot',
        html: null,
        source: 'extension',
      }),
    );
    expect(await nextRawJson(socket)).toMatchObject({
      type: 'error',
      code: 'invalid_message',
    });

    socket.send(JSON.stringify({ type: 'get_status' }));
    expect(await nextRawJson(socket)).toMatchObject({
      type: 'status',
      deviceId: expect.any(String),
    });
    socket.close();
  }, 30_000);

  it('queues popup reads behind an in-flight note autosave request', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-popup-overlap-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });

    const url = 'https://example.com/popup-overlap';
    await wsClient.enqueueDesktopEvent({
      timestamp: 1710000002700,
      action: 'visit_page',
      url,
      title: 'Popup Overlap',
      checkpoint: true,
    });
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.pendingEvents === 0;
    });
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected';
    });

    BrowserLikeWebSocket.delayMessageMs = 250;
    BrowserLikeWebSocket.delayMessagePredicate = (data) => {
      try {
        return JSON.parse(data).type === 'ack';
      } catch {
        return false;
      }
    };

    await wsClient.enqueueDesktopNote({
      slug: 'popup-overlap-note',
      excerpt: null,
      note: 'Page note body',
      cssPath: null,
      url,
      title: 'Popup Overlap',
      ts: 1710000002800,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const summary = await wsClient.requestDesktopPageSummary(url);
    expect(summary).toMatchObject({
      type: 'page_summary_result',
      success: true,
      url,
    });
    expect(summary.page).toMatchObject({
      url,
      title: 'Popup Overlap',
    });
    expect(summary.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'popup-overlap-note',
          note: 'Page note body',
        }),
      ]),
    );

    expect(store.desktopPendingEvents).toBe(0);
  }, 30_000);

  it('reconnects immediately after an authenticated socket closes unexpectedly', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-socket-close-recover-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });

    const url = 'https://example.com/socket-close-recovery';
    await wsClient.enqueueDesktopEvent({
      timestamp: 1710000002900,
      action: 'visit_page',
      url,
      title: 'Socket Close Recovery',
      checkpoint: true,
    });
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.pendingEvents === 0;
    });

    const firstSocket =
      BrowserLikeWebSocket.instances[BrowserLikeWebSocket.instances.length - 1];
    firstSocket.close();

    const summary = await wsClient.requestDesktopPageSummary(url);
    expect(summary).toMatchObject({
      type: 'page_summary_result',
      success: true,
      url,
    });
    expect(summary.page).toMatchObject({
      url,
      title: 'Socket Close Recovery',
    });
    await waitFor(async () => {
      return BrowserLikeWebSocket.instances.length > 1;
    });
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.deviceId;
    });

    expect(BrowserLikeWebSocket.instances.length).toBeGreaterThan(1);
    expect(store.connectorState).toBe('connected');
  }, 30_000);

  it('recovers from offline state when the reconnect alarm fires after desktop restarts', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-alarm-recover-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store, alarms } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    let child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });

    child.kill('SIGINT');
    childProcesses.pop();
    await waitForExit(child);
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'offline';
    });
    expect(alarms.has('browserRecallConnectorReconnect')).toBe(true);

    child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await chrome.alarms._trigger('browserRecallConnectorReconnect');
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.deviceId;
    });

    expect(store.connectorState).toBe('connected');
    expect(store.connectorDataFolder).toContain('portal-data');
  }, 30_000);

  it('persists diagnostics when no desktop port is reachable', async () => {
    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    store.connectorDaemonPort = 28471;
    globalThis.chrome = chrome;
    globalThis.WebSocket = RefusingWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    await wsClient.initConnectorBridge();
    const state = await wsClient.getConnectorBridgeState();

    expect(state.state).toBe('offline');
    expect(state.lastDiagnostic).toMatchObject({
      code: 'no_ports_reachable',
    });
    expect(state.lastDiagnostic.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ port: 38472, code: 'connect_error' }),
      ]),
    );
    expect(RefusingWebSocket.urls).not.toEqual(
      expect.arrayContaining([
        'ws://127.0.0.1:28471',
        'ws://127.0.0.1:28472',
        'ws://127.0.0.1:28473',
      ]),
    );
  });

  it('keeps retrying a manual reconnect while desktop is still starting', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-manual-retry-recover-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    let child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });

    child.kill('SIGINT');
    childProcesses.pop();
    await waitForExit(child);
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'offline' && state.hasToken;
    });

    const restartPromise = new Promise((resolve, reject) => {
      originalSetTimeout(async () => {
        try {
          child = launchDaemon(dir, 'allow');
          childProcesses.push(child);
          store.connectorDaemonPort = await waitForListening(child);
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 100);
    });

    const state = await wsClient.connectDesktopBridge();
    await restartPromise;

    expect(state.state).toBe('connected');
    expect(state.deviceId).toBeTruthy();
    expect(store.connectorState).toBe('connected');
  }, 30_000);

  it('throws away a rejected cached token and pairs again during manual reconnect', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-stale-token-repair-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    store.connectorAuthToken = 'stale-token';
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    const state = await wsClient.connectDesktopBridge();

    expect(state.state).toBe('connected');
    expect(state.deviceId).toBeTruthy();
    expect(store.connectorAuthToken).toBeTruthy();
    expect(store.connectorAuthToken).not.toBe('stale-token');
    expect(store.connectorState).toBe('connected');
  }, 30_000);

  it('waits for a fresh Firefox pair approval during a state probe', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-firefox-state-probe-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Firefox/125.0' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);
    store.connectorState = 'offline';

    const state = await wsClient.refreshConnectorBridgeState();

    expect(state.state).toBe('connected');
    expect(state.deviceId).toBeTruthy();
    expect(state.hasToken).toBe(true);
    expect(store.connectorState).toBe('connected');
    expect(store.connectorAuthToken).toBeTruthy();
  }, 30_000);

  it('does not return stale offline while Firefox pair approval is in flight', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-firefox-stale-offline-probe-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    BrowserLikeWebSocket.delayMessageMs = 250;
    BrowserLikeWebSocket.delayMessagePredicate = (data) =>
      data.includes('"pair_approved"');
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Firefox/125.0' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    store.connectorState = 'offline';

    const state = await wsClient.refreshConnectorBridgeState(1000);

    expect(state.state).toBe('connected');
    expect(state.deviceId).toBeTruthy();
    expect(store.connectorState).toBe('connected');
    expect(store.connectorAuthToken).toBeTruthy();
  }, 30_000);

  it('replaces a stale authenticated socket when manual status refresh fails', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-stale-auth-socket-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });
    const initialSocketCount = BrowserLikeWebSocket.instances.length;

    BrowserLikeWebSocket.closeOnNextStatus = true;
    const state = await wsClient.connectDesktopBridge();

    expect(state.state).toBe('connected');
    expect(state.deviceId).toBeTruthy();
    expect(BrowserLikeWebSocket.instances.length).toBeGreaterThan(
      initialSocketCount,
    );
    expect(store.connectorState).toBe('connected');
  }, 30_000);

  it('times out a stale open socket and reconnects on manual refresh', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-stale-open-socket-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });
    const initialSocketCount = BrowserLikeWebSocket.instances.length;

    BrowserLikeWebSocket.hangOnNextStatus = true;
    const state = await wsClient.connectDesktopBridge();

    expect(state.state).toBe('connected');
    expect(state.deviceId).toBeTruthy();
    expect(BrowserLikeWebSocket.instances.length).toBeGreaterThan(
      initialSocketCount,
    );
    expect(store.connectorState).toBe('connected');
  }, 30_000);

  it('refreshes status on an already connected bridge without replacing the socket', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-refresh-no-replace-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });

    const socketCount = BrowserLikeWebSocket.instances.length;
    const state = await wsClient.connectDesktopBridge();

    expect(state.state).toBe('connected');
    expect(BrowserLikeWebSocket.instances).toHaveLength(socketCount);
    expect(store.connectorState).toBe('connected');
    expect(store.connectorDataFolder).toContain('portal-data');
  }, 30_000);
});
