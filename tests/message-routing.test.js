/**
 * Message routing completeness tests.
 *
 * Verifies that every action sent by UI pages (options.js, popup.js) has a
 * corresponding `case` handler in background.js. This catches "dead letter"
 * bugs where a message silently falls through to the default error handler.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, '..', 'extension');

function extractSentActions(source) {
  const re = /chrome\.runtime\.sendMessage\(\{\s*action:\s*'([^']+)'/g;
  const actions = new Set();
  let m;
  while ((m = re.exec(source)) !== null) actions.add(m[1]);
  return actions;
}

function extractCaseHandlers(source) {
  const re = /case\s+'([^']+)'\s*:/g;
  const cases = new Set();
  let m;
  while ((m = re.exec(source)) !== null) cases.add(m[1]);
  return cases;
}

describe('background.js message routing', () => {
  const bgSource = readFileSync(resolve(extDir, 'background.js'), 'utf-8');
  const bgCases = extractCaseHandlers(bgSource);

  it('handles every action sent by options.js', () => {
    const optionsSource = readFileSync(resolve(extDir, 'options.js'), 'utf-8');
    const sentActions = extractSentActions(optionsSource);
    const missing = [...sentActions].filter(a => !bgCases.has(a));
    expect(missing, `Actions sent by options.js but not handled in background.js`).toEqual([]);
  });

  it('handles every action sent by popup.js', () => {
    const popupSource = readFileSync(resolve(extDir, 'popup.js'), 'utf-8');
    const sentActions = extractSentActions(popupSource);
    const missing = [...sentActions].filter(a => !bgCases.has(a));
    expect(missing, `Actions sent by popup.js but not handled in background.js`).toEqual([]);
  });
});
