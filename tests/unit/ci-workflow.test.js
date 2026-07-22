import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';
import { validateMacosSignatureMetadata } from '../../scripts/verify-macos-app-bundle.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const ciWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/ci.yml'),
  'utf8',
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const rustToolchainPath = path.join(repoRoot, 'rust-toolchain.toml');
const macosLifecycleSmoke = fs.readFileSync(
  path.join(repoRoot, 'tests/smoke/macos-desktop-window-lifecycle.mjs'),
  'utf8',
);

function jobBody(jobName, nextJobName) {
  const start = ciWorkflow.indexOf(`  ${jobName}:`);
  const end = nextJobName
    ? ciWorkflow.indexOf(`  ${nextJobName}:`, start + 1)
    : ciWorkflow.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return ciWorkflow.slice(start, end);
}

describe('GitHub CI prerequisites', () => {
  test.each([
    ['test', 'test-rust', 'ci:test'],
    ['test-rust', 'test-desktop-visual', 'ci:test-rust'],
    [
      'test-desktop-visual',
      'cold-scripts',
      'ci:install-playwright ci:test-desktop-visual',
    ],
    ['cold-scripts', 'test-desktop-native-bundle', 'ci:cold-scripts'],
    ['lint-js', 'lint-rust', 'ci:lint-js'],
    ['lint-rust', null, 'ci:lint-rust'],
  ])('%s delegates to local CI scripts', (job, nextJob, scripts) => {
    const body = jobBody(job, nextJob);
    for (const script of scripts.split(' ')) {
      expect(body).toContain(`npm run ${script}`);
    }
  });

  test('local CI composes every locally safe GitHub CI job', () => {
    expect(packageJson.scripts.ci).toBe(
      'npm run ci:test && npm run ci:test-rust && npm run ci:install-playwright && npm run ci:test-desktop-visual && npm run ci:cold-scripts && npm run ci:lint-js && npm run ci:lint-rust',
    );
    expect(packageJson.scripts['ci:install-playwright']).toBe(
      'playwright install --no-shell chromium',
    );
    const nativeJob = jobBody('test-desktop-native-bundle', 'lint-js');
    expect(nativeJob).toContain(
      'npm run build --workspace @browser-recall/desktop',
    );
    expect(nativeJob).toContain(
      'node tests/smoke/macos-desktop-window-lifecycle.mjs',
    );
    expect(packageJson.scripts.ci).not.toContain('test:desktop-native');
  });

  test('cold Rust commands prepare generated build inputs', () => {
    expect(packageJson.scripts['test:cold-scripts']).toBe(
      'cargo build --quiet -p browser-recall-daemon && playwright test tests/e2e/manual-seed-workflow.spec.js',
    );
    expect(packageJson.scripts['coverage:rust']).toBe(
      'npm run build:desktop-ui && node scripts/rust-coverage.mjs',
    );
  });

  test('local and GitHub CI use the same pinned Rust toolchain', () => {
    const rustToolchain = fs.readFileSync(rustToolchainPath, 'utf8');
    expect(rustToolchain).toContain('channel = "1.97.0"');
    expect(rustToolchain).toContain('"llvm-tools-preview"');
    expect(ciWorkflow.match(/dtolnay\/rust-toolchain@1\.97\.0/g)).toHaveLength(
      5,
    );
    expect(ciWorkflow).not.toContain('dtolnay/rust-toolchain@stable');
  });

  test('macOS build checks require hardened runtime and host-native helpers', () => {
    const identifier = 'app.browser-recall.desktop';
    const requirements = `designated => identifier "${identifier}"`;
    expect(() =>
      validateMacosSignatureMetadata(
        `Identifier=${identifier}\nCodeDirectory v=20500 flags=0x0(none)`,
        identifier,
        requirements,
      ),
    ).toThrow(/hardened runtime/);
    expect(() =>
      validateMacosSignatureMetadata(
        `Identifier=${identifier}\nCodeDirectory v=20500 flags=0x10000(runtime)`,
        identifier,
        requirements,
      ),
    ).not.toThrow();
    expect(macosLifecycleSmoke).not.toContain('arm64-apple-macos14.0');
    expect(macosLifecycleSmoke).toContain('process.arch');
    expect(macosLifecycleSmoke).not.toContain('CGEvent(');
    expect(macosLifecycleSmoke).not.toContain('perform action "AXPress"');
    expect(macosLifecycleSmoke).toContain(
      'tell trayItem\n          perform action "AXShowMenu"\n          delay 0.1\n          click menu item "Open" of menu 1\n        end tell',
    );
    expect(macosLifecycleSmoke).toContain('waitForProcessExit(pid)');
    expect(macosLifecycleSmoke).not.toContain(
      'visible Resume Service did not start the absent daemon',
    );
  });
});
