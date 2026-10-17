import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

const desktop = path.resolve(
  import.meta.dirname,
  '../../apps/desktop/src-tauri',
);

test('desktop build emits the Common Controls manifest for Windows MSVC test executables only', () => {
  const work = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-test-manifest-'),
  );
  const executable = path.join(
    work,
    process.platform === 'win32' ? 'build-script.exe' : 'build-script',
  );
  const library = path.join(work, 'libtauri_build.rlib');
  try {
    copyFileSync(path.join(desktop, 'build.rs'), path.join(work, 'build.rs'));
    // Execute the real build script for multiple Cargo target environments.
    // Native resource compilation and frontend staging are covered separately;
    // these stand-ins let this check run on Linux and macOS as well as Windows.
    writeFileSync(
      path.join(work, 'build_support.rs'),
      'pub fn require_frontend_dist(_: &std::path::Path) -> Result<(), String> { Ok(()) }',
    );
    writeFileSync(
      path.join(work, 'tauri_build.rs'),
      '#[derive(Default)] pub struct Attributes { _private: () } pub fn try_build(_: Attributes) -> Result<(), String> { Ok(()) }',
    );
    execFileSync(
      'rustc',
      [
        '--crate-name',
        'tauri_build',
        '--crate-type',
        'rlib',
        path.join(work, 'tauri_build.rs'),
        '-o',
        library,
      ],
      { stdio: 'pipe' },
    );
    execFileSync(
      'rustc',
      [
        '--edition=2021',
        path.join(work, 'build.rs'),
        '--extern',
        `tauri_build=${library}`,
        '-o',
        executable,
      ],
      { stdio: 'pipe' },
    );
    const manifest = path.join(work, 'tests/windows-app.manifest');
    const run = (os, environment) =>
      execFileSync(executable, [], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CARGO_MANIFEST_DIR: work,
          CARGO_CFG_TARGET_OS: os,
          CARGO_CFG_TARGET_ENV: environment,
        },
      });
    const output = run('windows', 'msvc');
    expect(output).toContain('cargo:rustc-link-arg-tests=/MANIFEST:EMBED');
    expect(output).toContain(
      `cargo:rustc-link-arg-tests=/MANIFESTINPUT:${manifest}`,
    );
    expect(output).toContain(`cargo:rerun-if-changed=${manifest}`);
    expect(output).not.toMatch(/^cargo:rustc-link-arg=/m);
    for (const [os, environment] of [
      ['windows', 'gnu'],
      ['macos', ''],
      ['linux', 'gnu'],
    ]) {
      expect(run(os, environment)).not.toContain('cargo:rustc-link-arg-tests=');
    }
    const xml = readFileSync(
      path.join(desktop, 'tests/windows-app.manifest'),
      'utf8',
    );
    expect(xml).toMatch(/name="Microsoft.Windows.Common-Controls"/);
    expect(xml).toMatch(/version="6\.0\.0\.0"/);
    expect(xml).toMatch(/publicKeyToken="6595b64144ccf1df"/);
    // The Windows job must execute the integration test, rather than only build
    // the packaged app, whose separate manifest masked the missing test manifest.
    const workflow = readFileSync(
      path.resolve(desktop, '../../../.github/workflows/ci.yml'),
      'utf8',
    );
    const windowsJob = workflow
      .split('  test-desktop-single-instance:')[1]
      .split('  lint-js:')[0];
    expect(windowsJob).toContain(
      'cargo test --locked -p browser-recall-desktop --test desktop_updates',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
