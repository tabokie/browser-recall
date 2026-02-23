import { describe, it, expect } from 'vitest';
import { generateSlugFromUrl, collectQbTrees, qbTreesChanged } from '../extension/utils.js';

describe('generateSlugFromUrl', () => {
  it('produces a slug from a simple URL', () => {
    const slug = generateSlugFromUrl('https://example.com/page');
    expect(slug).toMatch(/^example-page-/);
  });

  it('strips leading/trailing hyphens', () => {
    const slug = generateSlugFromUrl('https://example.com/');
    expect(slug).not.toMatch(/^-/);
    expect(slug).not.toMatch(/-$/);
  });

  it('differentiates URLs with different query params', () => {
    const a = generateSlugFromUrl('https://example.com/page?a=1');
    const b = generateSlugFromUrl('https://example.com/page?a=2');
    expect(a).not.toBe(b);
  });

  it('returns "untitled" for invalid URLs', () => {
    expect(generateSlugFromUrl('not-a-url')).toBe('untitled');
  });

  it('truncates long slugs to 80 chars', () => {
    const longPath = '/a'.repeat(100);
    const slug = generateSlugFromUrl(`https://example.com${longPath}`);
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it('handles unicode in hostname', () => {
    const slug = generateSlugFromUrl('https://例え.jp/ページ');
    expect(slug.length).toBeGreaterThan(0);
    expect(slug).not.toBe('untitled');
  });

  it('is deterministic', () => {
    const url = 'https://example.com/test?q=hello';
    expect(generateSlugFromUrl(url)).toBe(generateSlugFromUrl(url));
  });
});

// ---------------------------------------------------------------------------
// collectQbTrees
// ---------------------------------------------------------------------------

describe('collectQbTrees', () => {
  const treeA = { type: 'predicate', predicateType: 'keyword', value: 'rust' };
  const treeB = { type: 'operator', op: 'AND', children: [
    { type: 'predicate', predicateType: 'keyword', value: 'go' },
    { type: 'predicate', predicateType: 'smartFilter', value: 'recent' },
  ]};
  const treeC = { type: 'predicate', predicateType: 'keyword', value: 'python' };

  it('returns all manual block trees, not just the first', () => {
    const blocks = [
      { id: 1, type: 'manual', label: 'Saved query', enabled: true, tree: treeA },
      { id: 2, type: 'manual', label: 'Saved query', enabled: true, tree: treeB },
      { id: 3, type: 'manual', label: 'Saved query', enabled: true, tree: treeC },
    ];
    const result = collectQbTrees(blocks);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(treeA);
    expect(result[1]).toEqual(treeB);
    expect(result[2]).toEqual(treeC);
  });

  it('includes manual blocks regardless of label', () => {
    const blocks = [
      { id: 1, type: 'manual', label: 'Saved query', enabled: true, tree: treeA },
      { id: 2, type: 'manual', label: 'Custom query', enabled: true, tree: treeB },
    ];
    const result = collectQbTrees(blocks);
    expect(result).toHaveLength(2);
  });

  it('skips auto blocks', () => {
    const blocks = [
      { id: 1, type: 'auto', label: 'Domain: a.com', enabled: true, urls: ['a.com'] },
      { id: 2, type: 'manual', label: 'Saved query', enabled: true, tree: treeA },
    ];
    const result = collectQbTrees(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(treeA);
  });

  it('skips blocks without a tree', () => {
    const blocks = [
      { id: 1, type: 'manual', label: 'Saved query', enabled: true, tree: null },
      { id: 2, type: 'manual', label: 'Saved query', enabled: true, tree: treeA },
    ];
    const result = collectQbTrees(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(treeA);
  });

  it('returns deep copies (mutation-safe)', () => {
    const blocks = [
      { id: 1, type: 'manual', label: 'Saved query', enabled: true, tree: treeA },
    ];
    const result = collectQbTrees(blocks);
    result[0].value = 'mutated';
    expect(blocks[0].tree.value).toBe('rust');
  });

  it('returns empty array when no manual blocks exist', () => {
    const blocks = [
      { id: 1, type: 'auto', label: 'Domain: a.com', enabled: true, urls: ['a.com'] },
    ];
    expect(collectQbTrees(blocks)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// qbTreesChanged
// ---------------------------------------------------------------------------

describe('qbTreesChanged', () => {
  const treeA = { type: 'predicate', predicateType: 'keyword', value: 'rust' };
  const treeB = { type: 'predicate', predicateType: 'keyword', value: 'go' };

  it('returns false for identical tree arrays', () => {
    const trees = [treeA, treeB];
    const copy = JSON.parse(JSON.stringify(trees));
    expect(qbTreesChanged(trees, copy)).toBe(false);
  });

  it('returns false for both empty', () => {
    expect(qbTreesChanged([], [])).toBe(false);
  });

  it('returns true when a tree is added', () => {
    expect(qbTreesChanged([treeA], [treeA, treeB])).toBe(true);
  });

  it('returns true when a tree is removed', () => {
    expect(qbTreesChanged([treeA, treeB], [treeA])).toBe(true);
  });

  it('returns true when tree content differs', () => {
    const modified = { ...treeA, value: 'modified' };
    expect(qbTreesChanged([treeA], [modified])).toBe(true);
  });

  it('round-trip: blocks created from qbTrees produce unchanged result', () => {
    // Simulate renderListExplore: create blocks from list.qbTrees
    const originalTrees = [treeA, treeB];
    const blocks = originalTrees.map((tree, i) => ({
      id: i + 1,
      type: 'manual',
      label: 'Saved query',
      enabled: true,
      tree: JSON.parse(JSON.stringify(tree)),
    }));
    // Collect back and compare — should detect no change
    const collected = collectQbTrees(blocks);
    expect(qbTreesChanged(originalTrees, collected)).toBe(false);
  });
});
