#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

import { collectDesktopArtifacts } from './collect-desktop-artifacts.mjs';
import { desktopBuildPlan } from './desktop-build-plan.mjs';
import { finalizeMacosAppBundle } from './finalize-macos-app-bundle.mjs';
import { verifyMacosAppBundle } from './verify-macos-app-bundle.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

export function finalizeDesktopBuild({
  platform = process.platform,
  finalizeMacosApp = finalizeMacosAppBundle,
  collect = collectDesktopArtifacts,
  verifyMacosApp = verifyMacosAppBundle,
  environment = process.env,
  cargoReleaseDir = path.join(repoRoot, 'target/release'),
  outDir = path.join(repoRoot, 'dist/desktop'),
  bundles = desktopBuildPlan(platform).bundles,
  verifySignature,
  packageArtifacts,
  bundleFiles = {},
} = {}) {
  const plan = desktopBuildPlan(platform);
  if (plan.finalizeMacosApp)
    finalizeMacosApp(
      path.join(cargoReleaseDir, 'bundle/macos/Browser Recall.app'),
      environment,
    );
  return collect({
    cargoReleaseDir,
    outDir,
    bundles: [...bundles],
    bundleFiles,
    platformName: plan.artifactPlatform,
    verify: (staged) => {
      const file = plan.verifyMacosApp
        ? path.join(staged, 'app/Browser Recall.app')
        : path.join(
            staged,
            'bin',
            platform === 'win32'
              ? 'browser-recall-desktop.exe'
              : 'browser-recall-desktop',
          );
      if (plan.verifyMacosApp) verifyMacosApp(file);
      verifySignature?.(file);
      if (platform === 'win32' && bundles.includes('nsis')) {
        for (const name of readdirSync(path.join(staged, 'nsis'))) {
          if (name.endsWith('.exe'))
            verifySignature?.(path.join(staged, 'nsis', name));
        }
      }
      packageArtifacts?.(staged);
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(finalizeDesktopBuild());
}
