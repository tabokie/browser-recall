import { execFileSync } from 'node:child_process';
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import {
  stageExtensionAssets,
  stageFirefoxExtensionAssets,
} from '../../scripts/stage-app-assets.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(
  path.join(root, '.github/workflows/release.yml'),
  'utf8',
);

function shellStep(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`Missing release step: ${name}`);
  const lines = workflow.slice(start).split('\n');
  const run = lines.indexOf('        run: |');
  if (run < 0) throw new Error(`Missing shell script: ${name}`);
  const commands = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    commands.push(line.slice(10));
  }
  return commands.join('\n');
}

test('release preparation checks the desktop and extension versions before publishing', async () => {
  const script = workflow
    .split('          script: |\n')[1]
    .split('\n  build-extensions:')[0]
    .split('\n')
    .map((line) => line.slice(12))
    .join('\n');
  const directory = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-release-version-'),
  );
  const files = [
    'package.json',
    'package-lock.json',
    'Cargo.lock',
    'apps/desktop/package.json',
    'apps/desktop/src-tauri/Cargo.toml',
    'apps/desktop/src-tauri/tauri.conf.json',
    'apps/extension/package.json',
    'apps/extension/manifest.json',
    'scripts/lib/product-version.mjs',
  ];
  const prepare = (mismatch) => {
    for (const file of files) {
      const target = path.join(directory, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, file), target);
    }
    if (mismatch) {
      const target = path.join(directory, mismatch);
      const source = readFileSync(target, 'utf8');
      writeFileSync(
        target,
        mismatch === 'Cargo.lock'
          ? source.replace(
              /(name = "browser-recall-desktop"\s+version = ")[^"]+/,
              '$19.9.9',
            )
          : mismatch.endsWith('.toml')
            ? source.replace(/^version = "[^"]+"/m, 'version = "9.9.9"')
            : JSON.stringify({ ...JSON.parse(source), version: '9.9.9' }),
      );
    }
    const outputs = {};
    return runInNewContext(`(async () => { ${script} })()`, {
      process,
      require(name) {
        if (name !== 'node:child_process')
          throw new Error(`Unexpected dependency: ${name}`);
        return {
          spawnSync: () => ({ status: 1 }),
          execFileSync(command, args, options) {
            return execFileSync(command, args, {
              ...options,
              cwd: directory,
              stdio: 'pipe',
            });
          },
        };
      },
      context: { repo: { owner: 'example', repo: 'browser-recall' } },
      github: {
        rest: {
          repos: {
            getReleaseByTag() {
              throw { status: 404 };
            },
          },
        },
      },
      core: {
        setOutput(name, value) {
          outputs[name] = value;
        },
      },
    }).then(() => outputs);
  };
  try {
    const version = JSON.parse(
      readFileSync(path.join(root, 'package.json')),
    ).version;
    await expect(prepare()).resolves.toEqual({ tag: `v${version}` });
    for (const file of [
      'apps/desktop/package.json',
      'apps/desktop/src-tauri/Cargo.toml',
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/extension/package.json',
      'apps/extension/manifest.json',
    ]) {
      await expect(prepare(file)).rejects.toThrow(`${file} version 9.9.9`);
    }
    for (const file of ['package-lock.json', 'Cargo.lock']) {
      await expect(prepare(file)).rejects.toThrow(
        `${file} must match Browser Recall version`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'release workflow archives real production extensions and refuses an incomplete release',
  () => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-extension-release-'),
    );
    const version = JSON.parse(
      readFileSync(path.join(root, 'package.json')),
    ).version;
    const tag = `v${version}`;
    const run = (name) =>
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', shellStep(name)], {
        cwd:
          name === 'Verify the complete archive set and generate checksums'
            ? path.join(work, 'release-assets')
            : work,
        env: {
          ...process.env,
          GITHUB_WORKSPACE: work,
          RUNNER_TEMP: path.join(work, 'runner'),
          RELEASE_TAG: tag,
        },
        stdio: 'pipe',
      });
    try {
      expect(workflow).toMatch(/needs: \[prepare, build, build-extensions\]/);
      expect(workflow).toContain('run: npm run build:extension');
      expect(workflow).toContain('pattern: release-*');
      expect(workflow).toMatch(
        /gh release create[^\n]*release-assets\/\*\.zip/,
      );
      stageExtensionAssets(path.join(work, 'dist/extension/chrome'));
      stageFirefoxExtensionAssets(path.join(work, 'dist/extension/firefox'));
      mkdirSync(path.join(work, 'runner'));
      run('Archive and verify browser extensions');
      const directory = path.join(work, 'release-assets');
      expect(readdirSync(directory).sort()).toEqual([
        `browser-recall-${tag}-extension-chrome.zip`,
        `browser-recall-${tag}-extension-firefox.zip`,
      ]);
      for (const browser of ['chrome', 'firefox']) {
        const extracted = path.join(work, 'runner', `extension-${browser}`);
        expect(
          existsSync(path.join(extracted, 'background-test-control.js')),
        ).toBe(false);
        const manifest = JSON.parse(
          readFileSync(path.join(extracted, 'manifest.json')),
        );
        expect(manifest.version).toBe(version);
        if (browser === 'chrome')
          expect(manifest.background.service_worker).toBe('background.js');
        else expect(manifest.background.scripts).toContain('background.js');
      }
      for (const suffix of [
        'windows-x64-setup.exe',
        'macos-arm64.dmg',
        'macos-x64.dmg',
        'macos-arm64.app.tar.gz',
        'macos-x64.app.tar.gz',
      ]) {
        writeFileSync(
          path.join(directory, `browser-recall-${tag}-${suffix}`),
          'desktop package fixture',
        );
      }
      const missing = path.join(
        directory,
        `browser-recall-${tag}-extension-firefox.zip`,
      );
      const firefox = readFileSync(missing);
      rmSync(missing);
      expect(() =>
        run('Verify the complete archive set and generate checksums'),
      ).toThrow();
      expect(existsSync(path.join(directory, 'SHA256SUMS'))).toBe(false);
      writeFileSync(missing, firefox);
      run('Verify the complete archive set and generate checksums');
      const checksums = readFileSync(
        path.join(directory, 'SHA256SUMS'),
        'utf8',
      );
      expect(checksums.trim().split('\n')).toHaveLength(7);
      expect(checksums).toContain(path.basename(missing));
      expect(checksums).toContain(`browser-recall-${tag}-extension-chrome.zip`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
