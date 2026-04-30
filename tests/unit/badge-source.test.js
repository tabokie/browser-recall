import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backgroundSource = readFileSync(
  resolve(process.cwd(), 'apps/extension/background.js'),
  'utf8',
);

describe('background badge connector refresh behavior', () => {
  it('does not clear the global badge when the desktop connector is already available', () => {
    const match = backgroundSource.match(
      /async function applyDesktopConnectorBadge[\s\S]*?\n}\n\nasync function shouldMirrorEntryToDesktop/,
    );
    expect(match).not.toBeNull();

    const source = match[0];
    expect(source).toContain('if (isDesktopConnectorAvailable(connector))');
    expect(source).toContain('if (tabId !== undefined)');
    expect(source).toContain(
      "await chrome.action.setBadgeText({ text: '', tabId });",
    );
    expect(source).not.toContain("text: '',\n      ...(tabId !== undefined");
  });

  it('recomputes the active tab badge after connected connector refreshes', () => {
    expect(backgroundSource).toContain(
      'if (!(await applyDesktopConnectorBadge(connector)))',
    );
    expect(backgroundSource).toContain('await refreshActiveTabBadge();');
    expect(backgroundSource).toContain(
      'async function refreshActiveTabBadge()',
    );
  });
});
