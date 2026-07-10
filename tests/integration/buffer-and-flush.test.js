import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import NodeWebSocket from 'ws';
import { generateSlugFromUrl } from '../../packages/core/utils.js';
import {
  ensureTestDaemonBuilt,
  launchTestDaemon,
  stopTestDaemon,
  waitForDaemonListening as waitForListening,
} from './daemon-test-harness.js';

const TEST_PORTS = [38472, 38473];

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
  return launchTestDaemon(configDir, { ports: TEST_PORTS, approveMode });
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

async function readAllLogLines(logsDir) {
  const lines = [];
  for (const deviceDir of await readdir(logsDir)) {
    const devicePath = path.join(logsDir, deviceDir);
    for (const logFile of await readdir(devicePath)) {
      const raw = readFileSync(path.join(devicePath, logFile), 'utf8').trim();
      if (!raw) continue;
      lines.push(...raw.split('\n').map((line) => JSON.parse(line)));
    }
  }
  lines.sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));
  return lines;
}

function pagePath(dataRoot, url) {
  const slug = generateSlugFromUrl(url);
  const shard = createHash('sha256').update(slug).digest('hex').slice(0, 2);
  return path.join(dataRoot, 'views', 'pages', shard, `${slug}.json`);
}

async function listFilesRecursive(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
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
        sendMessage: vi.fn(async () => undefined),
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
  static simulateLegacyProtocol = false;
  static sendMismatchedProtocol = false;
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
        let data = args[0].toString();
        if (BrowserLikeWebSocket.simulateLegacyProtocol) {
          const payload = JSON.parse(data);
          if (payload.type === 'pair_approved' || payload.type === 'auth_ok') {
            delete payload.protocolVersion;
            data = JSON.stringify(payload);
          }
        }
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
      if (
        BrowserLikeWebSocket.sendMismatchedProtocol &&
        (message.type === 'auth' || message.type === 'pair_request')
      ) {
        message.protocolVersion = 2;
        this.socket.send(JSON.stringify(message));
        return;
      }
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

  beforeAll(() => ensureTestDaemonBuilt(), 300_000);

  beforeEach(() => {
    originalConnectorPorts = globalThis.__BROWSER_RECALL_CONNECTOR_PORTS;
    globalThis.__BROWSER_RECALL_CONNECTOR_PORTS = TEST_PORTS;
  });

  afterEach(async () => {
    for (const child of childProcesses.splice(0)) {
      await stopTestDaemon(child);
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
    BrowserLikeWebSocket.simulateLegacyProtocol = false;
    BrowserLikeWebSocket.sendMismatchedProtocol = false;
    BrowserLikeWebSocket.instances = [];
    RefusingWebSocket.urls = [];

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an incompatible desktop instead of authenticating silently', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-incompatible-protocol-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    BrowserLikeWebSocket.simulateLegacyProtocol = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);
    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    await wsClient.initConnectorBridge();
    await waitFor(() => store.connectorState === 'incompatible');

    expect(store.connectorLastErrorCode).toBe('incompatible_protocol');
    expect(store.connectorAuthToken).toBeUndefined();
    expect(store.connectorLastDiagnostic).toMatchObject({
      code: 'incompatible_protocol',
      expected: 1,
      actual: null,
    });

    const manualState = await Promise.race([
      wsClient.connectDesktopBridge(),
      new Promise((_, reject) => {
        originalSetTimeout(
          () =>
            reject(
              new Error('manual reconnect did not return incompatibility'),
            ),
          2000,
        );
      }),
    ]);
    expect(manualState.state).toBe('incompatible');
    expect(manualState.lastErrorCode).toBe('incompatible_protocol');
  }, 30_000);

  it('reports an explicit daemon protocol rejection as incompatible', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-daemon-protocol-rejection-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    BrowserLikeWebSocket.sendMismatchedProtocol = true;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);
    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');

    await wsClient.initConnectorBridge();
    await waitFor(() => store.connectorState === 'incompatible');

    expect(store.connectorLastErrorCode).toBe('incompatible_protocol');
    expect(store.connectorAuthToken).toBeUndefined();
    expect(store.connectorLastDiagnostic).toMatchObject({
      code: 'incompatible_protocol',
      expected: 1,
    });
  }, 30_000);

  it('queues connector commands while offline and flushes them in order after reconnect', async () => {
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

    const queuedCommands = [
      {
        action: 'reportVisit',
        request: {
          timestamp: 1710000002100,
          url: 'https://example.com/queued',
          title: 'Queued Page',
        },
      },
      {
        action: 'saveSettingsKey',
        request: {
          key: 'theme',
          value: 'sepia',
        },
      },
      {
        action: 'reportLeave',
        request: {
          timestamp: 1710000002300,
          url: 'https://example.com/queued',
          title: 'Queued Page',
          timeOnPage: 42,
        },
      },
    ];

    for (const command of queuedCommands) {
      await wsClient.enqueueDesktopCommand(command.action, command.request);
    }

    expect(store.desktopPendingCommands).toBe(3);
    expect(store.desktopCommandBuffer).toHaveLength(3);

    child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.connectDesktopBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.pendingCommands === 0;
    });

    const dataRoot = path.join(dir, 'portal-data');
    const settingsRaw = readFileSync(
      path.join(dataRoot, 'views', 'manifest', 'settings.json'),
      'utf8',
    );
    expect(settingsRaw).toContain('"theme": "sepia"');

    const logsDir = path.join(dataRoot, 'logs');
    const lines = await readAllLogLines(logsDir);
    expect(
      lines
        .map((line) => line.action)
        .filter((action) => action === 'visit_page' || action === 'leave_page'),
    ).toEqual(['visit_page', 'leave_page']);

    expect(store.desktopPendingCommands).toBe(0);
    expect(store.desktopCommandBuffer).toEqual([]);
  }, 30_000);

  it('flushes queued commands and notes in FIFO order after reconnect', async () => {
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

    const rawOfflineUrl = 'https://example.com/offline?_spm_id=x&keep=1&_i=a,b';
    const canonicalOfflineUrl = 'https://example.com/offline?keep=1';
    await wsClient.enqueueDesktopCommand('reportVisit', {
      timestamp: 1710000002400,
      url: rawOfflineUrl,
      title: 'Offline Page',
    });
    await wsClient.enqueueDesktopCommand('createNote', {
      excerpt: ['offline highlight'],
      note: 'offline note body',
      cssPath: null,
      url: rawOfflineUrl,
      title: 'Offline Page',
    });
    expect(store.desktopPendingCommands).toBe(2);
    expect(store.desktopCommandBuffer).toHaveLength(2);
    expect(store.desktopCommandBuffer[0].request.url).toBe(canonicalOfflineUrl);
    expect(store.desktopCommandBuffer[1].request.url).toBe(canonicalOfflineUrl);

    child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.connectDesktopBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.pendingCommands === 0;
    });

    const dataRoot = path.join(dir, 'portal-data');
    const noteFiles = await readdir(path.join(dataRoot, 'objects', 'notes'));
    const noteRaw = readFileSync(
      path.join(dataRoot, 'objects', 'notes', noteFiles[0]),
      'utf8',
    );
    expect(noteRaw).toContain('"excerpt": [');
    expect(noteRaw).toContain('"offline highlight"');
    expect(noteRaw).toContain('"note": "offline note body"');

    const offlinePageRaw = readFileSync(
      pagePath(dataRoot, canonicalOfflineUrl),
      'utf8',
    );
    expect(offlinePageRaw).toContain('"note:');

    const logsDir = path.join(dataRoot, 'logs');
    const lines = await readAllLogLines(logsDir);
    expect(
      lines
        .map((line) => line.action)
        .filter(
          (action) => action === 'visit_page' || action === 'create_note',
        ),
    ).toEqual(['visit_page', 'create_note']);

    expect(store.desktopPendingCommands).toBe(0);
    expect(store.desktopCommandBuffer).toEqual([]);
  }, 30_000);

  it('sends large connected snapshots directly without storing them in chrome.storage.local', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-large-snapshot-direct-'),
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

    const largeBody = 'large snapshot body '.repeat(512 * 1024);
    await wsClient.enqueueDesktopSnapshot({
      slug: 'large-snapshot-page',
      ts: 1710000002700,
      url: 'https://example.com/large-snapshot',
      title: 'Large Snapshot Page',
      markdown: 'large snapshot markdown',
      html: `<html><body>${largeBody}</body></html>`,
    });

    expect(store.desktopPendingCommands).toBe(0);
    expect(store.desktopCommandBuffer || []).toEqual([]);

    const dataRoot = path.join(dir, 'portal-data');
    const snapshotFiles = await listFilesRecursive(
      path.join(dataRoot, 'objects', 'snapshots'),
    );
    const snapshotPath = snapshotFiles.find((file) =>
      file.endsWith('large-snapshot-page-1710000002700.html'),
    );
    expect(snapshotPath).toBeTruthy();
    expect(statSync(snapshotPath).size).toBeGreaterThan(8 * 1024 * 1024);
    expect(readFileSync(snapshotPath, 'utf8')).toContain('large snapshot body');
  }, 30_000);

  it('drops one unknown buffered command item and continues flushing the queue', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-buffer-invalid-event-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    store.desktopCommandBuffer = [
      {
        kind: 'unknown',
        request: {
          title: 'Poison command',
        },
      },
      {
        kind: 'command',
        action: 'saveSettingsKey',
        request: {
          key: 'theme',
          value: 'after-poison',
        },
      },
    ];
    store.desktopPendingCommands = 2;
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
      return state.state === 'connected' && state.pendingCommands === 0;
    });

    const dataRoot = path.join(dir, 'portal-data');
    const settingsRaw = readFileSync(
      path.join(dataRoot, 'views', 'manifest', 'settings.json'),
      'utf8',
    );
    expect(settingsRaw).toContain('"theme": "after-poison"');
    expect(store.desktopPendingCommands).toBe(0);
    expect(store.desktopCommandBuffer).toEqual([]);
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
        protocolVersion: 1,
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
    await wsClient.enqueueDesktopCommand('reportVisit', {
      timestamp: 1710000002700,
      url,
      title: 'Popup Overlap',
    });
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.pendingCommands === 0;
    });
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected';
    });

    BrowserLikeWebSocket.delayMessageMs = 250;
    BrowserLikeWebSocket.delayMessagePredicate = (data) => {
      try {
        return JSON.parse(data).type === 'run_command';
      } catch {
        return false;
      }
    };

    await wsClient.enqueueDesktopCommand('createNote', {
      excerpt: null,
      note: 'Page note body',
      cssPath: null,
      url,
      title: 'Popup Overlap',
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
          note: 'Page note body',
        }),
      ]),
    );

    expect(store.desktopPendingCommands).toBe(0);
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
    await wsClient.enqueueDesktopCommand('reportVisit', {
      timestamp: 1710000002900,
      url,
      title: 'Socket Close Recovery',
    });
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.pendingCommands === 0;
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

  it('reconnects instead of trusting status from a socket that closes', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-status-close-race-'),
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

    const setStorage = chrome.storage.local.set;
    let closeDuringConnectedWrite = true;
    chrome.storage.local.set = async (values) => {
      if (closeDuringConnectedWrite && values.connectorState === 'connected') {
        closeDuringConnectedWrite = false;
        BrowserLikeWebSocket.instances.at(-1).socket.close();
        await waitFor(
          () =>
            BrowserLikeWebSocket.instances.length > 1 &&
            BrowserLikeWebSocket.instances.at(-1)._authenticated,
        );
      }
      await setStorage(values);
    };
    store.connectorState = 'offline';
    const state = await wsClient.refreshConnectorBridgeState(250);

    expect(state.state).toBe('connected');
    expect(BrowserLikeWebSocket.instances).toHaveLength(2);
  }, 30_000);

  it('preserves a paused connector state after a successful status refresh', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-status-preserves-pause-'),
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

    store.connectorState = 'paused';
    store.connectorLastError = 'Replay storage failed';
    store.connectorLastErrorCode = 'replay_error';
    await wsClient.getConnectorBridgeState();

    const state = await wsClient.refreshConnectorBridgeState();

    expect(state).toMatchObject({
      state: 'paused',
      lastError: 'Replay storage failed',
      lastErrorCode: 'replay_error',
    });
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

  it('rebroadcasts daemon change messages as extension mutations', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-change-broadcast-'),
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

    const clientSocket = BrowserLikeWebSocket.instances.find(
      (socket) => socket.readyState === NodeWebSocket.OPEN,
    );
    expect(clientSocket).toBeTruthy();

    clientSocket.socket.emit(
      'message',
      JSON.stringify({
        type: 'change',
        mutations: [
          { type: 'history', url: 'https://example.com/change' },
          {
            type: 'note',
            pageSlug: 'change',
            noteSlug: 'change-note',
          },
        ],
      }),
    );

    await waitFor(() => chrome.runtime.sendMessage.mock.calls.length >= 2);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'mutation',
      type: 'history',
      url: 'https://example.com/change',
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'mutation',
      type: 'note',
      pageSlug: 'change',
      noteSlug: 'change-note',
    });
  }, 30_000);
});
