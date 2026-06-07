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

  it('keeps arrays as structural parts and ignores legacy strings', () => {
    expect(highlightExcerptParts('first\nsecond')).toEqual([]);
    expect(highlightExcerptParts(['first', 'second'])).toEqual([
      'first',
      'second',
    ]);
  });
});
