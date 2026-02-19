/**
 * Mutation refresh completeness tests.
 *
 * Static analysis tests that verify options.js correctly refreshes
 * the active view when external mutations arrive (from popup/content).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const optionsSource = readFileSync(resolve(__dirname, '..', 'extension', 'options.js'), 'utf-8');

/**
 * Extract a named branch from the mutation listener.
 * Returns the code between `type === '<branchName>'` and the next `} else if` or `}` closing.
 */
function extractMutationBranch(branchName) {
  // Find the mutation listener block
  const listenerStart = optionsSource.indexOf("if (request.action !== 'mutation') return;");
  if (listenerStart === -1) throw new Error('Could not find mutation listener');

  const searchFrom = listenerStart;
  const branchMarker = `type === '${branchName}'`;
  const branchStart = optionsSource.indexOf(branchMarker, searchFrom);
  if (branchStart === -1) throw new Error(`Could not find '${branchName}' branch in mutation listener`);

  // Find the end of this branch — next `} else if` or the listener's closing
  let depth = 0;
  let inBranch = false;
  let blockStart = -1;
  for (let i = branchStart; i < optionsSource.length; i++) {
    if (optionsSource[i] === '{') {
      if (!inBranch) {
        inBranch = true;
        blockStart = i;
      }
      depth++;
    } else if (optionsSource[i] === '}') {
      depth--;
      if (depth === 0 && inBranch) {
        return optionsSource.slice(blockStart, i + 1);
      }
    }
  }
  throw new Error(`Could not find end of '${branchName}' branch`);
}

/**
 * Extract the visibilitychange handler block.
 */
function extractVisibilityHandler() {
  const marker = "document.addEventListener('visibilitychange'";
  const start = optionsSource.indexOf(marker);
  if (start === -1) throw new Error('Could not find visibilitychange handler');

  let depth = 0;
  let inBlock = false;
  let blockStart = -1;
  for (let i = start; i < optionsSource.length; i++) {
    if (optionsSource[i] === '{') {
      if (!inBlock) {
        inBlock = true;
        blockStart = i;
      }
      depth++;
    } else if (optionsSource[i] === '}') {
      depth--;
      if (depth === 0 && inBlock) {
        return optionsSource.slice(blockStart, i + 1);
      }
    }
  }
  throw new Error('Could not find end of visibilitychange handler');
}

describe('mutation refresh completeness', () => {
  it('pins mutation branch calls refreshCurrentView()', () => {
    const pinsBranch = extractMutationBranch('pins');
    expect(pinsBranch, 'pins branch should call refreshCurrentView()').toContain('refreshCurrentView()');
  });

  it('interaction mutation branch refreshes all view types (not just category)', () => {
    const interactionBranch = extractMutationBranch('interaction');
    // Should call refreshCurrentView() unconditionally on change, not gated to category
    expect(interactionBranch).toContain('refreshCurrentView()');
    expect(interactionBranch, 'should not gate refresh to category-only').not.toMatch(
      /activeView\.type\s*===\s*'category'/
    );
  });

  it('visibilitychange handler calls renderCollections()', () => {
    const handler = extractVisibilityHandler();
    expect(handler, 'visibilitychange should refresh sidebar collections').toContain('renderCollections()');
  });

  it('visibilitychange handler refreshes all view types (not just category)', () => {
    const handler = extractVisibilityHandler();
    expect(handler).toContain('refreshCurrentView()');
    expect(handler, 'should not gate refresh to category-only').not.toMatch(
      /activeView\.type\s*===\s*'category'/
    );
  });
});
