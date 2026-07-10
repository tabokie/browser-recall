import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mutation authority architecture invariant', () => {
  it('does not synthesize committed daemon mutations in extension command handlers', () => {
    const background = readFileSync(
      resolve('apps/extension/background.js'),
      'utf8',
    );

    expect(background).not.toContain('notifyMutation');
  });
});
