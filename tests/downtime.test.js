/**
 * Downtime infrastructure unit tests.
 *
 * Verifies pauseService / resumeService / isServicePaused state machine and
 * the addLog early-return guard when the service is paused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Extract the service state machine from background.js for unit testing.
// ---------------------------------------------------------------------------

function createServiceState(chrome) {
  let serviceError = null; // null = healthy

  function pauseService(code, message) {
    serviceError = { code, message, timestamp: Date.now() };
    chrome.action.setIcon({
      path: {
        16: 'icons/icon16-down.png',
        48: 'icons/icon48-down.png',
        128: 'icons/icon128-down.png',
      },
    });
    chrome.storage.session.set({ serviceError }).catch(() => {});
  }

  function resumeService() {
    serviceError = null;
    chrome.action.setIcon({
      path: {
        16: 'icons/icon16.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png',
      },
    });
    chrome.storage.session.remove(['serviceError']).catch(() => {});
  }

  function isServicePaused() {
    return serviceError !== null;
  }

  function getServiceError() {
    return serviceError;
  }

  return { pauseService, resumeService, isServicePaused, getServiceError };
}

// Simplified addLog that checks isServicePaused before proceeding.
// Mirrors real addLog: throws when paused so callers' try/catch produces clean errors.
function createAddLog(svc, appendEntry) {
  return async function addLog(entry) {
    if (svc.isServicePaused()) {
      const err = svc.getServiceError();
      throw new Error(`Service paused [${err.code}]`);
    }
    return appendEntry(entry);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('downtime service state', () => {
  let chrome;
  let sessionStore;
  let setIconCalls;

  beforeEach(() => {
    sessionStore = {};
    setIconCalls = [];
    chrome = {
      action: {
        setIcon: vi.fn((opts) => { setIconCalls.push(opts); }),
      },
      storage: {
        session: {
          set: vi.fn(async (obj) => { Object.assign(sessionStore, obj); }),
          remove: vi.fn(async (keys) => { for (const k of keys) delete sessionStore[k]; }),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isServicePaused is false initially', () => {
    const svc = createServiceState(chrome);
    expect(svc.isServicePaused()).toBe(false);
  });

  it('pauseService sets error state and calls setIcon with down icons', async () => {
    const svc = createServiceState(chrome);
    svc.pauseService('session_quota', 'Session storage full');

    expect(svc.isServicePaused()).toBe(true);
    expect(chrome.action.setIcon).toHaveBeenCalledOnce();
    const iconCall = setIconCalls[0];
    expect(iconCall.path[16]).toContain('-down');
    expect(iconCall.path[48]).toContain('-down');
    expect(iconCall.path[128]).toContain('-down');
  });

  it('pauseService writes serviceError to session storage', async () => {
    const svc = createServiceState(chrome);
    svc.pauseService('local_quota', 'Local storage full');

    // Flush micro-tasks so the .set() promise fires
    await Promise.resolve();
    expect(chrome.storage.session.set).toHaveBeenCalled();
    const written = chrome.storage.session.set.mock.calls[0][0];
    expect(written.serviceError.code).toBe('local_quota');
    expect(written.serviceError.message).toBe('Local storage full');
    expect(typeof written.serviceError.timestamp).toBe('number');
  });

  it('resumeService clears error state and restores normal icons', async () => {
    const svc = createServiceState(chrome);
    svc.pauseService('offscreen_crash', 'Offscreen crashed');
    expect(svc.isServicePaused()).toBe(true);

    svc.resumeService();

    expect(svc.isServicePaused()).toBe(false);
    expect(chrome.action.setIcon).toHaveBeenCalledTimes(2);
    const restoreCall = setIconCalls[1];
    expect(restoreCall.path[16]).not.toContain('-down');
    expect(restoreCall.path[48]).not.toContain('-down');
    expect(restoreCall.path[128]).not.toContain('-down');
  });

  it('resumeService removes serviceError from session storage', async () => {
    const svc = createServiceState(chrome);
    svc.pauseService('fs_permission', 'FS permission revoked');
    svc.resumeService();

    await Promise.resolve();
    expect(chrome.storage.session.remove).toHaveBeenCalled();
    const removedKeys = chrome.storage.session.remove.mock.calls[0][0];
    expect(removedKeys).toContain('serviceError');
  });

  it('multiple pauseService calls preserve last code', () => {
    const svc = createServiceState(chrome);
    svc.pauseService('session_quota', 'first');
    svc.pauseService('local_quota', 'second');

    expect(svc.isServicePaused()).toBe(true);
    expect(svc.getServiceError().code).toBe('local_quota');
  });
});

describe('addLog paused guard', () => {
  let chrome;

  beforeEach(() => {
    chrome = {
      action: { setIcon: vi.fn() },
      storage: {
        session: {
          set: vi.fn(() => Promise.resolve()),
          remove: vi.fn(() => Promise.resolve()),
        },
      },
    };
  });

  it('addLog throws when service is paused', async () => {
    const svc = createServiceState(chrome);
    svc.pauseService('session_quota', 'Session full');

    const appendEntry = vi.fn(() => ({ 'page:test': {} }));
    const addLog = createAddLog(svc, appendEntry);

    await expect(
      addLog({ timestamp: Date.now(), action: 'visit_page', url: 'https://example.com' })
    ).rejects.toThrow(/service paused/i);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it('addLog proceeds normally when service is healthy', async () => {
    const svc = createServiceState(chrome);
    // Not paused

    const effects = { 'page:test': { slug: 'test' } };
    const appendEntry = vi.fn(async () => effects);
    const addLog = createAddLog(svc, appendEntry);

    const result = await addLog({ timestamp: Date.now(), action: 'visit_page', url: 'https://example.com' });

    expect(appendEntry).toHaveBeenCalledOnce();
    expect(result).toBe(effects);
  });

  it('addLog proceeds after service is resumed', async () => {
    const svc = createServiceState(chrome);
    svc.pauseService('local_quota', 'Local full');
    svc.resumeService();

    const effects = { 'page:test': { slug: 'test' } };
    const appendEntry = vi.fn(async () => effects);
    const addLog = createAddLog(svc, appendEntry);

    const result = await addLog({ timestamp: Date.now(), action: 'visit_page', url: 'https://example.com' });

    expect(appendEntry).toHaveBeenCalledOnce();
    expect(result).toBe(effects);
  });
});
