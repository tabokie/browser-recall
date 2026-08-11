#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { collectDesktopArtifacts } from './collect-desktop-artifacts.mjs';
import { desktopBuildPlan } from './desktop-build-plan.mjs';
import { finalizeMacosAppBundle } from './finalize-macos-app-bundle.mjs';
import { verifyMacosAppBundle } from './verify-macos-app-bundle.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const targetMacosApp = path.join(
  repoRoot,
  'target/release/bundle/macos/Browser Recall.app',
);
const collectedMacosApp = path.join(
  repoRoot,
  'dist/desktop/macos/app/Browser Recall.app',
);

export function finalizeDesktopBuild({
  platform = process.platform,
  finalizeMacosApp = finalizeMacosAppBundle,
  collect = collectDesktopArtifacts,
  verifyMacosApp = verifyMacosAppBundle,
} = {}) {
  const plan = desktopBuildPlan(platform);
  if (plan.finalizeMacosApp) finalizeMacosApp(targetMacosApp);
  const outDir = collect({
    bundles: [...plan.bundles],
    platformName: plan.artifactPlatform,
  });
  if (plan.verifyMacosApp) verifyMacosApp(collectedMacosApp);
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(finalizeDesktopBuild());
}
