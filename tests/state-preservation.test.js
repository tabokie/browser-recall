/**
 * State preservation tests.
 *
 * Static analysis tests that verify options.js preserves UI state
 * (selection, expanded details, scroll position) across re-renders
 * by using updateData() instead of destructive setData()/refreshCurrentView().
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const optionsSource = readFileSync(resolve(__dirname, '..', 'extension', 'options.js'), 'utf-8');

/**
 * Extract a named branch from the mutation listener.
 */
function extractMutationBranch(branchName) {
  const listenerStart = optionsSource.indexOf("if (request.action !== 'mutation') return;");
  if (listenerStart === -1) throw new Error('Could not find mutation listener');

  const branchMarker = `type === '${branchName}'`;
  const branchStart = optionsSource.indexOf(branchMarker, listenerStart);
  if (branchStart === -1) throw new Error(`Could not find '${branchName}' branch in mutation listener`);

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
 * Extract the body of a named function.
 */
function extractFunctionBody(fnName) {
  const marker = `function ${fnName}`;
  const start = optionsSource.indexOf(marker);
  if (start === -1) throw new Error(`Could not find function ${fnName}`);

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
  throw new Error(`Could not find end of function ${fnName}`);
}

/**
 * Extract the sort click handler — the block after `setSortState(context, newState)`.
 * Returns the line(s) between setSortState and the closing `});`.
 */
function extractSortClickTail() {
  const marker = 'setSortState(context, newState)';
  const idx = optionsSource.indexOf(marker);
  if (idx === -1) throw new Error('Could not find setSortState(context, newState)');
  // Grab from the marker to the next `});` which closes the click handler
  const endMarker = '});';
  const endIdx = optionsSource.indexOf(endMarker, idx);
  if (endIdx === -1) throw new Error('Could not find end of sort click handler');
  return optionsSource.slice(idx, endIdx + endMarker.length);
}

describe('state preservation across re-renders', () => {
  it('VirtualScroller class has updateData() method', () => {
    expect(optionsSource).toContain('updateData(');
  });

  it('sort click handler calls resortActiveScroller, not refreshCurrentView', () => {
    const tail = extractSortClickTail();
    expect(tail, 'sort handler should call resortActiveScroller').toContain('resortActiveScroller');
    expect(tail, 'sort handler should NOT call refreshCurrentView').not.toContain('refreshCurrentView');
  });

  it('runSearchFilterPipeline uses vs.updateData (not vs.setData)', () => {
    const body = extractFunctionBody('runSearchFilterPipeline');
    expect(body, 'runSearchFilterPipeline should use updateData').toContain('vs.updateData(');
    expect(body, 'runSearchFilterPipeline should NOT use vs.setData').not.toContain('vs.setData(');
  });

  it('interaction mutation uses runSearchFilterPipeline for explore/list views', () => {
    const branch = extractMutationBranch('interaction');
    expect(branch, 'interaction branch should call runSearchFilterPipeline').toContain('runSearchFilterPipeline()');
  });
});
