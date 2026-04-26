import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('logger', () => {
  let sessionStore;
  let onChangedListeners;
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    sessionStore = {};
    onChangedListeners = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.chrome = {
      storage: {
        session: {
          get: vi.fn(async (keys) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            const result = {};
            for (const k of arr)
              if (k in sessionStore) result[k] = sessionStore[k];
            return result;
          }),
          set: vi.fn(async (obj) => {
            Object.assign(sessionStore, obj);
          }),
        },
        onChanged: {
          addListener: vi.fn((cb) => onChangedListeners.push(cb)),
        },
      },
    };
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    delete globalThis.chrome;
    vi.resetModules();
  });

  async function loadLogger() {
    const mod = await import('../../apps/extension/logger.js');
    // Allow the async init to complete
    await new Promise((r) => setTimeout(r, 0));
    return mod;
  }

  it('logDebug is silent when debugLogging is off (default)', async () => {
    const { logDebug } = await loadLogger();
    logDebug('test message');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('logError always logs via console.error', async () => {
    const { logError } = await loadLogger();
    logError('fatal', 42);
    expect(errorSpy).toHaveBeenCalledWith('fatal', 42);
  });

  it('logDebug logs when debugLogging is enabled at init', async () => {
    sessionStore.debugLogging = true;
    const { logDebug } = await loadLogger();
    logDebug('hello', 'world');
    expect(logSpy).toHaveBeenCalledWith('hello', 'world');
  });

  it('logDebug responds to live toggle via storage.onChanged', async () => {
    const { logDebug } = await loadLogger();
    // Initially off
    logDebug('before');
    expect(logSpy).not.toHaveBeenCalled();

    // Simulate toggle on
    for (const cb of onChangedListeners) {
      cb({ debugLogging: { newValue: true } }, 'session');
    }
    logDebug('after');
    expect(logSpy).toHaveBeenCalledWith('after');
  });

  it('logDebug stops logging when toggled off via storage.onChanged', async () => {
    sessionStore.debugLogging = true;
    const { logDebug } = await loadLogger();
    logDebug('on');
    expect(logSpy).toHaveBeenCalledTimes(1);

    // Toggle off
    for (const cb of onChangedListeners) {
      cb({ debugLogging: { newValue: false } }, 'session');
    }
    logDebug('off');
    expect(logSpy).toHaveBeenCalledTimes(1); // no new call
  });

  it('ignores onChanged events from non-session areas', async () => {
    const { logDebug } = await loadLogger();
    for (const cb of onChangedListeners) {
      cb({ debugLogging: { newValue: true } }, 'local');
    }
    logDebug('should be silent');
    expect(logSpy).not.toHaveBeenCalled();
  });
});
