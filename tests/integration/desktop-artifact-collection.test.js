import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { collectDesktopArtifacts } from '../../scripts/collect-desktop-artifacts.mjs';
import { finalizeDesktopBuild } from '../../scripts/finalize-desktop-build.mjs';

test('disk-image creation follows signature verification and cannot discard previous output on failure', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-dmg-rollback-'));
  try {
    const cargoReleaseDir = path.join(work, 'release');
    const app = path.join(cargoReleaseDir, 'bundle/macos/Browser Recall.app');
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, 'Contents'), 'fixture app');
    writeFileSync(
      path.join(cargoReleaseDir, 'browser-recall-desktop'),
      'new executable',
    );
    const outDir = path.join(work, 'dist');
    mkdirSync(path.join(outDir, 'macos'), { recursive: true });
    const previous = path.join(outDir, 'macos/previous.dmg');
    writeFileSync(previous, 'previous disk image');
    const calls = [];
    expect(() =>
      finalizeDesktopBuild({
        platform: 'darwin',
        cargoReleaseDir,
        outDir,
        finalizeMacosApp: () => {},
        verifyMacosApp: () => calls.push('bundle'),
        verifySignature: () => calls.push('certificate'),
        packageArtifacts: (staged) => {
          expect(
            readFileSync(
              path.join(staged, 'app/Browser Recall.app/Contents'),
              'utf8',
            ),
          ).toBe('fixture app');
          expect(calls).toEqual(['bundle', 'certificate']);
          throw new Error('Disk image creation failed');
        },
      }),
    ).toThrow('Disk image creation failed');
    expect(readFileSync(previous, 'utf8')).toBe('previous disk image');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Windows release collection excludes older installer versions before signature verification', () => {
  const work = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-installer-selection-'),
  );
  try {
    const cargoReleaseDir = path.join(work, 'release');
    const nsis = path.join(cargoReleaseDir, 'bundle/nsis');
    mkdirSync(nsis, { recursive: true });
    writeFileSync(
      path.join(cargoReleaseDir, 'browser-recall-desktop.exe'),
      'executable',
    );
    writeFileSync(path.join(nsis, 'old-setup.exe'), 'old certificate');
    writeFileSync(path.join(nsis, 'new-setup.exe'), 'new certificate');
    collectDesktopArtifacts({
      cargoReleaseDir,
      outDir: path.join(work, 'dist'),
      platformName: 'windows',
      bundles: ['nsis'],
      bundleFiles: { nsis: ['new-setup.exe'] },
      verify: (staged) =>
        expect(readdirSync(path.join(staged, 'nsis'))).toEqual([
          'new-setup.exe',
        ]),
    });
    expect(
      readFileSync(path.join(work, 'dist/windows/nsis/new-setup.exe'), 'utf8'),
    ).toBe('new certificate');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test.each(['macos', 'windows'])(
  'rejected %s signature preserves the complete previous output',
  (platformName) => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-signature-rollback-'),
    );
    const cargoReleaseDir = path.join(work, 'release');
    const outDir = path.join(work, 'dist');
    const name =
      platformName === 'windows'
        ? 'browser-recall-desktop.exe'
        : 'browser-recall-desktop';
    const previous = path.join(outDir, platformName, 'bin', name);
    try {
      mkdirSync(cargoReleaseDir, { recursive: true });
      mkdirSync(path.dirname(previous), { recursive: true });
      writeFileSync(path.join(cargoReleaseDir, name), 'new build');
      writeFileSync(previous, 'previous verified build');
      const companion = path.join(outDir, platformName, 'keep.txt');
      writeFileSync(companion, 'previous companion');
      expect(() =>
        collectDesktopArtifacts({
          cargoReleaseDir,
          outDir,
          platformName,
          verify: (staged) => {
            expect(readFileSync(path.join(staged, 'bin', name), 'utf8')).toBe(
              'new build',
            );
            throw new Error('Certificate does not match');
          },
        }),
      ).toThrow('Certificate does not match');
      expect(readFileSync(previous, 'utf8')).toBe('previous verified build');
      expect(readFileSync(companion, 'utf8')).toBe('previous companion');
      expect(readdirSync(outDir)).toEqual([platformName]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test.each([true, false])(
  'macOS artifact collection with a leftover documentation bundle and production app present=%s',
  (hasProductionApp) => {
    const root = mkdtempSync(path.join(tmpdir(), 'browser-recall-artifacts-'));
    const cargoReleaseDir = path.join(root, 'target-release');
    const outDir = path.join(root, 'dist-desktop');
    const bundleDir = path.join(cargoReleaseDir, 'bundle', 'macos');
    const documentationApp = path.join(
      bundleDir,
      'Browser Recall Documentation.app',
    );
    const productionApp = path.join(bundleDir, 'Browser Recall.app');
    const previousExecutable = path.join(
      outDir,
      'macos',
      'bin',
      'browser-recall-desktop',
    );
    try {
      mkdirSync(documentationApp, { recursive: true });
      writeFileSync(path.join(documentationApp, 'Contents'), 'documentation');
      writeFileSync(
        path.join(cargoReleaseDir, 'browser-recall-desktop'),
        'new',
      );
      if (hasProductionApp) {
        mkdirSync(productionApp);
        writeFileSync(path.join(productionApp, 'Contents'), 'production');
      } else {
        mkdirSync(path.dirname(previousExecutable), { recursive: true });
        writeFileSync(previousExecutable, 'previous');
      }

      const collect = () =>
        collectDesktopArtifacts({
          cargoReleaseDir,
          outDir,
          platformName: 'macos',
          bundles: ['app'],
        });
      if (hasProductionApp) {
        collect();
        expect(readdirSync(path.join(outDir, 'macos', 'app'))).toEqual([
          'Browser Recall.app',
        ]);
        expect(
          readFileSync(
            path.join(outDir, 'macos', 'app', 'Browser Recall.app', 'Contents'),
            'utf8',
          ),
        ).toBe('production');
      } else {
        expect(collect).toThrow(
          /Missing app bundle output:.*Browser Recall\.app/,
        );
        expect(readFileSync(previousExecutable, 'utf8')).toBe('previous');
      }
      expect(existsSync(documentationApp)).toBe(true);
      expect(readdirSync(outDir)).toEqual(['macos']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each([
  ['macos', false],
  ['linux', false],
  ['macos', true],
  ['linux', true],
])(
  '%s artifact promotion failure preserves previous output, restoration fails=%s',
  (platformName, restorationFails) => {
    const root = mkdtempSync(path.join(tmpdir(), 'browser-recall-promotion-'));
    const cargoReleaseDir = path.join(root, 'release');
    const outDir = path.join(root, 'dist');
    const platformOutDir = path.join(outDir, platformName);
    const previousExecutable = path.join(
      platformOutDir,
      'bin',
      'browser-recall-desktop',
    );
    const originalRename = fs.renameSync;
    let rename;
    try {
      mkdirSync(path.dirname(previousExecutable), { recursive: true });
      writeFileSync(previousExecutable, 'previous');
      writeFileSync(
        path.join(platformOutDir, 'previous-bundle'),
        'previous bundle',
      );
      mkdirSync(cargoReleaseDir);
      writeFileSync(
        path.join(cargoReleaseDir, 'browser-recall-desktop'),
        'new',
      );
      rename = vi
        .spyOn(fs, 'renameSync')
        .mockImplementation((source, destination) => {
          if (source.startsWith(`${platformOutDir}.staging-`)) {
            throw new Error('promotion failed');
          }
          if (
            restorationFails &&
            source.startsWith(`${platformOutDir}.backup-`)
          ) {
            throw new Error('restoration failed');
          }
          return originalRename(source, destination);
        });
      let failure;
      try {
        collectDesktopArtifacts({ cargoReleaseDir, outDir, platformName });
      } catch (error) {
        failure = error;
      }
      if (restorationFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors.map((error) => error.message)).toEqual([
          'promotion failed',
          'restoration failed',
        ]);
        const entries = readdirSync(outDir);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(new RegExp(`^${platformName}\\.backup-`));
        expect(failure.message).toContain(path.join(outDir, entries[0]));
        expect(
          readFileSync(
            path.join(
              outDir,
              entries[0],
              'previous',
              'bin',
              'browser-recall-desktop',
            ),
            'utf8',
          ),
        ).toBe('previous');
      } else {
        expect(failure.message).toBe('promotion failed');
        expect(existsSync(previousExecutable)).toBe(true);
        expect(readFileSync(previousExecutable, 'utf8')).toBe('previous');
        expect(
          readFileSync(path.join(platformOutDir, 'previous-bundle'), 'utf8'),
        ).toBe('previous bundle');
        expect(readdirSync(outDir)).toEqual([platformName]);
      }
    } finally {
      rename?.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  'replaces stale desktop output with Windows directory semantics (promotion failure: %s)',
  (failPromotion) => {
    const root = fs.mkdtempSync(
      path.join(tmpdir(), 'browser-recall-desktop-artifacts-'),
    );
    const cargoReleaseDir = path.join(root, 'target-release');
    const outDir = path.join(root, 'dist-desktop');
    const platformOutDir = path.join(outDir, 'macos');
    const oldArtifact = path.join(platformOutDir, 'app', 'Old.app', 'Contents');
    const newArtifact = path.join(platformOutDir, 'dmg', 'Browser Recall.dmg');
    fs.mkdirSync(path.join(cargoReleaseDir, 'bundle', 'dmg'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(platformOutDir, 'app', 'Old.app'), {
      recursive: true,
    });
    fs.writeFileSync(oldArtifact, 'previous app');
    fs.writeFileSync(
      path.join(cargoReleaseDir, 'browser-recall-desktop'),
      'bin',
    );
    fs.writeFileSync(
      path.join(cargoReleaseDir, 'bundle', 'dmg', 'Browser Recall.dmg'),
      'dmg',
    );

    const rename = fs.renameSync;
    const renameSpy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementation((source, destination) => {
        // Windows cannot rename a directory onto an existing directory.
        if (fs.statSync(source).isDirectory() && fs.existsSync(destination)) {
          throw Object.assign(new Error('EPERM: rename destination exists'), {
            code: 'EPERM',
          });
        }
        if (
          failPromotion &&
          source.startsWith(`${platformOutDir}.staging-`) &&
          destination === platformOutDir
        ) {
          throw new Error('simulated output promotion failure');
        }
        return rename(source, destination);
      });
    try {
      const collect = () =>
        collectDesktopArtifacts({
          cargoReleaseDir,
          outDir,
          platformName: 'macos',
          bundles: ['dmg'],
        });
      if (failPromotion) {
        expect(collect).toThrow('simulated output promotion failure');
        expect(fs.readFileSync(oldArtifact, 'utf8')).toBe('previous app');
        expect(fs.existsSync(newArtifact)).toBe(false);
      } else {
        collect();
        expect(fs.existsSync(path.join(platformOutDir, 'app'))).toBe(false);
        expect(fs.readFileSync(newArtifact, 'utf8')).toBe('dmg');
        expect(
          fs.readFileSync(
            path.join(platformOutDir, 'bin', 'browser-recall-desktop'),
            'utf8',
          ),
        ).toBe('bin');
      }
      expect(fs.readdirSync(outDir)).toEqual(['macos']);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
