#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { desktopBuildPlan } from './desktop-build-plan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const defaultCargoReleaseDir = path.join(repoRoot, 'target/release');
const defaultOutDir = path.join(repoRoot, 'dist/desktop');

function defaultPlatformName() {
  return desktopBuildPlan().artifactPlatform;
}

export function canonicalDesktopBundles(platformName = defaultPlatformName()) {
  return [...desktopBuildPlan(platformName).bundles];
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

function warnRetainedWindowsExecutable(
  warn,
  retiredExecutable,
  error,
  installedExecutable = null,
) {
  const lockExplanation = ['EPERM', 'EBUSY'].includes(error?.code)
    ? 'Windows still has the previous executable open.'
    : `Cleanup failed: ${error?.message || String(error)}`;
  const outcome = installedExecutable
    ? `Build succeeded and installed the new desktop executable at ${installedExecutable}.`
    : 'A retired executable from an earlier build could not be removed; this does not block installation of the new build.';
  warn(
    [
      outcome,
      lockExplanation,
      'Quit Browser Recall from its tray menu; closing the window only hides it. The next build will retry the cleanup.',
      `Retained old executable: ${retiredExecutable}`,
    ].join('\n'),
  );
}

function cleanRetiredWindowsExecutables(platformOutDir, warn) {
  const binDir = path.join(platformOutDir, 'bin');
  if (!fs.existsSync(binDir)) return;
  const prefix = 'browser-recall-desktop.exe.retired-';
  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const retiredExecutable = path.join(binDir, entry.name);
    try {
      fs.rmSync(retiredExecutable, { force: true });
    } catch (error) {
      warnRetainedWindowsExecutable(warn, retiredExecutable, error);
    }
  }
}

function clearWindowsOutputRemainder(platformOutDir) {
  const executableName = 'browser-recall-desktop.exe';
  const retiredPrefix = `${executableName}.retired-`;
  for (const entry of fs.readdirSync(platformOutDir, { withFileTypes: true })) {
    const entryPath = path.join(platformOutDir, entry.name);
    if (entry.name !== 'bin' || !entry.isDirectory()) {
      fs.rmSync(entryPath, { recursive: true, force: true });
      continue;
    }
    for (const binEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
      if (
        binEntry.name === executableName ||
        binEntry.name.startsWith(retiredPrefix)
      ) {
        continue;
      }
      fs.rmSync(path.join(entryPath, binEntry.name), {
        recursive: true,
        force: true,
      });
    }
  }
}

function moveWindowsOutputRemainder(platformOutDir, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const executableName = 'browser-recall-desktop.exe';
  const retiredPrefix = `${executableName}.retired-`;
  for (const entry of fs.readdirSync(platformOutDir, { withFileTypes: true })) {
    const entryPath = path.join(platformOutDir, entry.name);
    if (entry.name !== 'bin' || !entry.isDirectory()) {
      fs.renameSync(entryPath, path.join(backupDir, entry.name));
      continue;
    }
    for (const binEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
      if (
        binEntry.name === executableName ||
        binEntry.name.startsWith(retiredPrefix)
      ) {
        continue;
      }
      const backupBinDir = path.join(backupDir, 'bin');
      fs.mkdirSync(backupBinDir, { recursive: true });
      fs.renameSync(
        path.join(entryPath, binEntry.name),
        path.join(backupBinDir, binEntry.name),
      );
    }
  }
}

function promoteDirectoryContents(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isDirectory() && fs.existsSync(destination)) {
      promoteDirectoryContents(source, destination);
      fs.rmSync(source, { recursive: true, force: true });
      continue;
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(source, destination);
  }
}

function rollbackWindowsOutput({
  platformOutDir,
  backupDir,
  executable,
  retiredExecutable,
  hadExecutable,
  installedExecutable,
  remainderBackedUp,
}) {
  const errors = [];
  if (installedExecutable) {
    try {
      fs.rmSync(executable, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (hadExecutable && fs.existsSync(retiredExecutable)) {
    try {
      fs.renameSync(retiredExecutable, executable);
    } catch (error) {
      errors.push(error);
    }
  }
  if (remainderBackedUp) {
    try {
      clearWindowsOutputRemainder(platformOutDir);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    promoteDirectoryContents(backupDir, platformOutDir);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

export function replaceWindowsOutput(
  platformOutDir,
  stagedDir,
  warn = console.warn,
  { promote = promoteDirectoryContents } = {},
) {
  cleanRetiredWindowsExecutables(platformOutDir, warn);
  const executable = path.join(
    platformOutDir,
    'bin',
    'browser-recall-desktop.exe',
  );
  const stagedExecutable = path.join(
    stagedDir,
    'bin',
    'browser-recall-desktop.exe',
  );
  const retiredExecutable = `${executable}.retired-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  const backupDir = fs.mkdtempSync(`${platformOutDir}.backup-`);

  const hadExecutable = fs.existsSync(executable);
  let installedExecutable = false;
  let remainderBackedUp = false;
  try {
    moveWindowsOutputRemainder(platformOutDir, backupDir);
    remainderBackedUp = true;
    if (hadExecutable) fs.renameSync(executable, retiredExecutable);
    fs.renameSync(stagedExecutable, executable);
    installedExecutable = true;
    promote(stagedDir, platformOutDir);
  } catch (error) {
    const rollbackErrors = rollbackWindowsOutput({
      platformOutDir,
      backupDir,
      executable,
      retiredExecutable,
      hadExecutable,
      installedExecutable,
      remainderBackedUp,
    });
    if (rollbackErrors.length === 0) {
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Could not install or restore the complete Windows output at ${platformOutDir}`,
      );
    }
    throw error;
  }

  if (hadExecutable) {
    try {
      fs.rmSync(retiredExecutable, { force: true });
    } catch (error) {
      warnRetainedWindowsExecutable(warn, retiredExecutable, error, executable);
    }
  }
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    warn(
      [
        `Build succeeded and installed the complete Windows output at ${platformOutDir}.`,
        `A rollback backup could not be removed: ${error.message}`,
        `Retained backup: ${backupDir}`,
      ].join('\n'),
    );
  }
  fs.rmSync(stagedDir, { recursive: true, force: true });
}

function replacePlatformOutput(platformOutDir, stagedDir, platformName, warn) {
  if (platformName === 'windows' && fs.existsSync(platformOutDir)) {
    replaceWindowsOutput(platformOutDir, stagedDir, warn);
    return;
  }

  fs.rmSync(platformOutDir, { recursive: true, force: true });
  fs.renameSync(stagedDir, platformOutDir);
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
  warn = console.warn,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const platformOutDir = path.join(outDir, platformName);
  const stagedDir = fs.mkdtempSync(`${platformOutDir}.staging-`);
  try {
    copyReleaseExecutable(cargoReleaseDir, stagedDir, platformName);
    copyBundles(cargoReleaseDir, stagedDir, platformName, bundles);
    replacePlatformOutput(platformOutDir, stagedDir, platformName, warn);
  } catch (error) {
    fs.rmSync(stagedDir, { recursive: true, force: true });
    throw error;
  }
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const canonical = args.length === 1 && args[0] === '--canonical';
  const bundles = canonical ? canonicalDesktopBundles() : parseBundles(args);
  if (!canonical && bundles.length === 0) {
    throw new Error(
      'Usage: node scripts/collect-desktop-artifacts.mjs --canonical | --bundles <app|dmg>',
    );
  }
  console.log(collectDesktopArtifacts({ bundles }));
}
