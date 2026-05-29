import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('desktop scrollbar styling', () => {
  it('hides the main scrollbar after scrolling settles while preserving sidebar hover visibility', () => {
    const html = readFileSync('apps/desktop/ui/index.html', 'utf8');

    expect(html).not.toContain('.main:hover,');
    expect(html).not.toContain('.main:hover::-webkit-scrollbar-thumb');
    expect(html).toContain('.main.is-scrolling,');
    expect(html).toContain('.main.is-scrolling::-webkit-scrollbar-thumb');
    expect(html).toContain('.main.is-scrollbar-hovered');
    expect(html).toContain(
      '.main.is-scrollbar-hovered::-webkit-scrollbar-thumb',
    );
    expect(html).toContain('.sidebar-content:hover');
    expect(html).toContain('.sidebar-content:hover::-webkit-scrollbar-thumb');
  });
});
