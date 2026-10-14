#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readProductVersion,
  validateProductVersion,
} from './lib/product-version.mjs';

export function createUpdateManifest({
  directory,
  version,
  repository,
  publishedAt = new Date().toISOString(),
}) {
  validateProductVersion(version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Invalid GitHub repository');
  const targets = [
    ['windows-x86_64', `windows-x64-setup.exe`],
    ['darwin-aarch64', `macos-arm64.app.tar.gz`],
    ['darwin-x86_64', `macos-x64.app.tar.gz`],
  ];
  const platforms = {};
  for (const [target, suffix] of targets) {
    const filename = `browser-recall-v${version}-${suffix}`;
    if (
      !statSync(path.join(directory, filename)).isFile() ||
      statSync(path.join(directory, filename)).size === 0
    )
      throw new Error(`Missing update package: ${filename}`);
    const signature = readFileSync(
      path.join(directory, `${filename}.sig`),
      'utf8',
    ).trim();
    if (!signature || !/^[a-zA-Z\d+/=\s]+$/.test(signature))
      throw new Error(`Invalid update signature: ${filename}`);
    platforms[target] = {
      url: `https://github.com/${repository}/releases/download/v${version}/${filename}`,
      signature,
    };
  }
  return {
    version,
    notes: `Browser Recall ${version}`,
    pub_date: publishedAt,
    platforms,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = readProductVersion();
  const directory = path.resolve('release-assets');
  const manifest = createUpdateManifest({
    directory,
    version,
    repository: process.env.GH_REPO,
  });
  writeFileSync(
    path.join(directory, 'latest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}
