import { describe, expect, it, vi } from 'vitest';

import {
  assertMacosIconTooling,
  resolveHeadlessBrowserPath,
} from '../../scripts/generate-icons.mjs';

describe('icon generation browser resolution', () => {
  it('uses an existing environment override first', () => {
    const browserPath = resolveHeadlessBrowserPath({
      env: { BROWSER_RECALL_ICON_BROWSER: '/tmp/chrome' },
      existsSync: vi.fn((candidate) => candidate === '/tmp/chrome'),
      resolvePlaywrightExecutablePath: vi.fn(() => '/tmp/playwright-chrome'),
    });

    expect(browserPath).toBe('/tmp/chrome');
  });

  it('rejects a missing environment override instead of silently using another browser', () => {
    expect(() =>
      resolveHeadlessBrowserPath({
        env: { BROWSER_RECALL_ICON_BROWSER: '/tmp/missing-chrome' },
        existsSync: vi.fn(() => false),
        resolvePlaywrightExecutablePath: vi.fn(() => '/tmp/playwright-chrome'),
      }),
    ).toThrow(/BROWSER_RECALL_ICON_BROWSER/);
  });

  it('falls back to Playwright Chromium when system browsers are missing', () => {
    const browserPath = resolveHeadlessBrowserPath({
      env: {},
      platform: 'linux',
      existsSync: vi.fn((candidate) => candidate === '/tmp/playwright-chrome'),
      resolvePlaywrightExecutablePath: vi.fn(() => '/tmp/playwright-chrome'),
    });

    expect(browserPath).toBe('/tmp/playwright-chrome');
  });
});

describe('macOS icon generation tooling', () => {
  it('rejects non-macOS platforms for icns generation', () => {
    expect(() =>
      assertMacosIconTooling({
        platform: 'linux',
        execFileSyncImpl: vi.fn(),
      }),
    ).toThrow(/requires macOS iconutil/);
  });

  it('checks iconutil availability on macOS', () => {
    const execFileSyncImpl = vi.fn();

    assertMacosIconTooling({
      platform: 'darwin',
      execFileSyncImpl,
    });

    expect(execFileSyncImpl).toHaveBeenCalledWith(
      '/usr/bin/which',
      ['iconutil'],
      {
        stdio: 'ignore',
      },
    );
  });

  it('fails clearly when iconutil is unavailable on macOS', () => {
    expect(() =>
      assertMacosIconTooling({
        platform: 'darwin',
        execFileSyncImpl: vi.fn(() => {
          throw new Error('missing');
        }),
      }),
    ).toThrow(/iconutil is not available/);
  });
});
