#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const sharedInputs = new Set([
  'package.json',
  'package-lock.json',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.github/workflows/desktop-release-validation.yml',
  'scripts/select-platform-checks.mjs',
  'tests/integration/platform-check-selection.test.js',
]);
const windowsInputs = new Set([
  'playwright.config.js',
  'scripts/stage-app-assets.mjs',
  'tests/e2e/extension-font-fallback.spec.js',
  'tests/e2e/helpers.js',
  'tests/fixtures/extension-rendering.mjs',
  'tests/fixtures/extension-browser-channel.mjs',
  'tests/fixtures/test-extension.mjs',
  'tests/integration/extension-browser-selection.test.js',
  'tests/smoke/desktop-test-cleanup.mjs',
  'scripts/lib/desktop-test-runtime.mjs',
]);
const macosInputs = new Set([
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'scripts/build-desktop.mjs',
  'scripts/build-release-desktop.mjs',
  'scripts/build-tauri-app.mjs',
  'scripts/desktop-build-plan.mjs',
  'scripts/collect-desktop-artifacts.mjs',
  'scripts/finalize-desktop-build.mjs',
  'scripts/finalize-macos-app-bundle.mjs',
  'scripts/verify-macos-app-bundle.mjs',
  'scripts/verify-macos-documentation-app.mjs',
  'scripts/capture-documentation.mjs',
  'scripts/lib/desktop-signing.mjs',
  'scripts/lib/build-timing.mjs',
  'scripts/lib/product-version.mjs',
  'tests/integration/macos-documentation-url-routing.test.js',
  'tests/smoke/macos-desktop-process.mjs',
  'tests/smoke/desktop-test-cleanup.mjs',
]);

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function commit(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`Missing or invalid ${field} commit in GitHub event`);
  }
  return value;
}

function selectChecks() {
  const production = process.env.BROWSER_RECALL_CI_PRODUCTION;
  if (!['true', 'false'].includes(production))
    throw new Error('BROWSER_RECALL_CI_PRODUCTION must be true or false');
  const all = (reason) => ({
    windows_extension: true,
    macos_documentation: true,
    reason,
  });
  if (
    production === 'true' ||
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  )
    return all('Release or manual validation runs both platform checks');

  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let range;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    const base = commit(event.pull_request?.base?.sha, 'pull_request.base.sha');
    const head = commit(event.pull_request?.head?.sha, 'pull_request.head.sha');
    range = `${base}...${head}`;
  } else if (process.env.GITHUB_EVENT_NAME === 'push') {
    const base = commit(event.before, 'push.before');
    const head = commit(event.after, 'push.after');
    git('rev-parse', '--verify', `${head}^{commit}`);
    if (/^0+$/.test(base)) return all('Initial push runs both platform checks');
    try {
      git('cat-file', '-e', `${base}^{commit}`);
    } catch (error) {
      if (error.status !== 128) throw error;
      // A force-pushed predecessor may no longer be fetchable. Run more coverage
      // explicitly rather than interpreting an unavailable comparison as no changes.
      return all(
        'Push predecessor is unavailable; running both platform checks',
      );
    }
    range = `${base}..${head}`;
  } else {
    throw new Error(
      `Unsupported GitHub event: ${process.env.GITHUB_EVENT_NAME}`,
    );
  }

  // Disabling rename detection retains both the deleted and added paths. NUL
  // separation also handles file names containing whitespace or newlines.
  const files = git('diff', '--name-only', '--no-renames', '-z', range, '--')
    .split('\0')
    .filter(Boolean);
  return {
    windows_extension: files.some(
      (file) =>
        sharedInputs.has(file) ||
        windowsInputs.has(file) ||
        file.startsWith('apps/extension/') ||
        file.startsWith('packages/core/'),
    ),
    macos_documentation: files.some(
      (file) =>
        sharedInputs.has(file) ||
        macosInputs.has(file) ||
        file.startsWith('apps/desktop/src-tauri/') ||
        file.startsWith('.cargo/') ||
        file.startsWith('scripts/documentation-') ||
        file.startsWith('scripts/lib/documentation-') ||
        file.startsWith('scripts/lib/macos-') ||
        file.startsWith('tests/smoke/macos-documentation-'),
    ),
    reason: `Changed inputs in ${range}`,
  };
}

try {
  const checks = selectChecks();
  console.log(JSON.stringify(checks));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `windows_extension=${checks.windows_extension}\nmacos_documentation=${checks.macos_documentation}\n`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
