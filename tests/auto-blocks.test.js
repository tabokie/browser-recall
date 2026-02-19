/**
 * Auto-block unconditional rendering tests.
 *
 * Static analysis tests that verify buildExploreAutoBlocks always creates
 * all three auto blocks (Children, Parents, Similar) regardless of whether
 * they have results — so the UI always shows the buttons.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const optionsSource = readFileSync(resolve(__dirname, '..', 'extension', 'options.js'), 'utf-8');

/**
 * Extract the body of buildExploreAutoBlocks function.
 */
function extractBuildAutoBlocks() {
  const marker = 'function buildExploreAutoBlocks';
  const start = optionsSource.indexOf(marker);
  if (start === -1) throw new Error('Could not find buildExploreAutoBlocks');

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
  throw new Error('Could not find end of buildExploreAutoBlocks');
}

describe('auto blocks always shown', () => {
  it('buildExploreAutoBlocks does not gate block creation on .size > 0', () => {
    const body = extractBuildAutoBlocks();
    expect(body, 'should not conditionally skip Children block').not.toContain('childrenUrls.size > 0');
    expect(body, 'should not conditionally skip Parents block').not.toContain('parentUrls.size > 0');
    expect(body, 'should not conditionally skip Similar block').not.toContain('similarUrls.size > 0');
  });

  it('buildExploreAutoBlocks pushes all three auto block labels', () => {
    const body = extractBuildAutoBlocks();
    expect(body).toContain("label: 'Children of pins'");
    expect(body).toContain("label: 'Parents of pins'");
    expect(body).toContain("label: 'Similar to pins'");
  });
});
