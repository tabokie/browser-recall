/**
 * Referrer tracking & focus panel static analysis tests.
 *
 * Verifies:
 * (a) webNavigation-based referrer fallback exists in background.js
 * (b) Focus panel parent cards delegate title resolution to makeCard
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, '..', 'extension');

describe('referrer tracking via webNavigation', () => {
  const manifest = JSON.parse(readFileSync(resolve(extDir, 'manifest.json'), 'utf-8'));
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');

  it('manifest.json includes webNavigation permission', () => {
    expect(manifest.permissions).toContain('webNavigation');
  });

  it('background.js registers webNavigation.onCommitted listener', () => {
    expect(bgSource).toMatch(/chrome\.webNavigation\.onCommitted\.addListener/);
  });

  it('background.js uses tabReferrers for fallback in reportPage', () => {
    expect(bgSource).toMatch(/tabReferrers/);
  });
});

describe('focus panel parent titles', () => {
  const optSource = readFileSync(resolve(extDir, 'options.js'), 'utf-8');

  it('renderFocusWaterfall parents do NOT hard-code hostname for title', () => {
    // Extract the parents.referrers.map(...) call inside renderFocusWaterfall
    const fnMatch = optSource.match(
      /parents\.referrers\.map\(ref\s*=>\s*\{?([\s\S]*?)\}?\)\.join/
    );
    expect(fnMatch).not.toBeNull();
    const mapBody = fnMatch[1];
    expect(mapBody).not.toMatch(/hostname/);
  });

  it('makeCard contains hostname as pretty-URL fallback', () => {
    // Extract makeCard function body
    const fnMatch = optSource.match(/function makeCard\([\s\S]*?\n  \}/);
    expect(fnMatch).not.toBeNull();
    const makeCardBody = fnMatch[0];
    expect(makeCardBody).toMatch(/hostname/);
  });
});
