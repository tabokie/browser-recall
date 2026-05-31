#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const SOURCE_SIZE = 128;
const EXTENSION_ARTWORK_SCALE = 1.16;
const DEFAULT_BACKGROUND = '#f4f0df';
const SNAPSHOT_BACKGROUND = '#ffe6f0';
const LIST_BACKGROUND = '#ff5f19';
const MIXED_BACKGROUND = '#6932e6';
const VIEWPORT_HEIGHT_PADDING_RATIO = 0.25;
const MACOS_ICON_SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const iconJobs = [
  {
    source: 'icons/browser-recall-default.svg',
    outputs: [['apps/desktop/src-tauri/icons/icon.png', 128]],
  },
  {
    source: 'icons/browser-recall-default-transparent.svg',
    outputs: [['apps/desktop/src-tauri/icons/tray-icon.png', 128]],
    artworkScale: EXTENSION_ARTWORK_SCALE,
  },
  {
    source: 'icons/browser-recall-default-transparent.svg',
    outputs: [
      ['apps/extension/icons/icon16.png', 16],
      ['apps/extension/icons/icon48.png', 48],
      ['apps/extension/icons/icon128.png', 128],
    ],
    artworkScale: EXTENSION_ARTWORK_SCALE,
    background: roundedBackground(DEFAULT_BACKGROUND),
  },
  {
    source: 'icons/browser-recall-stop-recording-transparent.svg',
    outputs: [
      ['apps/extension/icons/icon16-stop-recording.png', 16],
      ['apps/extension/icons/icon48-stop-recording.png', 48],
      ['apps/extension/icons/icon128-stop-recording.png', 128],
    ],
    artworkScale: EXTENSION_ARTWORK_SCALE,
    background: roundedBackground(DEFAULT_BACKGROUND),
  },
  {
    source: 'icons/browser-recall-default-transparent.svg',
    outputs: [
      ['apps/extension/icons/icon16-special-lists.png', 16],
      ['apps/extension/icons/icon48-special-lists.png', 48],
      ['apps/extension/icons/icon128-special-lists.png', 128],
    ],
    artworkScale: EXTENSION_ARTWORK_SCALE,
    background: roundedBackground(LIST_BACKGROUND),
    preserveEyeInterior: true,
  },
  {
    source: 'icons/browser-recall-default-transparent.svg',
    outputs: [
      ['apps/extension/icons/icon16-special-notes.png', 16],
      ['apps/extension/icons/icon48-special-notes.png', 48],
      ['apps/extension/icons/icon128-special-notes.png', 128],
    ],
    artworkScale: EXTENSION_ARTWORK_SCALE,
    background: roundedBackground(SNAPSHOT_BACKGROUND),
    preserveEyeInterior: true,
  },
  {
    source: 'icons/browser-recall-default-transparent.svg',
    outputs: [
      ['apps/extension/icons/icon16-special-mixed.png', 16],
      ['apps/extension/icons/icon48-special-mixed.png', 48],
      ['apps/extension/icons/icon128-special-mixed.png', 128],
    ],
    artworkScale: EXTENSION_ARTWORK_SCALE,
    background: roundedBackground(MIXED_BACKGROUND),
    preserveEyeInterior: true,
  },
];

function roundedBackground(fill) {
  return `<rect width="128" height="128" rx="28" fill="${fill}" />`;
}

export function resolveHeadlessBrowserPath({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  resolvePlaywrightExecutablePath = () => {
    try {
      return require('@playwright/test').chromium.executablePath();
    } catch {
      return null;
    }
  },
} = {}) {
  const override = env.BROWSER_RECALL_ICON_BROWSER;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(
      `BROWSER_RECALL_ICON_BROWSER points to a missing browser executable: ${override}`,
    );
  }

  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : platform === 'win32'
        ? [
            path.join(
              env.PROGRAMFILES || 'C:\\Program Files',
              'Google\\Chrome\\Application\\chrome.exe',
            ),
            path.join(
              env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
              'Google\\Chrome\\Application\\chrome.exe',
            ),
            path.join(
              env.LOCALAPPDATA || '',
              'Google\\Chrome\\Application\\chrome.exe',
            ),
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
          ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  const playwrightExecutablePath = resolvePlaywrightExecutablePath();
  if (playwrightExecutablePath && existsSync(playwrightExecutablePath)) {
    return playwrightExecutablePath;
  }

  throw new Error(
    'No headless Chromium-compatible browser found. Install Playwright browsers with `npx playwright install chromium`, install Chrome/Chromium, or set BROWSER_RECALL_ICON_BROWSER.',
  );
}

let browserPath = null;

function getHeadlessBrowserPath() {
  browserPath ||= resolveHeadlessBrowserPath();
  return browserPath;
}

export function generateAllIcons() {
  for (const job of iconJobs) {
    for (const [output, size] of job.outputs) {
      screenshotSvg(job.source, output, size, {
        artworkScale: job.artworkScale,
        background: job.background,
        preserveEyeInterior: job.preserveEyeInterior === true,
      });
    }
  }

  generateMacosIcon(
    'icons/browser-recall-default.svg',
    'apps/desktop/src-tauri/icons/icon.icns',
  );
}

export function assertMacosIconTooling({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error(
      'macOS .icns generation requires macOS iconutil. Run this script on macOS after changing icon SVG sources.',
    );
  }
  try {
    execFileSyncImpl('/usr/bin/which', ['iconutil'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'macOS .icns generation requires iconutil, but iconutil is not available.',
    );
  }
}

function screenshotSvg(
  source,
  output,
  size,
  {
    artworkScale = 1,
    background = null,
    cropToRenderSize = false,
    preserveEyeInterior = false,
    renderSize = SOURCE_SIZE,
  } = {},
) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-icon-'),
  );
  const sourcePath = path.join(tempDir, 'source.svg');
  let sourceSvg = fs.readFileSync(path.resolve(repoRoot, source), 'utf8');
  if (background) sourceSvg = injectSvgAfterOpenTag(sourceSvg, background);
  if (preserveEyeInterior) sourceSvg = addEyeInteriorFill(sourceSvg);
  if (artworkScale !== 1) sourceSvg = scaleSvgArtwork(sourceSvg, artworkScale);
  fs.writeFileSync(
    sourcePath,
    sourceSvg
      .replace(/width="128"/, `width="${renderSize}"`)
      .replace(/height="128"/, `height="${renderSize}"`),
  );
  const tempPng = path.join(tempDir, 'icon.png');
  const tempSquarePng = path.join(tempDir, 'icon-square.png');
  const screenshotHeight = cropToRenderSize
    ? renderSize + Math.ceil(renderSize * VIEWPORT_HEIGHT_PADDING_RATIO)
    : renderSize;
  try {
    execFileSync(
      getHeadlessBrowserPath(),
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--default-background-color=00000000',
        `--screenshot=${tempPng}`,
        `--window-size=${renderSize},${screenshotHeight}`,
        `file://${sourcePath}`,
      ],
      { stdio: 'ignore' },
    );
    const sourcePng = cropToRenderSize
      ? cropPng(tempPng, tempSquarePng, renderSize, renderSize)
      : tempPng;
    const outputPath = path.resolve(repoRoot, output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (size === renderSize) fs.copyFileSync(sourcePng, outputPath);
    else resizePng(sourcePng, outputPath, size, size);
    forceRgbaPng(outputPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function injectSvgAfterOpenTag(sourceSvg, markup) {
  return sourceSvg.replace(/(<svg\b[^>]*>)/, `$1\n  ${markup}`);
}

function addEyeInteriorFill(sourceSvg) {
  return sourceSvg.replace(
    /(<path\b[^>]*fill-rule="evenodd"[^>]*\/>)/,
    `$1
    <circle cx="43" cy="64" r="12" fill="${DEFAULT_BACKGROUND}" />
    <circle cx="85" cy="64" r="12" fill="${DEFAULT_BACKGROUND}" />`,
  );
}

function scaleSvgArtwork(sourceSvg, scale) {
  return sourceSvg.replace(
    /(<g\b[^>]*transform=")([^"]*)("[^>]*>)/,
    `$1translate(64 64) scale(${scale}) translate(-64 -64) $2$3`,
  );
}

function generateMacosIcon(source, output) {
  assertMacosIconTooling();
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-macos-icon-'),
  );
  const iconsetDir = path.join(tempDir, 'BrowserRecall.iconset');
  fs.mkdirSync(iconsetDir);
  try {
    for (const [name, size] of MACOS_ICON_SIZES) {
      screenshotSvg(source, path.join(iconsetDir, name), size, {
        cropToRenderSize: true,
        renderSize: size,
      });
    }
    validateMacosIconset(iconsetDir);
    const outputPath = path.resolve(repoRoot, output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', outputPath], {
      stdio: 'ignore',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function resizePng(sourcePath, outputPath, width, height) {
  const parsed = parsePng(fs.readFileSync(sourcePath));
  const channels = parsed.colorType === 6 ? 4 : 3;
  const pixels = unfilterPng(parsed);
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * channels + 1)] = 0;
    const sourceY = Math.min(
      parsed.height - 1,
      Math.floor((y * parsed.height) / height),
    );
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(
        parsed.width - 1,
        Math.floor((x * parsed.width) / width),
      );
      const sourceIndex = (sourceY * parsed.width + sourceX) * channels;
      const outputIndex = y * (width * channels + 1) + 1 + x * channels;
      pixels.copy(raw, outputIndex, sourceIndex, sourceIndex + channels);
    }
  }

  fs.writeFileSync(
    outputPath,
    encodePng({
      width,
      height,
      colorType: parsed.colorType,
      raw,
    }),
  );
}

function cropPng(sourcePath, outputPath, width, height) {
  const parsed = parsePng(fs.readFileSync(sourcePath));
  if (parsed.width < width || parsed.height < height) {
    throw new Error(
      `Cannot crop ${sourcePath} to ${width}x${height}; source is ${parsed.width}x${parsed.height}`,
    );
  }

  const channels = parsed.colorType === 6 ? 4 : 3;
  const pixels = unfilterPng(parsed);
  const croppedStride = width * channels;
  const raw = Buffer.alloc((croppedStride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (croppedStride + 1)] = 0;
    pixels.copy(
      raw,
      y * (croppedStride + 1) + 1,
      y * parsed.width * channels,
      y * parsed.width * channels + croppedStride,
    );
  }

  fs.writeFileSync(
    outputPath,
    encodePng({
      width,
      height,
      colorType: parsed.colorType,
      raw,
    }),
  );
  return outputPath;
}

function validateMacosIconset(iconsetDir) {
  for (const [name, size] of MACOS_ICON_SIZES) {
    const iconPath = path.join(iconsetDir, name);
    const parsed = parsePng(fs.readFileSync(iconPath));
    const pixels = unfilterPng(parsed);
    const channels = parsed.colorType === 6 ? 4 : 3;
    const centerX = Math.floor(size / 2);
    const lowerY = Math.floor(size * 0.86);
    const alpha =
      channels === 4
        ? pixels[(lowerY * parsed.width + centerX) * channels + 3]
        : 255;
    if (alpha !== 255) {
      throw new Error(
        `Generated macOS icon ${name} is clipped near the lower center`,
      );
    }
  }
}

function forceRgbaPng(filePath) {
  const png = fs.readFileSync(filePath);
  const parsed = parsePng(png);
  if (parsed.colorType === 6) return;
  if (parsed.colorType !== 2) {
    throw new Error(
      `Unsupported PNG color type ${parsed.colorType} in ${filePath}`,
    );
  }

  const rgb = unfilterPng(parsed);
  const rgbaStride = parsed.width * 4;
  const rawRgba = Buffer.alloc((rgbaStride + 1) * parsed.height);
  for (let y = 0; y < parsed.height; y += 1) {
    rawRgba[y * (rgbaStride + 1)] = 0;
    for (let x = 0; x < parsed.width; x += 1) {
      const rgbIndex = y * parsed.width * 3 + x * 3;
      const rgbaIndex = y * (rgbaStride + 1) + 1 + x * 4;
      rawRgba[rgbaIndex] = rgb[rgbIndex];
      rawRgba[rgbaIndex + 1] = rgb[rgbIndex + 1];
      rawRgba[rgbaIndex + 2] = rgb[rgbIndex + 2];
      rawRgba[rgbaIndex + 3] = 255;
    }
  }

  fs.writeFileSync(
    filePath,
    encodePng({
      width: parsed.width,
      height: parsed.height,
      colorType: 6,
      raw: rawRgba,
    }),
  );
}

function parsePng(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Invalid PNG signature');
  }

  let offset = 8;
  const idatChunks = [];
  const parsed = {};
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      parsed.width = data.readUInt32BE(0);
      parsed.height = data.readUInt32BE(4);
      parsed.bitDepth = data[8];
      parsed.colorType = data[9];
      parsed.compression = data[10];
      parsed.filter = data[11];
      parsed.interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }

  if (
    parsed.bitDepth !== 8 ||
    parsed.compression !== 0 ||
    parsed.filter !== 0 ||
    parsed.interlace !== 0
  ) {
    throw new Error('Unsupported PNG format');
  }
  parsed.data = zlib.inflateSync(Buffer.concat(idatChunks));
  return parsed;
}

function unfilterPng(parsed) {
  const channels = parsed.colorType === 6 ? 4 : 3;
  const stride = parsed.width * channels;
  const output = Buffer.alloc(parsed.height * stride);
  let rawOffset = 0;

  for (let y = 0; y < parsed.height; y += 1) {
    const filter = parsed.data[rawOffset];
    rawOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? output[y * stride + x - channels] : 0;
      const up = y > 0 ? output[(y - 1) * stride + x] : 0;
      const upLeft =
        y > 0 && x >= channels ? output[(y - 1) * stride + x - channels] : 0;
      let value = parsed.data[rawOffset];
      rawOffset += 1;
      if (filter === 1) {
        value = (value + left) & 255;
      } else if (filter === 2) {
        value = (value + up) & 255;
      } else if (filter === 3) {
        value = (value + Math.floor((left + up) / 2)) & 255;
      } else if (filter === 4) {
        const pa = Math.abs(up - upLeft);
        const pb = Math.abs(left - upLeft);
        const pc = Math.abs(left + up - 2 * upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = (value + predictor) & 255;
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG filter ${filter}`);
      }
      output[y * stride + x] = value;
    }
  }

  return output;
}

function encodePng({ width, height, colorType, raw }) {
  const chunks = [
    pngChunk(
      'IHDR',
      Buffer.from([
        ...uint32be(width),
        ...uint32be(height),
        8,
        colorType,
        0,
        0,
        0,
      ]),
    ),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ...chunks]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  return Buffer.concat([
    Buffer.from(uint32be(data.length)),
    typeBuffer,
    data,
    Buffer.from(uint32be(crc32(Buffer.concat([typeBuffer, data])))),
  ]);
}

function uint32be(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  generateAllIcons();
}
