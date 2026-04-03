/**
 * Drain failure tracking tests (plan 16).
 *
 * Verifies that consecutive drain failures trigger pauseService,
 * watermark receipt resets the counter, and auto-resume works.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Extract drain failure tracking logic from background.js for unit testing.
// ---------------------------------------------------------------------------

function createDrainTracker({ threshold = 12 } = {}) {
  let consecutiveDrainFailures = 0;
  const pauseCalls = [];
  let serviceError = null;

  function pauseService(code, message) {
    serviceError = { code, message };
    pauseCalls.push({ code, message });
  }

  function resumeService() {
    serviceError = null;
    consecutiveDrainFailures = 0;
  }

  function isServicePaused() {
    return serviceError !== null;
  }

  // Called from drainNow when logBuffer has entries
  function onDrainAttempt() {
    consecutiveDrainFailures++;
    if (consecutiveDrainFailures >= threshold) {
      pauseService('fs_permission', `Storage drain has failed for ${threshold * 5}+ seconds. File system permission may have been revoked.`);
    }
  }

  // Called from handleOffscreenResponse on 'persisted' watermark
  function onWatermarkReceived() {
    consecutiveDrainFailures = 0;
    if (isServicePaused() && serviceError?.code === 'fs_permission') {
      resumeService();
    }
  }

  return {
    onDrainAttempt,
    onWatermarkReceived,
    pauseService,  // exposed for testing external pause scenarios
    resumeService,
    get consecutiveDrainFailures() { return consecutiveDrainFailures; },
    get pauseCalls() { return pauseCalls; },
    get serviceError() { return serviceError; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Drain failure tracking', () => {
  it('12 consecutive drain attempts with no watermark triggers pauseService', () => {
    const tracker = createDrainTracker();

    for (let i = 0; i < 11; i++) {
      tracker.onDrainAttempt();
    }
    expect(tracker.pauseCalls).toHaveLength(0);

    // 12th attempt triggers pause
    tracker.onDrainAttempt();
    expect(tracker.pauseCalls).toHaveLength(1);
    expect(tracker.pauseCalls[0].code).toBe('fs_permission');
  });

  it('watermark receipt resets counter to 0', () => {
    const tracker = createDrainTracker();

    // Accumulate 10 failures
    for (let i = 0; i < 10; i++) {
      tracker.onDrainAttempt();
    }
    expect(tracker.consecutiveDrainFailures).toBe(10);

    // Watermark arrives
    tracker.onWatermarkReceived();
    expect(tracker.consecutiveDrainFailures).toBe(0);

    // Need another 12 to trigger pause
    for (let i = 0; i < 11; i++) {
      tracker.onDrainAttempt();
    }
    expect(tracker.pauseCalls).toHaveLength(0);
  });

  it('watermark auto-resumes fs_permission pause', () => {
    const tracker = createDrainTracker();

    // Trigger pause
    for (let i = 0; i < 12; i++) {
      tracker.onDrainAttempt();
    }
    expect(tracker.serviceError?.code).toBe('fs_permission');

    // Watermark arrives (permission re-granted, drain succeeds)
    tracker.onWatermarkReceived();
    expect(tracker.serviceError).toBeNull();
    expect(tracker.consecutiveDrainFailures).toBe(0);
  });

  it('watermark does NOT auto-resume non-fs_permission pause', () => {
    const tracker = createDrainTracker();

    // Service paused externally for a different reason
    tracker.pauseService('session_quota', 'Session storage full');
    expect(tracker.serviceError?.code).toBe('session_quota');

    // Watermark arrives — should reset counter but NOT resume
    tracker.onWatermarkReceived();
    expect(tracker.consecutiveDrainFailures).toBe(0);
    expect(tracker.serviceError?.code).toBe('session_quota'); // still paused
  });

  it('resumeService resets counter and clears error', () => {
    const tracker = createDrainTracker();

    for (let i = 0; i < 8; i++) {
      tracker.onDrainAttempt();
    }
    expect(tracker.consecutiveDrainFailures).toBe(8);

    tracker.resumeService();
    expect(tracker.consecutiveDrainFailures).toBe(0);
    expect(tracker.serviceError).toBeNull();
  });

  it('single drain failure does not trigger pause', () => {
    const tracker = createDrainTracker();
    tracker.onDrainAttempt();
    expect(tracker.pauseCalls).toHaveLength(0);
    expect(tracker.consecutiveDrainFailures).toBe(1);
  });
});
