#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(output || `${command} exited with status ${result.status}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

export function finalizeMacosAppBundle(appPath) {
  if (process.platform !== 'darwin') return;
  if (!appPath || !existsSync(appPath)) {
    throw new Error(
      `macOS app bundle is missing: ${appPath || '<unspecified>'}`,
    );
  }
  if (
    process.env.APPLE_SIGNING_IDENTITY &&
    process.env.APPLE_SIGNING_IDENTITY !== '-'
  ) {
    return;
  }

  const identifier = run('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleIdentifier',
    path.join(appPath, 'Contents/Info.plist'),
  ]);
  if (!/^[A-Za-z0-9.-]+$/.test(identifier)) {
    throw new Error(
      `Invalid CFBundleIdentifier for code signing: ${identifier}`,
    );
  }
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--options',
    'runtime',
    '--preserve-metadata=entitlements',
    '--requirements',
    `=designated => identifier "${identifier}"`,
    appPath,
  ]);
}

export function requireAppleSigningIdentity() {
  if (process.platform !== 'darwin') return;
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!identity || identity === '-') {
    throw new Error(
      'DMG builds require APPLE_SIGNING_IDENTITY with an installed Apple signing certificate',
    );
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  if (process.argv[2] === '--require-apple-identity') {
    requireAppleSigningIdentity();
  } else {
    finalizeMacosAppBundle(process.argv[2]);
  }
}
