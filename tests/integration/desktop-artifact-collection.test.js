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
            path.join(outDir, entries[0], 'bin', 'browser-recall-desktop'),
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
