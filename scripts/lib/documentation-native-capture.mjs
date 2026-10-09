import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { documentationWallpaper } from './documentation-image-spec.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function compileDocumentationWindow(directory) {
  if (process.platform !== 'darwin') {
    throw new Error('Native documentation capture requires macOS');
  }
  const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);
  mkdirSync(directory, { recursive: true });
  const helper = path.join(directory, 'documentation-window');
  execFileSync('/usr/bin/swiftc', [
    '-module-cache-path',
    path.join(directory, 'swift-module-cache'),
    '-suppress-warnings',
    '-target',
    `${arch}-apple-macos14.0`,
    path.join(root, 'scripts/lib/documentation-window.swift'),
    '-o',
    helper,
  ]);
  return helper;
}

export async function captureDocumentationWindow({
  helper,
  pid,
  filename,
  spec,
  browserTitle,
  settle = true,
}) {
  const args = [
    String(pid),
    browserTitle ? 'capture-browser' : 'capture',
    filename,
  ];
  if (browserTitle) args.push(browserTitle);
  args.push(
    String(spec.outputPixels.width),
    String(spec.outputPixels.height),
    String(spec.paddingPoints),
    path.join(root, documentationWallpaper.file),
  );
  let previous;
  let stable = 0;
  const deadline = Date.now() + 15000;
  do {
    // Output dimensions cannot force 2× detail on a 1× display. Native font
    // rendering and display profiles may vary across machines and OS versions.
    execFileSync(helper, args, { timeout: 30000 });
    const bytes = readFileSync(filename);
    if (!settle) return bytes;
    const current = createHash('sha256').update(bytes).digest('hex');
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= 3) return bytes;
    await setTimeout(200);
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out waiting for ${path.basename(filename)} pixels to settle`,
  );
}
