#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { desktopBuildPlan } from './desktop-build-plan.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const require = createRequire(import.meta.url);
const localAdHocSigning =
  !process.env.APPLE_SIGNING_IDENTITY ||
  process.env.APPLE_SIGNING_IDENTITY === '-';
const missingNotarizationWarning =
  /skipping app notarization, no APPLE_ID & APPLE_PASSWORD & APPLE_TEAM_ID or APPLE_API_KEY & APPLE_API_ISSUER & APPLE_API_KEY_PATH environment variables found/;
let explainedLocalNotarization = false;

function forwardBuildOutput(stream, target) {
  stream.setEncoding('utf8');
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/(?<=\n)/);
    pending = lines.pop() || '';
    for (const line of lines) forwardLine(line, target);
  });
  stream.on('end', () => {
    if (pending) forwardLine(pending, target);
  });
}

function forwardLine(line, target) {
  if (localAdHocSigning && missingNotarizationWarning.test(line)) {
    if (!explainedLocalNotarization) {
      explainedLocalNotarization = true;
      process.stdout.write(
        'Local app build uses ad-hoc signing; notarization is reserved for distribution builds.\n',
      );
    }
    return;
  }
  target.write(line);
}

export function tauriBuildInvocation({ platform = process.platform } = {}) {
  const buildArgs = desktopBuildPlan(platform).tauriArgs;
  return {
    command: process.execPath,
    args: [require.resolve('@tauri-apps/cli/tauri.js'), ...buildArgs],
  };
}

export function runTauriBuild() {
  const { command, args } = tauriBuildInvocation();
  const child = spawn(command, args, {
    cwd: path.join(repoRoot, 'apps', 'desktop'),
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  forwardBuildOutput(child.stdout, process.stdout);
  forwardBuildOutput(child.stderr, process.stderr);

  child.on('error', (error) => {
    process.stderr.write(`Could not start Tauri build: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.stderr.write(`Tauri build stopped by ${signal}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTauriBuild();
}
