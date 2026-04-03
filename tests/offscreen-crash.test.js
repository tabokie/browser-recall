/**
 * Offscreen crash recovery tests.
 *
 * Verifies that when the offscreen port disconnects:
 *   - All pending requestOffscreen() calls are resolved with an error
 *   - portCallbacks Map is cleaned up (no leaked promises)
 *   - Reconnection works on next ensureOffscreenPort() call
 *   - Drain resumes after reconnect
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Extract port channel logic from background.js for unit testing.
// ---------------------------------------------------------------------------

function createPortChannel({ nowFn } = {}) {
  let offscreenPort = null;
  let portCallId = 0;
  const portCallbacks = new Map();
  let drainScheduled = false;

  // Mock: tracks calls to setupOffscreenDocument
  const setupCalls = [];

  // Crash-loop detection
  const CRASH_LOOP_THRESHOLD = 3;
  const CRASH_LOOP_WINDOW_MS = 60_000;
  const offscreenDisconnects = [];
  let pauseServiceCalls = [];

  const _now = nowFn || (() => Date.now());

  function trackOffscreenDisconnect() {
    const now = _now();
    offscreenDisconnects.push(now);
    // Prune old entries
    while (offscreenDisconnects.length && offscreenDisconnects[0] < now - CRASH_LOOP_WINDOW_MS) {
      offscreenDisconnects.shift();
    }
    if (offscreenDisconnects.length >= CRASH_LOOP_THRESHOLD) {
      pauseServiceCalls.push({ code: 'offscreen_crash', message: `Storage worker crashed ${CRASH_LOOP_THRESHOLD} times in ${CRASH_LOOP_WINDOW_MS / 1000}s` });
    }
  }

  function createMockPort() {
    const listeners = { message: [], disconnect: [] };
    return {
      postMessage: vi.fn(),
      onMessage: { addListener(fn) { listeners.message.push(fn); } },
      onDisconnect: { addListener(fn) { listeners.disconnect.push(fn); } },
      // Test helpers
      _fireMessage(msg) { listeners.message.forEach(fn => fn(msg)); },
      _fireDisconnect() { listeners.disconnect.forEach(fn => fn()); },
    };
  }

  function handleOffscreenResponse(msg) {
    const cb = portCallbacks.get(msg.id);
    if (cb) {
      portCallbacks.delete(msg.id);
      cb(msg);
    }
  }

  function connectToOffscreen() {
    offscreenPort = createMockPort();
    offscreenPort.onMessage.addListener(handleOffscreenResponse);
    offscreenPort.onDisconnect.addListener(() => {
      offscreenPort = null;
      // Reject all pending callbacks
      for (const [id, cb] of portCallbacks) {
        cb({ success: false, error: 'Offscreen port disconnected' });
      }
      portCallbacks.clear();
      trackOffscreenDisconnect();
    });
    drainScheduled = true; // mirrors scheduleDrainNotify()
  }

  async function setupOffscreenDocument() {
    setupCalls.push(Date.now());
  }

  async function ensureOffscreenPort() {
    if (offscreenPort) return;
    await setupOffscreenDocument();
    connectToOffscreen();
  }

  async function requestOffscreen(params) {
    await ensureOffscreenPort();
    const port = offscreenPort; // capture ref before any async gap
    return new Promise((resolve) => {
      const id = ++portCallId;
      portCallbacks.set(id, resolve);
      port.postMessage({ id, ...params });
    });
  }

  return {
    connectToOffscreen,
    ensureOffscreenPort,
    requestOffscreen,
    get port() { return offscreenPort; },
    get portCallbacks() { return portCallbacks; },
    get setupCalls() { return setupCalls; },
    get drainScheduled() { return drainScheduled; },
    resetDrainFlag() { drainScheduled = false; },
    get pauseServiceCalls() { return pauseServiceCalls; },
    get offscreenDisconnects() { return offscreenDisconnects; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Offscreen crash recovery', () => {
  let channel;

  beforeEach(() => {
    channel = createPortChannel();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pending requestOffscreen resolves with error when port disconnects', async () => {
    channel.connectToOffscreen();
    const port = channel.port;

    // Start a request — will be pending (no response yet)
    const promise = channel.requestOffscreen({ action: 'loadSettings' });
    // Flush microtasks so requestOffscreen reaches postMessage and registers callback
    await Promise.resolve();

    expect(channel.portCallbacks.size).toBe(1);

    // Simulate offscreen crash
    port._fireDisconnect();

    // Promise should resolve with error response (not hang forever)
    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('disconnected');
  });

  it('all pending callbacks are resolved on disconnect', async () => {
    channel.connectToOffscreen();
    const port = channel.port;

    // Issue 3 concurrent requests
    const p1 = channel.requestOffscreen({ action: 'loadSettings' });
    const p2 = channel.requestOffscreen({ action: 'loadPage', slug: 'test' });
    const p3 = channel.requestOffscreen({ action: 'listHistoryFiles' });
    // Flush microtasks so all 3 reach postMessage
    await Promise.resolve();

    expect(channel.portCallbacks.size).toBe(3);

    // Crash
    port._fireDisconnect();

    // All 3 should resolve with error
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
    expect(r3.success).toBe(false);

    // portCallbacks should be empty
    expect(channel.portCallbacks.size).toBe(0);
  });

  it('reconnection succeeds on next ensureOffscreenPort call', async () => {
    channel.connectToOffscreen();
    const port = channel.port;

    // Crash
    port._fireDisconnect();
    expect(channel.port).toBeNull();

    // Reconnect
    await channel.ensureOffscreenPort();

    // Should have called setupOffscreenDocument
    expect(channel.setupCalls.length).toBe(1);
    // Port should be re-created
    expect(channel.port).not.toBeNull();

    // New request should work — start it and wait for postMessage to be called
    const promise = channel.requestOffscreen({ action: 'loadSettings' });
    // Flush microtask chain: ensureOffscreenPort (2 awaits) + promise setup
    await new Promise(r => setTimeout(r, 0));

    const newPort = channel.port;
    expect(newPort.postMessage).toHaveBeenCalledTimes(1);
    const sentMsg = newPort.postMessage.mock.calls[0][0];
    newPort._fireMessage({ id: sentMsg.id, success: true, value: { theme: 'dark' } });

    const result = await promise;
    expect(result.success).toBe(true);
  });

  it('drain resumes after reconnect', async () => {
    channel.connectToOffscreen();
    const port = channel.port;

    channel.resetDrainFlag();

    // Crash
    port._fireDisconnect();

    // Reconnect
    await channel.ensureOffscreenPort();

    // connectToOffscreen calls scheduleDrainNotify
    expect(channel.drainScheduled).toBe(true);
  });
});

describe('Offscreen crash-loop detection', () => {
  it('triggers pauseService after 3 disconnects within 60s', () => {
    let now = 1000;
    const channel = createPortChannel({ nowFn: () => now });

    // Disconnect 1
    channel.connectToOffscreen();
    channel.port._fireDisconnect();
    expect(channel.pauseServiceCalls).toHaveLength(0);

    // Disconnect 2 — 10s later
    now += 10_000;
    channel.connectToOffscreen();
    channel.port._fireDisconnect();
    expect(channel.pauseServiceCalls).toHaveLength(0);

    // Disconnect 3 — another 10s later (still within 60s window)
    now += 10_000;
    channel.connectToOffscreen();
    channel.port._fireDisconnect();
    expect(channel.pauseServiceCalls).toHaveLength(1);
    expect(channel.pauseServiceCalls[0].code).toBe('offscreen_crash');
  });

  it('does not trigger pauseService after a single disconnect', () => {
    const channel = createPortChannel();
    channel.connectToOffscreen();
    channel.port._fireDisconnect();
    expect(channel.pauseServiceCalls).toHaveLength(0);
  });

  it('does not trigger pauseService when disconnects are spread over >60s', () => {
    let now = 1000;
    const channel = createPortChannel({ nowFn: () => now });

    // Disconnect 1
    channel.connectToOffscreen();
    channel.port._fireDisconnect();

    // Disconnect 2 — 31s later
    now += 31_000;
    channel.connectToOffscreen();
    channel.port._fireDisconnect();

    // Disconnect 3 — 31s after that (62s after first — outside window)
    now += 31_000;
    channel.connectToOffscreen();
    channel.port._fireDisconnect();

    // First disconnect is pruned (62s old), only 2 remain in window
    expect(channel.pauseServiceCalls).toHaveLength(0);
  });
});
