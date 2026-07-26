import { describe, expect, it } from 'vitest';
import {
  formatHighlightExcerpt,
  highlightExcerptParts,
} from '../../packages/core/highlight-format.js';

describe('formatHighlightExcerpt', () => {
  it('preserves explicit newline excerpts', () => {
    expect(formatHighlightExcerpt(['first\nsecond'])).toBe('first\nsecond');
    expect(formatHighlightExcerpt(['first', 'second'])).toBe('first\nsecond');
  });

  it('keeps arrays as structural parts and rejects non-canonical excerpts', () => {
    expect(highlightExcerptParts(['first', 'second'])).toEqual([
      'first',
      'second',
    ]);
    for (const excerpt of [null, [], 'first\nsecond', ['valid', ''], [1]]) {
      expect(() => highlightExcerptParts(excerpt)).toThrow(
        'Highlight excerpt must be a non-empty string array',
      );
    }
  });
});
