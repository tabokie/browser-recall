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

export function finalizeMacosAppBundle(appPath, environment = process.env) {
  if (process.platform !== 'darwin') return;
  if (!appPath || !existsSync(appPath)) {
    throw new Error(
      `macOS app bundle is missing: ${appPath || '<unspecified>'}`,
    );
  }
  if (
    environment.APPLE_SIGNING_IDENTITY &&
    environment.APPLE_SIGNING_IDENTITY !== '-'
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

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  finalizeMacosAppBundle(process.argv[2]);
}
