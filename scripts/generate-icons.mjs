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
const SNAPSHOT_BACKGROUND = '#4969F6';
const LIST_BACKGROUND = '#ff5f19';
const MIXED_BACKGROUND = '#6932e6';
const WINDOWS_ICON_SIZES = [
  16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 256,
];
const MACOS_ICON_SLOTS = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['icp6', 64],
  ['ic12', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic13', 256],
  ['ic09', 512],
  ['ic14', 512],
  ['ic10', 1024],
];

const iconJobs = [
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
  generateWindowsAndLinuxDesktopIcons();

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

export function generateWindowsAndLinuxDesktopIcons() {
  const source = 'icons/browser-recall-default.svg';
  screenshotSvg(source, 'apps/desktop/src-tauri/icons/icon.png', 1024, {
    renderSize: 1024,
  });
  generateWindowsIcon(source, 'apps/desktop/src-tauri/icons/icon.ico');
}

export function encodeWindowsIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  let imageOffset = headerSize + entrySize * images.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  const payloads = [];

  for (const { size, png } of images) {
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new Error(`Invalid Windows icon size: ${size}`);
    }
    const entry = Buffer.alloc(entrySize);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    entries.push(entry);
    payloads.push(png);
    imageOffset += png.length;
  }

  return Buffer.concat([header, ...entries, ...payloads]);
}

export function generateWindowsIcon(source, output) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-windows-icon-'),
  );
  try {
    const images = WINDOWS_ICON_SIZES.map((size) => {
      const pngPath = path.join(tempDir, `icon-${size}.png`);
      screenshotSvg(source, pngPath, size, {
        renderSize: size,
      });
      forceRgbaPng(pngPath);
      return { size, png: fs.readFileSync(pngPath) };
    });
    const outputPath = path.resolve(repoRoot, output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encodeWindowsIco(images));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function screenshotSvg(
  source,
  output,
  size,
  {
    artworkScale = 1,
    background = null,
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
  try {
    execFileSync(
      getHeadlessBrowserPath(),
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--screenshot=${tempPng}`,
        `--window-size=${renderSize},${renderSize}`,
        `file://${sourcePath}`,
      ],
      { stdio: 'ignore' },
    );
    const sourcePng = tempPng;
    const outputPath = path.resolve(repoRoot, output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (size === renderSize) fs.copyFileSync(sourcePng, outputPath);
    else {
      forceRgbaPng(sourcePng);
      resizePngWithAreaResampling(sourcePng, outputPath, size, size);
    }
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
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-macos-icon-'),
  );
  try {
    const images = MACOS_ICON_SLOTS.map(([type, size]) => {
      const pngPath = path.join(tempDir, `${type}-${size}.png`);
      screenshotSvg(source, pngPath, size, {
        renderSize: size,
      });
      validateMacosIconPng(pngPath, size, type);
      return { type, png: fs.readFileSync(pngPath) };
    });
    const outputPath = path.resolve(repoRoot, output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encodeMacosIcns(images));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function encodeMacosIcns(images) {
  const chunks = images.map(({ type, png }) => {
    if (typeof type !== 'string' || Buffer.byteLength(type, 'ascii') !== 4) {
      throw new Error(`Invalid macOS icon slot type: ${type}`);
    }
    if (!Buffer.isBuffer(png) || png.length === 0) {
      throw new Error(`macOS icon slot ${type} must contain PNG bytes`);
    }
    return Buffer.concat([
      Buffer.from(type, 'ascii'),
      Buffer.from(uint32be(png.length + 8)),
      png,
    ]);
  });
  const length = 8 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  return Buffer.concat([
    Buffer.from('icns', 'ascii'),
    Buffer.from(uint32be(length)),
    ...chunks,
  ]);
}

function resizePngWithAreaResampling(sourcePath, outputPath, width, height) {
  const parsed = parsePng(fs.readFileSync(sourcePath));
  if (parsed.colorType !== 6) {
    throw new Error(
      `Area-resampled PNG must be RGBA, received color type ${parsed.colorType}`,
    );
  }
  const pixels = unfilterPng(parsed);
  const resized = resizeRgbaPixelsWithAreaResampling(
    pixels,
    parsed.width,
    parsed.height,
    width,
    height,
  );
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * (width * 4 + 1);
    raw[rawOffset] = 0;
    resized.copy(raw, rawOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  fs.writeFileSync(
    outputPath,
    encodePng({
      width,
      height,
      colorType: 6,
      raw,
    }),
  );
}

export function resizeRgbaPixelsWithAreaResampling(
  pixels,
  sourceWidth,
  sourceHeight,
  width,
  height,
) {
  if (
    !Buffer.isBuffer(pixels) ||
    pixels.length !== sourceWidth * sourceHeight * 4
  ) {
    throw new Error('RGBA source pixel length does not match its dimensions');
  }
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceTop = (y * sourceHeight) / height;
    const sourceBottom = ((y + 1) * sourceHeight) / height;
    const firstY = Math.floor(sourceTop);
    const lastY = Math.ceil(sourceBottom);
    for (let x = 0; x < width; x += 1) {
      const sourceLeft = (x * sourceWidth) / width;
      const sourceRight = ((x + 1) * sourceWidth) / width;
      const firstX = Math.floor(sourceLeft);
      const lastX = Math.ceil(sourceRight);
      let weightedAlpha = 0;
      let weightedRed = 0;
      let weightedGreen = 0;
      let weightedBlue = 0;
      let totalWeight = 0;
      for (let sourceY = firstY; sourceY < lastY; sourceY += 1) {
        const yWeight =
          Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY);
        for (let sourceX = firstX; sourceX < lastX; sourceX += 1) {
          const xWeight =
            Math.min(sourceRight, sourceX + 1) - Math.max(sourceLeft, sourceX);
          const weight = xWeight * yWeight;
          const index = (sourceY * sourceWidth + sourceX) * 4;
          const alpha = pixels[index + 3] / 255;
          weightedAlpha += alpha * weight;
          weightedRed += pixels[index] * alpha * weight;
          weightedGreen += pixels[index + 1] * alpha * weight;
          weightedBlue += pixels[index + 2] * alpha * weight;
          totalWeight += weight;
        }
      }
      const outputIndex = (y * width + x) * 4;
      const outputAlpha = weightedAlpha / totalWeight;
      if (weightedAlpha > 0) {
        output[outputIndex] = Math.round(weightedRed / weightedAlpha);
        output[outputIndex + 1] = Math.round(weightedGreen / weightedAlpha);
        output[outputIndex + 2] = Math.round(weightedBlue / weightedAlpha);
      }
      output[outputIndex + 3] = Math.round(outputAlpha * 255);
    }
  }
  return output;
}

function validateMacosIconPng(iconPath, size, type) {
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
      `Generated macOS icon ${type} is clipped near the lower center`,
    );
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
