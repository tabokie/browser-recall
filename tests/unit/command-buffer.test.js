import { beforeEach, describe, expect, it, vi } from 'vitest';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function installChromeStorageMock({ initialStore = {}, setDelays = [] } = {}) {
  const store = clone(initialStore);
  let setCalls = 0;

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            const result = {};
            for (const key of keys) {
              if (key in store) result[key] = clone(store[key]);
            }
            return result;
          }
          if (typeof keys === 'string') {
            return keys in store ? { [keys]: clone(store[keys]) } : {};
          }
          return clone(store);
        },
        async set(values) {
          const snapshot = clone(values);
          const delay = setDelays[setCalls] || 0;
          setCalls += 1;
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          Object.assign(store, snapshot);
        },
      },
    },
  };

  return store;
}

describe('connector command buffer', () => {
  beforeEach(() => {
    vi.resetModules();
    delete globalThis.chrome;
  });

  it('serializes concurrent enqueues before persisting the durable queue', async () => {
    const store = installChromeStorageMock({ setDelays: [25, 0] });
    const { bufferStats, enqueueBufferedMessage } =
      await import('../../apps/extension/connector/command-buffer.js');
    await bufferStats();

    await Promise.all([
      enqueueBufferedMessage({
        kind: 'command',
        action: 'reportVisit',
        request: { timestamp: 1 },
      }),
      enqueueBufferedMessage({
        kind: 'command',
        action: 'reportVisit',
        request: { timestamp: 2 },
      }),
    ]);

    expect(
      store.desktopCommandBuffer.map((item) => item.request.timestamp),
    ).toEqual([1, 2]);
    expect(store.desktopPendingCommands).toBe(2);
  });

  it('serializes flush shifts against concurrent enqueues', async () => {
    const store = installChromeStorageMock({
      initialStore: {
        desktopCommandBuffer: [
          { kind: 'command', action: 'reportVisit', request: { timestamp: 1 } },
        ],
        desktopPendingCommands: 1,
      },
      setDelays: [25, 0],
    });
    const { bufferStats, enqueueBufferedMessage, shiftBufferedMessage } =
      await import('../../apps/extension/connector/command-buffer.js');
    await bufferStats();

    await Promise.all([
      shiftBufferedMessage(),
      enqueueBufferedMessage({
        kind: 'command',
        action: 'reportVisit',
        request: { timestamp: 2 },
      }),
    ]);

    expect(
      store.desktopCommandBuffer.map((item) => item.request.timestamp),
    ).toEqual([2]);
    expect(store.desktopPendingCommands).toBe(1);
  });

  it('rejects only the overflowing enqueue and accepts later commands', async () => {
    const store = installChromeStorageMock();
    const { enqueueBufferedMessage } =
      await import('../../apps/extension/connector/command-buffer.js');

    await expect(
      enqueueBufferedMessage({
        kind: 'command',
        action: 'createNote',
        request: { content: 'x'.repeat(8 * 1024 * 1024) },
      }),
    ).rejects.toMatchObject({ code: 'buffer_full' });

    await enqueueBufferedMessage({
      kind: 'command',
      action: 'reportVisit',
      request: { timestamp: 1 },
    });

    expect(store.desktopCommandBuffer).toEqual([
      {
        kind: 'command',
        action: 'reportVisit',
        request: { timestamp: 1 },
      },
    ]);
    expect(store.desktopPendingCommands).toBe(1);
  });
});
