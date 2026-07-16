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
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    throw new Error(output || `${command} exited with status ${result.status}`);
  }
  return output;
}

export function validateMacosSignatureMetadata(
  details,
  plistIdentifier,
  requirements,
) {
  const signedIdentifier = details.match(/^Identifier=(.+)$/m)?.[1];
  if (signedIdentifier !== plistIdentifier) {
    throw new Error(
      `Signed identifier ${signedIdentifier || '<missing>'} does not match CFBundleIdentifier ${plistIdentifier}`,
    );
  }
  if (!/^CodeDirectory .*flags=.*\bruntime\b/m.test(details)) {
    throw new Error('The app signature does not enable hardened runtime');
  }
  if (/^Info\.plist=not bound$/m.test(details)) {
    throw new Error('The app signature does not bind Info.plist');
  }
  if (/^Sealed Resources=none$/m.test(details)) {
    throw new Error('The app signature does not seal bundle resources');
  }
  if (/designated\s*=>\s*cdhash\b/.test(requirements)) {
    throw new Error(
      'The app designated requirement is pinned to this build CDHash',
    );
  }
  if (!requirements.includes(`identifier "${plistIdentifier}"`)) {
    throw new Error(
      'The app designated requirement does not contain its bundle identifier',
    );
  }
}

export function verifyMacosAppBundle(appPath) {
  if (process.platform !== 'darwin') return;
  if (!appPath || !existsSync(appPath)) {
    throw new Error(
      `macOS app bundle is missing: ${appPath || '<unspecified>'}`,
    );
  }

  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    appPath,
  ]);
  const details = run('/usr/bin/codesign', ['-dvvv', appPath]);
  const plistIdentifier = run('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleIdentifier',
    path.join(appPath, 'Contents/Info.plist'),
  ]);
  const requirements = run('/usr/bin/codesign', ['-d', '-r-', appPath]);
  validateMacosSignatureMetadata(details, plistIdentifier, requirements);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const appPath = process.argv[2];
  verifyMacosAppBundle(appPath);
  if (process.platform === 'darwin') console.log(`Verified ${appPath}`);
}
