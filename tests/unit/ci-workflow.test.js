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
const documentationWindow = fs.readFileSync(
  path.join(repoRoot, 'scripts/lib/documentation-window.swift'),
  'utf8',
);
const desktopCapture = fs.readFileSync(
  path.join(repoRoot, 'scripts/capture-documentation.mjs'),
  'utf8',
);
const browserCapture = fs.readFileSync(
  path.join(repoRoot, 'tests/e2e/documentation-browser.spec.js'),
  'utf8',
);
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

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
    ['test', 'documentation-screenshots', 'ci:check-docs ci:test'],
    [
      'documentation-screenshots',
      'test-extension-e2e',
      'ci:install-playwright ci:generate-docs',
    ],
    [
      'test-extension-e2e',
      'test-rust',
      'ci:install-playwright ci:test-extension-e2e',
    ],
    ['test-rust', 'test-desktop-visual', 'ci:test-rust'],
    [
      'test-desktop-visual',
      'cold-scripts',
      'ci:install-desktop-visual-browsers ci:test-desktop-visual',
    ],
    ['cold-scripts', 'test-desktop-native-bundle', 'ci:cold-scripts'],
    ['lint-js', 'lint-rust', 'ci:lint-js'],
    ['lint-rust', null, 'ci:lint-rust'],
  ])('%s delegates to local CI scripts', (job, nextJob, scripts) => {
    const body = jobBody(job, nextJob);
    for (const script of scripts.split(' ')) {
      expect(body).toContain(`npm run ${script}`);
    }
    if (job.endsWith('rust')) {
      expect(body).toMatch(new RegExp(`npm ci[\\s\\S]*npm run ${scripts}`));
    }
  });

  test('local CI composes every locally safe GitHub CI job', () => {
    expect(packageJson.scripts.ci).toBe(
      'npm run ci:check-docs && npm run ci:test && npm run ci:install-playwright && npm run ci:test-extension-e2e && npm run ci:test-rust && npm run ci:install-desktop-visual-browsers && npm run ci:test-desktop-visual && npm run ci:cold-scripts && npm run ci:lint-js && npm run ci:lint-rust',
    );
    expect(packageJson.scripts['ci:install-playwright']).toBe(
      'playwright install --with-deps --no-shell chromium',
    );
    expect(packageJson.scripts['ci:install-desktop-visual-browsers']).toBe(
      'playwright install --with-deps --no-shell chromium webkit',
    );
    expect(packageJson.scripts['ci:test-extension-e2e']).toBe(
      'npm run build:test-daemon && playwright test tests/e2e/extension-font-fallback.spec.js tests/e2e/popup-lists.spec.js tests/e2e/snapshot-slug-meta.spec.js tests/e2e/snapshot-resource-timeout.spec.js tests/e2e/extension-navigation-regressions.spec.js tests/e2e/url-tracking.spec.js && playwright test tests/e2e/highlight-note-edit.spec.js tests/e2e/note-dismiss-save.spec.js && npm run test:firefox:smoke',
    );
    expect(packageJson.scripts['test:visual']).toBe(
      'npm run build:desktop-ui && npm run test:visual:wkwebview && npm run test:visual:chromium && npm run test:visual:webkit',
    );
    expect(packageJson.scripts['test:visual:wkwebview']).toBe(
      'node tests/smoke/macos-wkwebview-chart-layout.mjs',
    );
    expect(packageJson.scripts['test:visual:chromium']).toBe(
      'playwright test tests/e2e/desktop-visual.spec.js',
    );
    expect(packageJson.scripts['test:visual:webkit']).toBe(
      'playwright test --config playwright.webkit.config.js tests/e2e/desktop-visual.spec.js --browser=webkit --grep @webkit',
    );
    const visualJob = jobBody('test-desktop-visual', 'cold-scripts');
    expect(visualJob).toContain('runs-on: macos-26');
    expect(visualJob).toContain('if: failure()');
    for (const kind of ['expected', 'actual', 'diff']) {
      expect(visualJob).toContain(`test-results/**/*-${kind}.png`);
    }
    const nativeJob = jobBody('test-desktop-native-bundle', 'lint-js');
    expect(nativeJob).toContain(
      'npm run build --workspace @browser-recall/desktop',
    );
    expect(nativeJob).toContain(
      'node tests/smoke/macos-desktop-window-lifecycle.mjs',
    );
    expect(packageJson.scripts.ci).not.toContain('test:desktop-native');
  });

  test('documentation generation is a read-only CI formatting check', () => {
    const documentationJob = jobBody(
      'documentation-screenshots',
      'test-extension-e2e',
    );
    expect(documentationJob).toContain(
      'git diff --exit-code -- README.md docs/images/',
    );
    expect(documentationJob).not.toContain('contents: write');
    expect(documentationJob).not.toContain('git commit');
    expect(documentationJob).not.toContain('git push');
  });

  test('documentation capture uses canonical pixels and deterministic manifests', () => {
    expect(documentationWindow).toContain('import ScreenCaptureKit');
    expect(documentationWindow).toContain('NSApplication.shared');
    expect(documentationWindow).toContain('setActivationPolicy(.prohibited)');
    expect(documentationWindow).toContain('AXUIElementPerformAction');
    expect(documentationWindow).toContain('SCScreenshotManager.captureImage');
    expect(documentationWindow).toContain('configuration.width = pixelWidth');
    expect(documentationWindow).toContain('configuration.height = pixelHeight');
    expect(documentationWindow).not.toContain('.nominalResolution');
    expect(documentationWindow).not.toContain('interpolationQuality');
    expect(documentationWindow).not.toContain('context.draw(image');
    for (const source of [desktopCapture, browserCapture]) {
      expect(source).not.toContain('capturedAt:');
      expect(source).not.toContain('sourceCommit:');
    }
  });

  test('README uses standard Markdown image references', () => {
    expect(readme).not.toContain('<img');
    for (const image of [
      'timeline-styles.png',
      'browser-popup-window.png',
      'browser-note-window.png',
      'book.png',
    ]) {
      expect(readme).toContain(`](docs/images/${image})`);
    }
  });

  test('cold Rust commands prepare generated build inputs', () => {
    expect(packageJson.scripts['build:test-daemon']).toBe(
      'cargo build --locked -p browser-recall-daemon',
    );
    expect(packageJson.scripts['test:cold-scripts']).toBe(
      'npm run build:test-daemon && playwright test tests/e2e/manual-seed-workflow.spec.js',
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
      8,
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

  test('Windows CI exercises locked artifact replacement before native smoke', () => {
    expect(
      fs.readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8'),
    ).toContain('* text=auto eol=lf');
    const windowsJob = jobBody('test-desktop-single-instance', 'lint-js');
    expect(windowsJob).toMatch(
      /npm ci[\s\S]+ci:test-windows-cleanup[\s\S]+npm run build --workspace[\s\S]+ci:test-windows-artifacts[\s\S]+ci:install-playwright/,
    );
    expect(windowsJob).toContain('npm run ci:install-playwright');
    expect(windowsJob).toContain('npm run ci:test-windows-extension-font');
    expect(packageJson.scripts).toMatchObject({
      'ci:test-windows-extension-font':
        'npm run build:test-daemon && playwright test tests/e2e/extension-font-fallback.spec.js',
      'ci:test-windows-artifacts':
        'vitest run tests/unit/stage-app-assets.test.js',
      'ci:test-windows-cleanup':
        'vitest run tests/integration/windows-desktop-cleanup.test.js',
    });
  });
});
