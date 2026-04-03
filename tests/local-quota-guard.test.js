/**
 * Local storage quota guard tests (plan 15).
 *
 * Verifies that persistLogBuffer() calls pauseService('local_quota', ...)
 * when chrome.storage.local.set throws a quota error, and re-throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Recreate persistLogBuffer + pauseService interaction from background.js.
function createPersistLogBuffer({ localSet, pauseService }) {
  let logBuffer = [];

  async function persistLogBuffer() {
    try {
      await localSet({ logBuffer });
    } catch (e) {
      if (e.message?.includes('QUOTA_BYTES') || e.message?.includes('quota')) {
        pauseService('local_quota', `Local storage full — logBuffer has ${logBuffer.length} undrained entries. Drain may be stuck.`);
      }
      throw e;
    }
  }

  return {
    persistLogBuffer,
    setLogBuffer(entries) { logBuffer = entries; },
    getLogBuffer() { return logBuffer; },
  };
}

describe('persistLogBuffer quota guard', () => {
  let localSet;
  let pauseService;
  let helper;

  beforeEach(() => {
    localSet = vi.fn().mockResolvedValue(undefined);
    pauseService = vi.fn();
    helper = createPersistLogBuffer({ localSet, pauseService });
  });

  it('persists normally without triggering pause', async () => {
    helper.setLogBuffer([{ action: 'visit', timestamp: 1 }]);
    await helper.persistLogBuffer();

    expect(localSet).toHaveBeenCalledWith({ logBuffer: [{ action: 'visit', timestamp: 1 }] });
    expect(pauseService).not.toHaveBeenCalled();
  });

  it('calls pauseService with local_quota on quota error', async () => {
    localSet.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    helper.setLogBuffer([{ action: 'visit', timestamp: 1 }]);

    await expect(helper.persistLogBuffer()).rejects.toThrow(/QUOTA_BYTES/);
    expect(pauseService).toHaveBeenCalledTimes(1);
    expect(pauseService).toHaveBeenCalledWith(
      'local_quota',
      expect.stringContaining('Local storage full')
    );
  });

  it('re-throws the quota error after pausing', async () => {
    const err = new Error('QUOTA_BYTES quota exceeded');
    localSet.mockRejectedValueOnce(err);

    await expect(helper.persistLogBuffer()).rejects.toThrow(err);
  });

  it('re-throws non-quota errors without pausing', async () => {
    localSet.mockRejectedValueOnce(new Error('Network error'));

    await expect(helper.persistLogBuffer()).rejects.toThrow('Network error');
    expect(pauseService).not.toHaveBeenCalled();
  });

  it('includes logBuffer size in the pause message', async () => {
    localSet.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    helper.setLogBuffer(Array.from({ length: 42 }, (_, i) => ({ action: 'visit', timestamp: i })));

    await expect(helper.persistLogBuffer()).rejects.toThrow();
    expect(pauseService).toHaveBeenCalledWith(
      'local_quota',
      expect.stringContaining('42 undrained entries')
    );
  });
});
