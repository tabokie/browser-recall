#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktop } from './build-desktop.mjs';
import { createDesktopDiskImage } from './lib/desktop-disk-image.mjs';
import { verifyMacosAppBundle } from './verify-macos-app-bundle.mjs';
import { timeBuildStep } from './lib/build-timing.mjs';
import {
  readProductVersion,
  validateProductVersion,
} from './lib/product-version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');

export function packageDesktopRelease({
  platform = process.platform,
  arch = process.arch,
  version,
  outDir,
  artifacts,
}) {
  validateProductVersion(version);
  if (
    !['darwin', 'win32'].includes(platform) ||
    !['arm64', 'x64'].includes(arch) ||
    (platform === 'win32' && arch !== 'x64')
  )
    throw new Error('Unsupported release platform or architecture');
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY)
    throw new Error(
      'TAURI_SIGNING_PRIVATE_KEY is required for signed release packages',
    );
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(path.join(outDir, '.release-'));
  const prefix = `browser-recall-v${version}-${platform === 'darwin' ? 'macos' : 'windows'}-${arch}`;
  try {
    let update;
    if (platform === 'darwin') {
      const app = artifacts.app;
      timeBuildStep('Release app signature verification', () =>
        verifyMacosAppBundle(app),
      );
      const diskImage = path.join(work, `${prefix}.dmg`);
      timeBuildStep('Release disk image creation', () =>
        createDesktopDiskImage(app, diskImage),
      );
      renameSync(diskImage, path.join(outDir, `${prefix}.dmg`));
      update = path.join(work, `${prefix}.app.tar.gz`);
      timeBuildStep('Release update archive creation', () =>
        execFileSync(
          '/usr/bin/tar',
          [
            '--no-mac-metadata',
            '-czf',
            update,
            '-C',
            path.dirname(app),
            path.basename(app),
          ],
          { stdio: 'pipe' },
        ),
      );
    } else {
      const directory = path.join(artifacts.outDir, 'windows/nsis');
      const installers = readdirSync(directory).filter(
        (name) =>
          name.includes(`_${version}_x64`) && name.endsWith('-setup.exe'),
      );
      if (installers.length !== 1)
        throw new Error(
          'Expected exactly one NSIS installer for the release version',
        );
      update = path.join(work, `${prefix}-setup.exe`);
      timeBuildStep('Release installer staging', () =>
        cpSync(path.join(directory, installers[0]), update),
      );
    }
    // Sign the finalized package, after macOS bundle signing and resource sealing.
    // Suppress signer output so CI cannot expose key material through diagnostics.
    try {
      timeBuildStep('Release update package signing', () =>
        execFileSync(process.execPath, [cli, 'signer', 'sign', update], {
          stdio: 'pipe',
          env: {
            ...process.env,
            TAURI_SIGNING_PRIVATE_KEY: existsSync(
              process.env.TAURI_SIGNING_PRIVATE_KEY,
            )
              ? readFileSync(process.env.TAURI_SIGNING_PRIVATE_KEY, 'utf8')
              : process.env.TAURI_SIGNING_PRIVATE_KEY,
          },
        }),
      );
    } catch {
      throw new Error('Signing the desktop update package failed');
    }
    timeBuildStep('Release Cargo signature verification', () =>
      execFileSync(
        'cargo',
        [
          'test',
          '--locked',
          '--release',
          '-p',
          'browser-recall-desktop',
          '--test',
          'desktop_updates',
          'release_package_matches_embedded_public_key',
          '--',
          '--ignored',
        ],
        {
          cwd: root,
          env: { ...process.env, BROWSER_RECALL_VERIFY_UPDATE_PACKAGE: update },
          stdio: 'inherit',
        },
      ),
    );
    for (const file of [update, `${update}.sig`])
      renameSync(file, path.join(outDir, path.basename(file)));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = readProductVersion(root);
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY)
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is required for release builds');
  const artifacts = buildDesktop({ purpose: 'release' });
  packageDesktopRelease({
    version,
    outDir: path.join(root, 'release-assets'),
    artifacts,
  });
}
