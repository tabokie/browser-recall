import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('desktop scrollbar styling', () => {
  it('keeps the main scrollbars visible while hovered', () => {
    const html = readFileSync('apps/desktop/ui/index.html', 'utf8');

    expect(html).toContain('.main:hover,');
    expect(html).toContain('.sidebar-content:hover');
    expect(html).toContain('.main:hover::-webkit-scrollbar-thumb');
    expect(html).toContain('.sidebar-content:hover::-webkit-scrollbar-thumb');
  });
});
