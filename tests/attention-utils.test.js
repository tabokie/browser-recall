/**
 * Attention utility tests.
 *
 * Verifies attentionStrength scoring, including the likes component.
 */
import { describe, it, expect } from 'vitest';
import { attentionStrength, parseAttention } from '../extension/attention-utils.js';

describe('attentionStrength', () => {
  it('returns 0 for empty attention', () => {
    expect(attentionStrength({})).toBe(0);
  });

  it('scores timeOnPage (minutes, capped at 10)', () => {
    expect(attentionStrength({ timeOnPage: 60000 })).toBe(1);   // 1 minute
    expect(attentionStrength({ timeOnPage: 600000 })).toBe(10);  // 10 minutes (cap)
    expect(attentionStrength({ timeOnPage: 1200000 })).toBe(10); // 20 minutes (still capped at 10)
  });

  it('scores scrollDepth (0-2 range)', () => {
    expect(attentionStrength({ scrollDepth: 100 })).toBe(2);  // 100% = 2
    expect(attentionStrength({ scrollDepth: 50 })).toBe(1);   // 50% = 1
  });

  it('scores likes (1 per like, capped at 5)', () => {
    expect(attentionStrength({ likes: 1 })).toBe(1);
    expect(attentionStrength({ likes: 3 })).toBe(3);
    expect(attentionStrength({ likes: 5 })).toBe(5);
    expect(attentionStrength({ likes: 10 })).toBe(5); // capped
  });

  it('combines all metrics', () => {
    const att = { timeOnPage: 120000, scrollDepth: 100, likes: 3 };
    // timeOnPage: 120000/60000 = 2, scrollDepth: 100/100*2 = 2, likes: min(3,5) = 3
    expect(attentionStrength(att)).toBe(7);
  });

  it('max score is 17 (10 + 2 + 5)', () => {
    const att = { timeOnPage: 999999999, scrollDepth: 100, likes: 100 };
    expect(attentionStrength(att)).toBe(17);
  });
});

describe('parseAttention', () => {
  it('parses JSON string attention', () => {
    const result = parseAttention({ attention: '{"scrollDepth":80,"timeOnPage":5000,"likes":2}' });
    expect(result).toEqual({ scrollDepth: 80, timeOnPage: 5000, likes: 2 });
  });

  it('returns object attention as-is', () => {
    const att = { scrollDepth: 50 };
    expect(parseAttention({ attention: att })).toBe(att);
  });

  it('returns null for missing attention', () => {
    expect(parseAttention({})).toBeNull();
  });
});
