#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const defaultCargoReleaseDir = path.join(repoRoot, 'target/release');
const defaultOutDir = path.join(repoRoot, 'dist/desktop');

function defaultPlatformName() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

function executableName(platformName) {
  return platformName === 'windows'
    ? 'browser-recall-desktop.exe'
    : 'browser-recall-desktop';
}

function bundleSourceName(platformName, bundleName) {
  if (platformName === 'macos' && bundleName === 'app') return 'macos';
  return bundleName;
}

function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return false;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
  return true;
}

function copyReleaseExecutable(cargoReleaseDir, platformOutDir, platformName) {
  const name = executableName(platformName);
  const source = path.join(cargoReleaseDir, name);
  const destination = path.join(platformOutDir, 'bin', name);
  if (!copyIfExists(source, destination)) {
    throw new Error(`Missing release executable: ${source}`);
  }
}

function copyBundles(cargoReleaseDir, platformOutDir, platformName, bundles) {
  const bundleDir = path.join(cargoReleaseDir, 'bundle');
  for (const bundleName of bundles) {
    const source = path.join(
      bundleDir,
      bundleSourceName(platformName, bundleName),
    );
    const destination = path.join(platformOutDir, bundleName);
    if (!copyIfExists(source, destination)) {
      throw new Error(`Missing ${bundleName} bundle output: ${source}`);
    }
  }
}

function parseBundles(args) {
  const bundles = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--bundles' || arg === '--bundle') {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      bundles.push(...value.split(',').filter(Boolean));
      index += 1;
    }
  }
  return bundles;
}

export function collectDesktopArtifacts({
  cargoReleaseDir = defaultCargoReleaseDir,
  outDir = defaultOutDir,
  platformName = defaultPlatformName(),
  bundles = [],
} = {}) {
  const platformOutDir = path.join(outDir, platformName);
  fs.rmSync(platformOutDir, { recursive: true, force: true });
  fs.mkdirSync(platformOutDir, { recursive: true });
  copyReleaseExecutable(cargoReleaseDir, platformOutDir, platformName);
  copyBundles(cargoReleaseDir, platformOutDir, platformName, bundles);
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundles = parseBundles(process.argv.slice(2));
  if (bundles.length === 0) {
    throw new Error(
      'Usage: node scripts/collect-desktop-artifacts.mjs --bundles <app|dmg>',
    );
  }
  console.log(collectDesktopArtifacts({ bundles }));
}
