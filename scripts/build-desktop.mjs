#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, readdirSync } from 'node:fs';
import { desktopBuildPlan } from './desktop-build-plan.mjs';
import { finalizeDesktopBuild } from './finalize-desktop-build.mjs';
import { desktopSigning } from './lib/desktop-signing.mjs';
import { createDesktopDiskImage } from './lib/desktop-disk-image.mjs';
import { readProductVersion } from './lib/product-version.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export function buildDesktop({
  signing = 'auto',
  purpose = 'local',
  platform = process.platform,
  environment = process.env,
  run = execFileSync,
  root = repoRoot,
  finalize = finalizeDesktopBuild,
} = {}) {
  const plan = desktopBuildPlan(platform, purpose);
  const policy = desktopSigning({
    signing: purpose === 'dmg' ? 'signed' : signing,
    platform,
    environment,
    run,
  });
  const options = { cwd: root, env: policy.environment, stdio: 'inherit' };
  const timed = (name, operation) => {
    const start = performance.now();
    let status = 'failed';
    try {
      const result = operation();
      status = 'passed';
      return result;
    } finally {
      const seconds = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`${name}: ${seconds}s (${status})`);
      if (environment.GITHUB_STEP_SUMMARY)
        appendFileSync(
          environment.GITHUB_STEP_SUMMARY,
          `- ${name}: ${seconds}s (${status})\n`,
        );
    }
  };
  timed('Desktop UI staging', () =>
    run(
      process.execPath,
      [path.join(root, 'scripts/stage-app-assets.mjs'), 'desktop-ui'],
      options,
    ),
  );
  const args = [...plan.tauriArgs];
  if (policy.config) args.push('--config', JSON.stringify(policy.config));
  timed('Desktop native build', () =>
    run(
      process.execPath,
      [path.join(root, 'scripts/build-tauri-app.mjs'), ...args],
      options,
    ),
  );
  const cargoReleaseDir = path.join(root, 'target/release');
  const bundleFiles = {};
  if (plan.bundles.includes('nsis')) {
    const version = readProductVersion(root);
    const installers = readdirSync(
      path.join(cargoReleaseDir, 'bundle/nsis'),
    ).filter(
      (name) =>
        name.includes(`_${version}_${process.arch}`) &&
        name.endsWith('-setup.exe'),
    );
    if (installers.length !== 1)
      throw new Error(
        'Expected exactly one NSIS installer for the current version and architecture',
      );
    bundleFiles.nsis = installers;
  }
  const name =
    platform === 'win32'
      ? 'browser-recall-desktop.exe'
      : 'browser-recall-desktop';
  const outDir = timed('Desktop signing, verification and collection', () => {
    policy.signExecutable(path.join(cargoReleaseDir, name));
    return finalize({
      platform,
      environment: policy.environment,
      cargoReleaseDir,
      outDir: path.join(root, 'dist/desktop'),
      bundles: plan.bundles,
      bundleFiles,
      verifySignature: policy.verify,
      packageArtifacts:
        purpose === 'dmg'
          ? (staged) =>
              createDesktopDiskImage(
                path.join(staged, 'app/Browser Recall.app'),
                path.join(staged, 'dmg/Browser Recall.dmg'),
              )
          : undefined,
    });
  });
  const artifacts = {
    outDir,
    executable: path.join(outDir, plan.artifactPlatform, 'bin', name),
    ...(plan.verifyMacosApp
      ? { app: path.join(outDir, 'macos/app/Browser Recall.app') }
      : {}),
  };
  if (purpose === 'dmg')
    artifacts.diskImage = path.join(outDir, 'macos/dmg/Browser Recall.dmg');
  return artifacts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3)
      throw new Error('Usage: build-desktop.mjs [auto|unsigned|signed|dmg]');
    const mode = process.argv[2] || 'auto';
    const artifacts = buildDesktop(
      mode === 'dmg' ? { purpose: 'dmg' } : { signing: mode },
    );
    console.log(artifacts.diskImage || artifacts.app || artifacts.executable);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
