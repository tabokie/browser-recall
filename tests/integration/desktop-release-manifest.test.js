import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

test('release manifest CLI requires the complete signed package set and produces platform download URLs', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const config = JSON.parse(
    readFileSync(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json')),
  );
  const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-release-'));
  const directory = path.join(work, 'release-assets');
  mkdirSync(directory);
  const suffixes = [
    'windows-x64-setup.exe',
    'macos-arm64.app.tar.gz',
    'macos-x64.app.tar.gz',
  ];
  const run = () =>
    execFileSync(
      process.execPath,
      [path.join(root, 'scripts/create-update-manifest.mjs')],
      {
        cwd: work,
        env: { ...process.env, GH_REPO: 'tabokie/browser-recall' },
        stdio: 'pipe',
      },
    );
  try {
    for (const suffix of suffixes) {
      const file = path.join(
        directory,
        `browser-recall-v${config.version}-${suffix}`,
      );
      writeFileSync(file, 'package fixture');
      writeFileSync(
        `${file}.sig`,
        Buffer.from(`signature fixture for ${suffix}`).toString('base64'),
      );
    }
    const missing = path.join(
      directory,
      `browser-recall-v${config.version}-${suffixes[2]}.sig`,
    );
    const signature = readFileSync(missing);
    rmSync(missing);
    expect(run).toThrow();
    expect(() => readFileSync(path.join(directory, 'latest.json'))).toThrow();
    writeFileSync(missing, signature);
    run();
    const manifest = JSON.parse(
      readFileSync(path.join(directory, 'latest.json')),
    );
    expect(manifest.version).toBe(config.version);
    expect(Object.keys(manifest.platforms)).toEqual([
      'windows-x86_64',
      'darwin-aarch64',
      'darwin-x86_64',
    ]);
    for (const [index, platform] of Object.values(
      manifest.platforms,
    ).entries()) {
      expect(platform.url).toBe(
        `https://github.com/tabokie/browser-recall/releases/download/v${config.version}/browser-recall-v${config.version}-${suffixes[index]}`,
      );
      expect(platform.signature).toBe(
        readFileSync(
          path.join(
            directory,
            `browser-recall-v${config.version}-${suffixes[index]}.sig`,
          ),
          'utf8',
        ),
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
