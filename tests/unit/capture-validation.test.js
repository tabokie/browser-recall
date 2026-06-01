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
const extDir = resolve(__dirname, '..', '..', 'apps', 'extension');

describe('captureAndLog content validation', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('rejects when both markdown and HTML are empty', () => {
    // captureAndLog must check that at least one of markdown/html has content
    // before writing the snapshot. Look for a guard that throws on empty content.
    const hasEmptyContentGuard =
      /if\s*\(\s*!markdown\b.*&&\s*!html\b|if\s*\(\s*!html\b.*&&\s*!markdown\b/.test(
        bgSource,
      );
    expect(
      hasEmptyContentGuard,
      'captureAndLog should guard against empty markdown AND empty html',
    ).toBe(true);
  });

  it('does not silently fall back to empty string without validation', () => {
    // The old pattern: mdResp?.markdown || '' and html || '' fed directly into
    // persistence without any check. The production path should validate first.
    const captureAndLogMatch = bgSource.match(
      /async function captureAndLog[\s\S]*?^}/m,
    );
    expect(captureAndLogMatch).not.toBeNull();
    const body = captureAndLogMatch[0];

    // Should NOT pass empty-string fallbacks directly without validation.
    const hasValidation =
      /if\s*\(!markdown\s*&&\s*!html\)|if\s*\(!html\s*&&\s*!markdown\)/.test(
        body,
      );
    expect(
      hasValidation,
      'captureAndLog should validate content before saving',
    ).toBe(true);
  });

  it('does not ignore extension runtime failures while probing the content script', () => {
    const captureAndLogMatch = bgSource.match(
      /async function captureAndLog[\s\S]*?^}/m,
    );
    expect(captureAndLogMatch).not.toBeNull();
    expect(captureAndLogMatch[0]).toContain('isExtensionRuntimeFailure(e)');
    expect(captureAndLogMatch[0]).toContain('throw e');
  });
});

describe('error notification bubble in content.js', () => {
  const contentSource = readFileSync(resolve(extDir, 'content.js'), 'utf-8');

  it('has a showErrorNotification function', () => {
    expect(contentSource).toContain('function showErrorNotification');
  });

  it('handles showErrorNotification action in message listener', () => {
    expect(contentSource).toContain(
      "request.action === 'showErrorNotification'",
    );
  });

  it('does not show global runtime reload warnings outside user actions', () => {
    expect(contentSource).not.toContain(
      "addEventListener('unhandledrejection'",
    );
    expect(contentSource).not.toContain("addEventListener('error'");
  });
});

describe('capture paths send error notifications', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('keyboard shortcut path sends error bubble on failure', () => {
    // The command handler for capture-snapshot should normalize user-action
    // failures and notify the active page on catch.
    const captureCommandMatch = bgSource.match(
      /if\s*\(command === 'capture-snapshot'\)[\s\S]*?}\s*else if\s*\(command === 'highlight-selection'\)/,
    );
    expect(captureCommandMatch).not.toBeNull();
    expect(captureCommandMatch[0]).toContain('notifyTabUserActionError');
  });

  it('keyboard highlight path notifies the page when highlight fails', () => {
    const highlightCommandMatch = bgSource.match(
      /else if\s*\(command === 'highlight-selection'\)[\s\S]*?}\s*else if\s*\(command === 'like-page'/,
    );
    expect(highlightCommandMatch).not.toBeNull();
    expect(highlightCommandMatch[0]).toContain('notifyTabUserActionError');
  });

  it('keyboard like path notifies the page when rating fails', () => {
    const likeCommandMatch = bgSource.match(
      /else if\s*\(command === 'like-page' \|\| command === 'dislike-page'\)[\s\S]*?}\s*\}\s*\);/,
    );
    expect(likeCommandMatch).not.toBeNull();
    expect(likeCommandMatch[0]).toContain('notifyTabUserActionError');
  });

  it('background notification falls back to direct page injection', () => {
    expect(bgSource).toContain('function injectUserActionErrorNotification');
    expect(bgSource).toContain('chrome.scripting.executeScript');
    expect(bgSource).toContain('notifyTabUserActionError');
  });

  it('popup path delegates error display to popup.js (no duplicate notification)', () => {
    // Background should NOT send showErrorNotification for popup captures — popup.js
    // now owns that responsibility. Only the keyboard shortcut path sends it from background.
    const popupCaseMatch = bgSource.match(
      /case\s+'captureCurrentPageFromPopup'[\s\S]*?break;\s*case\s+'flushDesktopQueue'/,
    );
    expect(popupCaseMatch).not.toBeNull();
    expect(popupCaseMatch[0]).not.toContain('showErrorNotification');
  });
});

describe('popup.js shows capture errors via page notifications', () => {
  const popupSource = readFileSync(resolve(extDir, 'popup.js'), 'utf-8');

  it('capture button notifies the active page on failure response', () => {
    // When captureCurrentPageFromPopup returns { success: false }, popup should
    // notify the content script rather than silently logging
    const captureHandler = popupSource.match(
      /captureBtn[\s\S]*?btn\.textContent\s*=\s*['"]CAPTURE FRAME['"]/,
    );
    expect(captureHandler).not.toBeNull();
    expect(captureHandler[0]).toContain('notifyActivePageError');
  });

  it('"Capture It" button uses the shared page notification fallback on failure', () => {
    // The blacklist bypass "Capture It" button should also show errors to user.
    const captureOnceHandler = popupSource.match(
      /captureOnceBtn[\s\S]*?showDashboard/,
    );
    expect(captureOnceHandler).not.toBeNull();
    expect(captureOnceHandler[0]).toContain('notifyPageError');
  });
});

describe('savepage/content.js guards against undefined resourceMimeType', () => {
  const spSource = readFileSync(
    resolve(extDir, 'savepage', 'content.js'),
    'utf-8',
  );

  it('loadSuccess guards against undefined resourceMimeType[index]', () => {
    // When background sends loadSuccess for an index whose resource slot was
    // never initialized (e.g., due to CSP blocking base-uri injection),
    // resourceMimeType[index] is undefined. The code must guard against this
    // rather than crashing on undefined.toLowerCase().
    const loadSuccessFn = spSource.match(/function loadSuccess[\s\S]*?^}/m);
    expect(loadSuccessFn).not.toBeNull();
    // Should check for undefined/null before calling .toLowerCase()
    const hasGuard =
      /resourceMimeType\[index\]\s*==\s*null|resourceMimeType\[index\]\s*===\s*undefined|!resourceMimeType\[index\]|typeof\s+resourceMimeType\[index\]/.test(
        loadSuccessFn[0],
      );
    expect(
      hasGuard,
      'loadSuccess should guard against undefined resourceMimeType[index]',
    ).toBe(true);
  });
});

describe('savepage bridge uses capture-scoped Desktop settings', () => {
  const bridgeSource = readFileSync(
    resolve(extDir, 'savepage-bridge.js'),
    'utf-8',
  );
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('does not read snapshot settings from extension session storage', () => {
    expect(bridgeSource).not.toContain(
      "chrome.storage.session.get('manifest:settings'",
    );
    expect(bridgeSource).not.toContain(
      'chrome.storage.session.get("manifest:settings"',
    );
    expect(bridgeSource).toContain(
      'savepageSettings.set(tabId, settings || {})',
    );
    expect(bridgeSource).toContain('savepageSettings.delete(tabId)');
  });

  it('passes Desktop-backed settings into captureSavePage', () => {
    const captureAndLogMatch = bgSource.match(
      /async function captureAndLog[\s\S]*?^}/m,
    );
    expect(captureAndLogMatch).not.toBeNull();
    expect(captureAndLogMatch[0]).toContain(
      "await readDesktopValue('manifest:settings')",
    );
    expect(captureAndLogMatch[0]).toContain('captureSavePage(tabId, settings)');
  });
});
