import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Save Page capture sessions', () => {
  let messageListener;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.chrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener) => {
            messageListener = listener;
          }),
        },
      },
      scripting: {
        executeScript: vi.fn(async () => []),
      },
      storage: {
        session: { get: vi.fn(async () => ({})) },
        onChanged: { addListener: vi.fn() },
      },
      tabs: {
        sendMessage: vi.fn(async () => ({})),
      },
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete globalThis.chrome;
  });

  async function loadBridge() {
    const bridge = await import('../../apps/extension/savepage-bridge.js');
    bridge.initSavepageBridge();
    return bridge;
  }

  function completeCapture(html, captureId) {
    messageListener(
      { type: 'savepageDone', html, captureId },
      { tab: { id: 42 } },
      vi.fn(),
    );
  }

  function startCapture(captureSavePage) {
    const promise = captureSavePage(
      42,
      { captureSnapshotVideo: false },
      {
        maxEncodedHtmlBytes: 32 * 1024 * 1024,
        maxConcurrentResourceLoads: 6,
      },
    );
    messageListener({ type: 'scriptLoaded' }, { tab: { id: 42 } }, vi.fn());
    const performAction = chrome.tabs.sendMessage.mock.calls
      .map(([, message]) => message)
      .findLast((message) => message.type === 'performAction');
    return { captureId: performAction?.captureId, promise };
  }

  it('does not let a completed capture timer cancel a later capture', async () => {
    const { captureSavePage } = await loadBridge();
    const first = startCapture(captureSavePage);
    completeCapture('first', first.captureId);
    const firstResult = await first.promise;
    expect(firstResult?.html ?? firstResult).toBe('first');

    await vi.advanceTimersByTimeAsync(55_000);
    const second = startCapture(captureSavePage);
    let secondResult;
    void second.promise.then((result) => {
      secondResult = result;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    completeCapture('second', second.captureId);
    await Promise.resolve();

    expect(secondResult?.html ?? secondResult).toBe('second');
  });

  it('rejects an overlapping capture instead of replacing its session', async () => {
    const { captureSavePage } = await loadBridge();
    const first = startCapture(captureSavePage);
    const second = captureSavePage(
      42,
      { captureSnapshotVideo: false },
      {
        maxEncodedHtmlBytes: 32 * 1024 * 1024,
        maxConcurrentResourceLoads: 6,
      },
    );
    let overlapError;
    void second.catch((error) => {
      overlapError = error;
    });
    await Promise.resolve();

    expect(overlapError?.message).toContain('already in progress');
    completeCapture('first', first.captureId);
    const firstResult = await first.promise;
    expect(firstResult?.html ?? firstResult).toBe('first');
  });

  it('rejects capture when the desktop-derived budget is missing', async () => {
    const { captureSavePage } = await loadBridge();

    await expect(
      captureSavePage(42, { captureSnapshotVideo: false }),
    ).rejects.toThrow('desktop-derived budget');
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('classifies policy skips separately from unavailable resources', async () => {
    const { captureSavePage } = await loadBridge();
    const capture = startCapture(captureSavePage);
    messageListener(
      {
        type: 'resourceFailure',
        captureId: capture.captureId,
        location: 'https://example.test/video.mp4',
        reason: 'blocked',
      },
      { tab: { id: 42 } },
      vi.fn(),
    );
    completeCapture('captured', capture.captureId);

    await expect(capture.promise).resolves.toEqual({
      html: 'captured',
      warnings: [
        {
          category: 'policy',
          intentional: true,
          location: 'https://example.test/video.mp4',
          reason: 'blocked',
        },
      ],
    });
  });

  it('classifies unsupported fallback response types as MIME omissions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('unsupported', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    );
    const { captureSavePage } = await loadBridge();
    const capture = startCapture(captureSavePage);

    messageListener(
      {
        type: 'loadResource',
        captureId: capture.captureId,
        index: 7,
        location: 'https://example.test/unsupported.txt',
        referrer: 'https://example.test/',
        referrerPolicy: 'no-referrer',
        maxBytes: 1024,
      },
      { tab: { id: 42 } },
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: 'loadFailure',
        captureId: capture.captureId,
        index: 7,
        reason: 'mime*',
      }),
    );
    completeCapture('captured', capture.captureId);
    await capture.promise;
  });
});
