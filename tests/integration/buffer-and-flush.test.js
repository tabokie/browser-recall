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
  static omitProtocolVersion = false;
  static sendMismatchedProtocol = false;
  static statusMaxMessageBytes = null;
  static statusAuthority = null;
  static sentMessages = [];
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
        if (BrowserLikeWebSocket.omitProtocolVersion) {
          const payload = JSON.parse(data);
          if (payload.type === 'pair_approved' || payload.type === 'auth_ok') {
            delete payload.protocolVersion;
            data = JSON.stringify(payload);
          }
        }
        if (BrowserLikeWebSocket.statusMaxMessageBytes != null) {
          const payload = JSON.parse(data);
          if (payload.type === 'status') {
            payload.maxMessageBytes =
              BrowserLikeWebSocket.statusMaxMessageBytes;
            data = JSON.stringify(payload);
          }
        }
        if (BrowserLikeWebSocket.statusAuthority != null) {
          const payload = JSON.parse(data);
          if (payload.type === 'status') {
            payload.authority = BrowserLikeWebSocket.statusAuthority;
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
      BrowserLikeWebSocket.sentMessages.push(message);
      if (
        BrowserLikeWebSocket.sendMismatchedProtocol &&
        (message.type === 'auth' || message.type === 'pair_request')
      ) {
        message.protocolVersion = 1;
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
    BrowserLikeWebSocket.omitProtocolVersion = false;
    BrowserLikeWebSocket.sendMismatchedProtocol = false;
    BrowserLikeWebSocket.statusMaxMessageBytes = null;
    BrowserLikeWebSocket.statusAuthority = null;
    BrowserLikeWebSocket.sentMessages = [];
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
    BrowserLikeWebSocket.omitProtocolVersion = true;
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

    expect(store.connectorAuthToken).toBeUndefined();
    expect(store.connectorLastDiagnostic).toMatchObject({
      code: 'incompatible_protocol',
      expected: 4,
      actual: null,
    });

    BrowserLikeWebSocket.delayMessageMs = 100;
    BrowserLikeWebSocket.delayMessagePredicate = (data) =>
      JSON.parse(data).type === 'pair_approved';
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
    expect(manualState.connection.failure).toMatchObject({
      code: 'incompatible_protocol',
    });
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

    expect(store.connectorAuthToken).toBeUndefined();
    expect(store.connectorLastDiagnostic).toMatchObject({
      code: 'incompatible_protocol',
      expected: 4,
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
          referrer: null,
          bodyPreview: null,
          bypassBlacklist: false,
        },
      },
      {
        action: 'saveSettingsKey',
        request: {
          key: 'theme',
          value: 'dark',
        },
      },
      {
        action: 'reportLeave',
        request: {
          timestamp: 1710000002300,
          url: 'https://example.com/queued',
          title: 'Queued Page',
          scrollDepth: null,
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

    const dataRoot = path.join(dir, 'browser-data');
    const settingsResponse = await wsClient.requestDesktopSettings();
    expect(settingsResponse.settings.theme).toBe('dark');
    await expect(
      wsClient.requestDesktopCommand('saveSettingsKey', {
        key: 'theme',
        value: 'light',
      }),
    ).resolves.toMatchObject({ success: true });
    const directSettingsResponse = await wsClient.requestDesktopSettings();
    expect(directSettingsResponse.settings.theme).toBe('light');

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
      referrer: null,
      bodyPreview: null,
      bypassBlacklist: false,
    });
    await wsClient.enqueueDesktopCommand('createNote', {
      excerpt: ['offline highlight'],
      note: 'offline note body',
      cssPath: [''],
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

    const dataRoot = path.join(dir, 'browser-data');
    const noteFiles = await waitFor(async () => {
      const files = await readdir(path.join(dataRoot, 'objects', 'notes'));
      return files.length > 0 ? files : null;
    });
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
      title: null,
      markdown: null,
      html: `<html><body>${largeBody}</body></html>`,
    });

    expect(store.desktopPendingCommands).toBe(0);
    expect(store.desktopCommandBuffer || []).toEqual([]);

    const dataRoot = path.join(dir, 'browser-data');
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

  it('waits for authenticated desktop status before calculating the snapshot capture budget', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-snapshot-budget-auth-status-'),
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

    BrowserLikeWebSocket.delayMessageMs = 250;
    BrowserLikeWebSocket.delayMessagePredicate = (data) =>
      JSON.parse(data).type === 'status';
    await wsClient.restartConnectorRuntimeForTest();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.connection.phase === 'synchronizing';
    });
    let budgetSettled = false;
    const budgetPromise = wsClient
      .requestDesktopSnapshotCaptureBudget({
        slug: 'status-race-snapshot-page',
        ts: 1710000002725,
        url: 'https://example.com/status-race-snapshot',
        title: null,
        markdown: null,
      })
      .finally(() => {
        budgetSettled = true;
      });
    await new Promise((resolve) => originalSetTimeout(resolve, 50));
    expect(budgetSettled).toBe(false);
    const budget = await budgetPromise;

    expect(budget.maxEncodedHtmlBytes).toBeGreaterThan(0);
    expect(budget.maxConcurrentResourceLoads).toBe(6);
    expect((await wsClient.getConnectorBridgeState()).connection).toMatchObject(
      { phase: 'ready', authority: { state: 'running' } },
    );
  }, 30_000);

  it('waits for status-task publication after authentication', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-snapshot-status-publication-'),
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

    let releaseStatusPublication;
    const statusPublicationGate = new Promise((resolve) => {
      releaseStatusPublication = resolve;
    });
    let statusPublicationBlocked = false;
    let connectingStateWrites = 0;
    const setStorage = chrome.storage.local.set;
    chrome.storage.local.set = async (values) => {
      if (values.connectorState === 'connecting') connectingStateWrites += 1;
      if (
        !statusPublicationBlocked &&
        values.connectorState === 'connecting' &&
        connectingStateWrites === 2
      ) {
        statusPublicationBlocked = true;
        await statusPublicationGate;
      }
      await setStorage(values);
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(() => statusPublicationBlocked);

    const budgetOutcome = wsClient
      .requestDesktopSnapshotCaptureBudget({
        slug: 'status-publication-snapshot',
        ts: 1710000002726,
        url: 'https://example.com/status-publication-snapshot',
        title: null,
        markdown: null,
      })
      .then(
        (value) => ({ status: 'resolved', value }),
        (error) => ({ status: 'rejected', error }),
      );
    const earlyOutcome = await Promise.race([
      budgetOutcome,
      new Promise((resolve) =>
        originalSetTimeout(() => resolve({ status: 'pending' }), 50),
      ),
    ]);
    releaseStatusPublication();

    expect(earlyOutcome).toEqual({ status: 'pending' });
    const outcome = await budgetOutcome;
    expect(outcome.status).toBe('resolved');
    expect(outcome.value.maxEncodedHtmlBytes).toBeGreaterThan(0);
  }, 30_000);

  it('does not let a replaced authentication callback publish state or credentials', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-replaced-auth-callback-'),
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

    let releaseFirstDiagnosticClear;
    const firstDiagnosticClearReleased = new Promise((resolve) => {
      releaseFirstDiagnosticClear = resolve;
    });
    let signalFirstDiagnosticClear;
    const firstDiagnosticClearStarted = new Promise((resolve) => {
      signalFirstDiagnosticClear = resolve;
    });
    const removeStorage = chrome.storage.local.remove.bind(
      chrome.storage.local,
    );
    let blockFirstDiagnosticClear = true;
    chrome.storage.local.remove = async (keys) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      if (
        blockFirstDiagnosticClear &&
        keyList.includes('connectorLastDiagnostic')
      ) {
        blockFirstDiagnosticClear = false;
        signalFirstDiagnosticClear();
        await firstDiagnosticClearReleased;
      }
      return removeStorage(keys);
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await firstDiagnosticClearStarted;
    const restartPromise = wsClient.restartConnectorRuntimeForTest();
    releaseFirstDiagnosticClear();
    await restartPromise;
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.connection.phase === 'ready' && state.hasToken;
    });
    const replacementToken = store.connectorAuthToken;

    await new Promise((resolve) => originalSetTimeout(resolve, 100));

    const state = await wsClient.getConnectorBridgeState();
    expect(state.connection).toMatchObject({
      phase: 'ready',
      authority: { state: 'running' },
    });
    expect(store.connectorAuthToken).toBe(replacementToken);
  }, 30_000);

  it('keeps an old drain failure out of a replacement session', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-replaced-drain-task-'),
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
      return state.connection.phase === 'ready' && state.hasToken;
    });

    const setStorage = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (values) => {
      if (values.connectorLastDiagnostic?.code === 'buffer_flush_failed') {
        await new Promise((resolve) => originalSetTimeout(resolve, 300));
      }
      return setStorage(values);
    };
    BrowserLikeWebSocket.delayMessageMs = 500;
    BrowserLikeWebSocket.delayMessagePredicate = (data) =>
      JSON.parse(data).type === 'command_result';

    await wsClient.enqueueDesktopCommand('saveSettingsKey', {
      key: 'theme',
      value: 'dark',
    });
    await waitFor(() =>
      BrowserLikeWebSocket.sentMessages.some(
        (message) => message.type === 'run_command',
      ),
    );
    const firstSocketCount = BrowserLikeWebSocket.instances.length;
    BrowserLikeWebSocket.instances.at(-1).close();

    await waitFor(
      () => BrowserLikeWebSocket.instances.length > firstSocketCount,
    );
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.connection.phase === 'ready' && state.pendingCommands === 0;
    });

    expect((await wsClient.requestDesktopSettings()).settings.theme).toBe(
      'dark',
    );
  }, 30_000);

  it('rejects a snapshot whose encoded message exceeds the daemon-advertised limit', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-oversized-snapshot-preflight-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    BrowserLikeWebSocket.statusMaxMessageBytes = 512;
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

    await expect(
      wsClient.enqueueDesktopSnapshot({
        slug: 'oversized-snapshot-page',
        ts: 1710000002750,
        url: 'https://example.com/oversized-snapshot',
        title: null,
        markdown: null,
        html: `<html><body>${'x'.repeat(1024)}</body></html>`,
      }),
    ).rejects.toMatchObject({
      code: 'snapshot_message_too_large',
      message: expect.stringContaining('512-byte desktop message limit'),
    });

    expect(store.desktopPendingCommands).toBe(0);
    expect(store.desktopCommandBuffer || []).toEqual([]);
  }, 30_000);

  it('preserves an unknown buffered item and pauses instead of losing queued data', async () => {
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
      return state.state === 'paused';
    });

    const dataRoot = path.join(dir, 'browser-data');
    const settings = JSON.parse(
      readFileSync(
        path.join(dataRoot, 'views', 'manifest', 'settings.json'),
        'utf8',
      ),
    );
    expect(settings.theme).toBe('light');
    expect(store.desktopPendingCommands).toBe(2);
    expect(store.desktopCommandBuffer).toHaveLength(2);
    expect(store.desktopCommandBuffer[0].kind).toBe('unknown');
    expect(store.connectorState).toBe('paused');
    expect(store.connectorLastDiagnostic).toMatchObject({
      code: 'invalid_buffer_item',
    });
  }, 30_000);

  it('does not let a running status erase a post-ready blocked outbox', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-ready-buffer-invalid-'),
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
    const { enqueueBufferedMessage } =
      await import('../../apps/extension/connector/command-buffer.js');
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await wsClient.initConnectorBridge();
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.state === 'connected' && state.hasToken;
    });
    await enqueueBufferedMessage({ kind: 'unknown', request: {} });

    const state = await wsClient.flushDesktopBuffer();

    expect(state.state).toBe('paused');
    expect(state.pendingCommands).toBe(1);
    expect(state.connection.failure).toMatchObject({
      code: 'invalid_buffer_item',
    });
    expect(state.lastDiagnostic).toMatchObject({
      code: 'invalid_buffer_item',
    });

    const refreshed = await wsClient.refreshConnectorBridgeState();
    expect(refreshed.state).toBe('paused');
    expect(refreshed.connection.failure).toMatchObject({
      code: 'invalid_buffer_item',
    });
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
        protocolVersion: 4,
        browserId: 'raw-browser',
        browserName: 'Chrome',
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
      referrer: null,
      bodyPreview: null,
      bypassBlacklist: false,
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
      excerpt: ['Popup overlap highlight'],
      note: 'Highlight note body',
      cssPath: ['body'],
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
          note: 'Highlight note body',
        }),
      ]),
    );

    expect(store.desktopPendingCommands).toBe(0);
  }, 30_000);

  it('reconnects with cached credentials and refreshes a formerly misidentified Orion browser', async () => {
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
      referrer: null,
      bodyPreview: null,
      bypassBlacklist: false,
    });
    await waitFor(async () => {
      const state = await wsClient.getConnectorBridgeState();
      return state.pendingCommands === 0;
    });

    const originalToken = store.connectorAuthToken;
    expect(
      JSON.parse(readFileSync(path.join(dir, 'config.json'))).connectors[0]
        .browser_name,
    ).toBe('Chrome');
    // Orion can expose a Chrome user agent until its identifying signal is visible.
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36 Orion/1.0' },
      configurable: true,
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
    expect(store.connectorAuthToken).toBe(originalToken);
    expect(
      JSON.parse(readFileSync(path.join(dir, 'config.json'))).connectors[0],
    ).toMatchObject({
      browser_name: 'Orion',
      token: originalToken,
    });
    expect(
      BrowserLikeWebSocket.sentMessages.filter(
        (message) => message.type === 'pair_request',
      ),
    ).toHaveLength(1);
    expect(BrowserLikeWebSocket.sentMessages).toContainEqual({
      type: 'auth',
      protocolVersion: 4,
      token: originalToken,
      browserName: 'Orion',
    });
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
        await new Promise((resolve) => originalSetTimeout(resolve, 50));
      }
      await setStorage(values);
    };
    store.connectorState = 'offline';
    const state = await wsClient.refreshConnectorBridgeState(250);

    expect(state.state).toBe('connected');
    expect(BrowserLikeWebSocket.instances).toHaveLength(2);
  }, 30_000);

  it('replaces stale local pause state with desktop authority on refresh', async () => {
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
    await wsClient.getConnectorBridgeState();

    const state = await wsClient.refreshConnectorBridgeState();

    expect(state).toMatchObject({
      state: 'connected',
      lastError: null,
      connection: { phase: 'ready', authority: { state: 'running' } },
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

  it('pauses with a diagnostic when the persisted desktop port is invalid', async () => {
    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store, alarms } = createChromeMock();
    store.connectorDaemonPort = '28471';
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

    expect(state.state).toBe('paused');
    expect(state.lastError).toBe(
      'Stored connector port must be an integer from 1 to 65535',
    );
    expect(state.connection.failure).toMatchObject({
      code: 'invalid_connector_port',
    });
    expect(state.lastDiagnostic).toMatchObject({
      code: 'invalid_connector_configuration',
      errorCode: 'invalid_connector_port',
    });
    expect(RefusingWebSocket.urls).toEqual([]);
    expect(alarms.has('browserRecallConnectorReconnect')).toBe(false);
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

  it('rejects when the final state refresh after a connection wait fails', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-state-wait-refresh-failure-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    BrowserLikeWebSocket.delayMessageMs = 3000;
    BrowserLikeWebSocket.delayMessagePredicate = (data) =>
      JSON.parse(data).type === 'pair_approved';
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Chrome/123.0.0.0 Safari/537.36' },
      configurable: true,
    });
    globalThis.setTimeout = (fn, delay, ...args) => {
      const timer = originalSetTimeout(fn, delay, ...args);
      timer?.unref?.();
      return timer;
    };

    const readStorage = chrome.storage.local.get.bind(chrome.storage.local);
    let connectorStateReadCount = 0;
    chrome.storage.local.get = async (keys) => {
      if (Array.isArray(keys) && keys.includes('connectorState')) {
        connectorStateReadCount += 1;
        if (connectorStateReadCount === 2) {
          throw new Error('connector state storage unavailable');
        }
      }
      return readStorage(keys);
    };

    const wsClient =
      await import('../../apps/extension/connector/ws-client.js');
    const child = launchDaemon(dir, 'allow');
    childProcesses.push(child);
    store.connectorDaemonPort = await waitForListening(child);

    await expect(wsClient.connectDesktopBridge()).rejects.toThrow(
      'connector state storage unavailable',
    );
  }, 30_000);

  it('does not drain queued commands while desktop authority is paused', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-paused-authority-no-drain-'),
    );
    tempDirs.push(dir);

    originalWebSocket = globalThis.WebSocket;
    originalChrome = globalThis.chrome;
    originalNavigator = globalThis.navigator;
    originalSetTimeout = globalThis.setTimeout;

    const { chrome, store } = createChromeMock();
    store.desktopCommandBuffer = [
      {
        kind: 'command',
        action: 'saveSettingsKey',
        request: { key: 'theme', value: 'dark' },
      },
    ];
    store.desktopPendingCommands = 1;
    globalThis.chrome = chrome;
    globalThis.WebSocket = BrowserLikeWebSocket;
    BrowserLikeWebSocket.statusAuthority = {
      state: 'paused',
      code: 'fs_error',
      message: 'Desktop storage is unavailable',
    };
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
      return state.connection.authority?.state === 'paused';
    });
    const runCommandsBeforeRefresh = BrowserLikeWebSocket.sentMessages.filter(
      (message) => message.type === 'run_command',
    ).length;

    const state = await wsClient.refreshConnectorBridgeState();
    await new Promise((resolve) => originalSetTimeout(resolve, 100));

    expect(state.connection.authority).toMatchObject({ state: 'paused' });
    expect(state.pendingCommands).toBe(1);
    expect(
      BrowserLikeWebSocket.sentMessages.filter(
        (message) => message.type === 'run_command',
      ),
    ).toHaveLength(runCommandsBeforeRefresh);
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

  it('replaces a stale authenticated socket when a passive status probe fails', async () => {
    const dir = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-passive-stale-auth-socket-'),
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
    const state = await wsClient.refreshConnectorBridgeState(5_000);

    expect(state.state).toBe('connected');
    expect(BrowserLikeWebSocket.instances.length).toBeGreaterThan(
      initialSocketCount,
    );
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
          {
            type: 'history',
            url: 'https://example.com/change',
            urls: null,
            futureTraceId: 'compatible-additive-field',
          },
          {
            type: 'note',
            url: null,
            urls: null,
          },
        ],
      }),
    );

    await waitFor(() => chrome.runtime.sendMessage.mock.calls.length >= 2);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'mutation',
      type: 'history',
      url: 'https://example.com/change',
      urls: null,
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'mutation',
      type: 'note',
      url: null,
      urls: null,
    });
  }, 30_000);
});
