import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  encodeMacosIcns,
  resolveHeadlessBrowserPath,
  resizeRgbaPixelsWithAreaResampling,
} from '../../scripts/generate-icons.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function readPngDimensions(filePath) {
  const png = Buffer.isBuffer(filePath) ? filePath : fs.readFileSync(filePath);
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

describe('desktop icon assets', () => {
  it('keeps a high-resolution PNG for desktop platforms', () => {
    expect(
      readPngDimensions(
        path.join(repoRoot, 'apps/desktop/src-tauri/icons/icon.png'),
      ),
    ).toEqual({ width: 1024, height: 1024 });
  });

  it('keeps every Windows shell size in the committed ICO', () => {
    const ico = fs.readFileSync(
      path.join(repoRoot, 'apps/desktop/src-tauri/icons/icon.ico'),
    );
    const count = ico.readUInt16LE(4);
    const representations = Array.from({ length: count }, (_, index) => {
      const entryOffset = 6 + index * 16;
      const value = ico[entryOffset];
      const size = value === 0 ? 256 : value;
      const imageOffset = ico.readUInt32LE(entryOffset + 12);
      return {
        size,
        png: readPngDimensions(ico.subarray(imageOffset)),
      };
    });

    expect(representations).toEqual(
      [16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 256].map(
        (size) => ({
          size,
          png: { width: size, height: size },
        }),
      ),
    );
  });

  it('keeps all modern standard and Retina slots in the committed ICNS', () => {
    const icns = fs.readFileSync(
      path.join(repoRoot, 'apps/desktop/src-tauri/icons/icon.icns'),
    );
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const types = [];
    let offset = 8;
    while (offset < icns.length) {
      types.push(icns.subarray(offset, offset + 4).toString('ascii'));
      offset += icns.readUInt32BE(offset + 4);
    }

    expect(types).toEqual([
      'icp4',
      'icp5',
      'ic11',
      'icp6',
      'ic12',
      'ic07',
      'ic08',
      'ic13',
      'ic09',
      'ic14',
      'ic10',
    ]);
  });
});

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

describe('platform icon encoding', () => {
  it('area-resamples every source pixel instead of selecting one nearest neighbor', () => {
    const pixels = Buffer.from([
      0, 0, 0, 255, 100, 0, 0, 255, 0, 100, 0, 255, 100, 100, 0, 255,
    ]);

    expect(resizeRgbaPixelsWithAreaResampling(pixels, 2, 2, 1, 1)).toEqual(
      Buffer.from([50, 50, 0, 255]),
    );
  });

  it('encodes modern PNG-backed macOS icon slots without iconutil', () => {
    const png16 = Buffer.from('png-16');
    const png1024 = Buffer.from('png-1024');
    const icns = encodeMacosIcns([
      { type: 'icp4', png: png16 },
      { type: 'ic10', png: png1024 },
    ]);

    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(icns.subarray(8, 12).toString('ascii')).toBe('icp4');
    expect(icns.readUInt32BE(12)).toBe(png16.length + 8);
    const secondOffset = 16 + png16.length;
    expect(
      icns.subarray(secondOffset, secondOffset + 4).toString('ascii'),
    ).toBe('ic10');
    expect(icns.readUInt32BE(secondOffset + 4)).toBe(png1024.length + 8);
  });
});
