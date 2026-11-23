#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { macAppStoreBundle } from './build-tauri-app.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const identifier = 'app.browser-recall.desktop';

function command(executable, args, input) {
  const result = spawnSync(executable, args, { encoding: 'utf8', input });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout || result.stderr;
}

function plistJson(input, key) {
  const args = key ? ['-extract', key, 'json'] : ['-convert', 'json'];
  return JSON.parse(command('plutil', [...args, '-o', '-', '--', '-'], input));
}

function verifyStoreBundle(buildNumber) {
  const contents = path.join(macAppStoreBundle, 'Contents');
  const infoPath = path.join(contents, 'Info.plist');
  if (!existsSync(infoPath))
    throw new Error(
      `Build the Mac App Store bundle first at ${macAppStoreBundle}`,
    );
  const info = plistJson(
    command('plutil', ['-convert', 'xml1', '-o', '-', infoPath]),
  );
  if (info.CFBundleIdentifier !== identifier)
    throw new Error('Unexpected Mac App Store bundle identifier');
  if (buildNumber && info.CFBundleVersion !== buildNumber) {
    throw new Error(
      `Expected build ${buildNumber}, found ${info.CFBundleVersion}`,
    );
  }

  command('plutil', [
    '-lint',
    path.join(contents, 'Resources/PrivacyInfo.xcprivacy'),
  ]);
  command('codesign', ['--verify', '--deep', '--strict', macAppStoreBundle]);
  const entitlements = plistJson(
    command('codesign', [
      '-d',
      '--entitlements',
      '-',
      '--xml',
      macAppStoreBundle,
    ]),
  );
  const expectedEntitlements = plistJson(
    command('plutil', [
      '-convert',
      'xml1',
      '-o',
      '-',
      path.join(repoRoot, 'scripts/app-store.entitlements'),
    ]),
  );
  for (const [key, value] of Object.entries(expectedEntitlements)) {
    if (entitlements[key] !== value)
      throw new Error(`Missing Mac App Store entitlement ${key}`);
  }
  if (entitlements['com.apple.security.get-task-allow'])
    throw new Error('The Store bundle permits debugger attachment');
  if (!buildNumber) return info;

  const profile = command('security', [
    'cms',
    '-D',
    '-i',
    path.join(contents, 'embedded.provisionprofile'),
  ]);
  const expiry = command(
    'plutil',
    ['-extract', 'ExpirationDate', 'raw', '-o', '-', '--', '-'],
    profile,
  );
  if (!(Date.parse(expiry.trim()) > Date.now()))
    throw new Error('The Mac App Store provisioning profile has expired');
  const profileEntitlements = plistJson(profile, 'Entitlements');
  const team = entitlements['com.apple.developer.team-identifier'];
  const appIdentifier = entitlements['com.apple.application-identifier'];
  if (
    !team ||
    team !== profileEntitlements['com.apple.developer.team-identifier'] ||
    !appIdentifier?.endsWith(`.${identifier}`) ||
    appIdentifier !== profileEntitlements['com.apple.application-identifier'] ||
    profileEntitlements['com.apple.security.get-task-allow']
  ) {
    throw new Error(
      'The signing entitlements do not match a distribution profile for Browser Recall',
    );
  }
  const signature = command('codesign', [
    '-dv',
    '--verbose=4',
    macAppStoreBundle,
  ]);
  if (
    !signature.split('\n').includes(`TeamIdentifier=${team}`) ||
    !/^Authority=(Apple Distribution|3rd Party Mac Developer Application):/m.test(
      signature,
    )
  ) {
    throw new Error(
      'The bundle requires a Mac App Store distribution signature',
    );
  }

  const certificates = command(
    'plutil',
    ['-extract', 'DeveloperCertificates', 'xml1', '-o', '-', '--', '-'],
    profile,
  );
  const certificateDir = mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-store-certificates-'),
  );
  try {
    const certificatePrefix = path.join(certificateDir, 'certificate-');
    command('codesign', [
      '-d',
      `--extract-certificates=${certificatePrefix}`,
      macAppStoreBundle,
    ]);
    const signer = readFileSync(`${certificatePrefix}0`);
    const allowed = Array.from(
      certificates.matchAll(/<data>([\s\S]*?)<\/data>/g),
      ([, data]) => Buffer.from(data, 'base64'),
    );
    if (!allowed.some((certificate) => certificate.equals(signer))) {
      throw new Error(
        'The distribution certificate is missing from the provisioning profile',
      );
    }
  } finally {
    rmSync(certificateDir, { recursive: true });
  }
  return info;
}

try {
  const [mode, buildNumber] = process.argv.slice(2);
  if (mode === '--verify-local' && !buildNumber) {
    verifyStoreBundle();
    console.log(`Verified ${macAppStoreBundle}`);
  } else if (
    mode === '--package' &&
    /^\d+(?:\.\d+){0,2}$/.test(buildNumber ?? '')
  ) {
    const installerIdentity = process.env.MAC_INSTALLER_DISTRIBUTION_IDENTITY;
    if (!installerIdentity)
      throw new Error('Set MAC_INSTALLER_DISTRIBUTION_IDENTITY');
    const info = verifyStoreBundle(buildNumber);
    const version = info.CFBundleShortVersionString;
    if (!/^\d+(?:\.\d+){0,2}$/.test(version))
      throw new Error('Unexpected Mac App Store version');
    const outputDir = path.join(repoRoot, 'dist/mac-app-store');
    mkdirSync(outputDir, { recursive: true });
    const output = path.join(
      outputDir,
      `Browser Recall-${version}-build-${buildNumber}.pkg`,
    );
    if (existsSync(output))
      throw new Error(`Installer already exists at ${output}`);
    const staging = mkdtempSync(path.join(outputDir, '.package-'));
    try {
      const installer = path.join(staging, 'Browser Recall.pkg');
      command('xcrun', [
        'productbuild',
        '--sign',
        installerIdentity,
        '--component',
        macAppStoreBundle,
        '/Applications',
        installer,
      ]);
      const signature = command('pkgutil', ['--check-signature', installer]);
      if (
        !/(Mac Installer Distribution|3rd Party Mac Developer Installer):/.test(
          signature,
        )
      ) {
        throw new Error(
          'The installer requires a Mac Installer Distribution signature',
        );
      }
      linkSync(installer, output);
      console.log(signature);
    } finally {
      rmSync(staging, { recursive: true });
    }
    console.log(output);
  } else {
    throw new Error('Use --verify-local or --package BUILD_NUMBER');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
