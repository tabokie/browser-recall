/**
 * Capture validation tests.
 *
 * Verifies that captureAndLog rejects empty snapshots (both markdown and HTML
 * empty) instead of silently saving zero-content files, and that the error
 * notification bubble is shown to the user on failure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, '..', 'extension');

describe('captureAndLog content validation', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('rejects when both markdown and HTML are empty', () => {
    // captureAndLog must check that at least one of markdown/html has content
    // before writing the snapshot. Look for a guard that throws on empty content.
    const hasEmptyContentGuard = /if\s*\(\s*!markdown\b.*&&\s*!html\b|if\s*\(\s*!html\b.*&&\s*!markdown\b/.test(bgSource);
    expect(hasEmptyContentGuard, 'captureAndLog should guard against empty markdown AND empty html').toBe(true);
  });

  it('does not silently fall back to empty string without validation', () => {
    // The old pattern: mdResp?.markdown || '' and html || '' fed directly to
    // requestOffscreen without any check. After the fix, there should be a
    // validation step between extraction and the offscreen call.
    const captureAndLogMatch = bgSource.match(/async function captureAndLog[\s\S]*?^}/m);
    expect(captureAndLogMatch).not.toBeNull();
    const body = captureAndLogMatch[0];

    // Should NOT pass empty-string fallbacks directly to requestOffscreen
    // without an intervening validation check
    const hasValidation = /if\s*\(!markdown\s*&&\s*!html\)|if\s*\(!html\s*&&\s*!markdown\)/.test(body);
    expect(hasValidation, 'captureAndLog should validate content before saving').toBe(true);
  });
});

describe('error notification bubble in content.js', () => {
  const contentSource = readFileSync(resolve(extDir, 'content.js'), 'utf-8');

  it('has a showErrorNotification function', () => {
    expect(contentSource).toContain('function showErrorNotification');
  });

  it('handles showErrorNotification action in message listener', () => {
    expect(contentSource).toContain("request.action === 'showErrorNotification'");
  });
});

describe('capture paths send error notifications', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('keyboard shortcut path sends error bubble on failure', () => {
    // The command handler for capture-snapshot should send showErrorNotification
    // on catch
    expect(bgSource).toContain("action: 'showErrorNotification'");
  });

  it('popup path delegates error display to popup.js (no duplicate notification)', () => {
    // Background should NOT send showErrorNotification for popup captures — popup.js
    // now owns that responsibility. Only the keyboard shortcut path sends it from background.
    const popupCaseMatch = bgSource.match(/case\s+'captureCurrentPageFromPopup'[\s\S]*?break;\s*}/);
    expect(popupCaseMatch).not.toBeNull();
    expect(popupCaseMatch[0]).not.toContain('showErrorNotification');
  });
});

describe('popup.js shows capture errors via showErrorNotification', () => {
  const popupSource = readFileSync(resolve(extDir, 'popup.js'), 'utf-8');

  it('capture button sends showErrorNotification on failure response', () => {
    // When captureCurrentPageFromPopup returns { success: false }, popup should
    // send showErrorNotification to the content script rather than silently logging
    const captureHandler = popupSource.match(/captureBtn[\s\S]*?btn\.textContent\s*=\s*['"]\+\s*Capture['"]/);
    expect(captureHandler).not.toBeNull();
    expect(captureHandler[0]).toContain('showErrorNotification');
  });

  it('"Capture It" button sends showErrorNotification on failure', () => {
    // The blacklist bypass "Capture It" button should also show errors to user
    const captureOnceHandler = popupSource.match(/captureOnceBtn[\s\S]*?showDashboard/);
    expect(captureOnceHandler).not.toBeNull();
    expect(captureOnceHandler[0]).toContain('showErrorNotification');
  });
});

describe('savepage/content.js guards against undefined resourceMimeType', () => {
  const spSource = readFileSync(resolve(extDir, 'savepage', 'content.js'), 'utf-8');

  it('loadSuccess guards against undefined resourceMimeType[index]', () => {
    // When background sends loadSuccess for an index whose resource slot was
    // never initialized (e.g., due to CSP blocking base-uri injection),
    // resourceMimeType[index] is undefined. The code must guard against this
    // rather than crashing on undefined.toLowerCase().
    const loadSuccessFn = spSource.match(/function loadSuccess[\s\S]*?^}/m);
    expect(loadSuccessFn).not.toBeNull();
    // Should check for undefined/null before calling .toLowerCase()
    const hasGuard = /resourceMimeType\[index\]\s*==\s*null|resourceMimeType\[index\]\s*===\s*undefined|!resourceMimeType\[index\]|typeof\s+resourceMimeType\[index\]/.test(loadSuccessFn[0]);
    expect(hasGuard, 'loadSuccess should guard against undefined resourceMimeType[index]').toBe(true);
  });
});
