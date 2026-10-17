import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { verifyWindowsInstalledExecutable } from '../../scripts/verify-windows-installed-executable.mjs';

// Windows CI provides 7-Zip. Other hosts can run the same archive and filesystem
// regression with 7z on PATH; no installer or native app is launched.
const sevenZip = spawnSync('7z', ['i'], { stdio: 'ignore', windowsHide: true });
if (process.platform === 'win32' && sevenZip.status !== 0)
  throw new Error('Windows installer regression requires 7z on PATH');

test.skipIf(sevenZip.status !== 0)(
  'installed executable matches packaged bytes, not the unpatched build',
  () => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-payload-test-'),
    );
    try {
      const payload = path.join(work, 'payload');
      mkdirSync(payload);
      const name = 'browser-recall-desktop.exe';
      const raw = Buffer.from('raw executable before bundling');
      const packaged = Buffer.from('executable patched by the bundler');
      writeFileSync(path.join(payload, name), packaged);
      const installer = path.join(work, 'Browser Recall_1.0.1_x64-setup.exe');
      execFileSync('7z', ['a', '-t7z', installer, name], {
        cwd: payload,
        stdio: 'pipe',
      });
      const installation = path.join(work, 'installation with spaces');
      mkdirSync(installation);
      const installed = path.join(installation, name);
      writeFileSync(installed, packaged);
      expect(() =>
        verifyWindowsInstalledExecutable(installer, installed),
      ).not.toThrow();
      expect(
        execFileSync(
          process.execPath,
          [
            path.resolve(
              import.meta.dirname,
              '../../scripts/verify-windows-installed-executable.mjs',
            ),
            installer,
            installed,
          ],
          { encoding: 'utf8' },
        ),
      ).toContain('Installed executable matches the NSIS installer payload');
      for (const invalid of [
        raw,
        Buffer.concat([packaged, Buffer.from('changed')]),
      ]) {
        writeFileSync(installed, invalid);
        expect(() =>
          verifyWindowsInstalledExecutable(installer, installed),
        ).toThrow('Installed executable differs from the installer payload');
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test.skipIf(sevenZip.status !== 0).each([0, 2])(
  'installer verification rejects an ambiguous or absent executable: %s matches',
  (count) => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-payload-test-'),
    );
    try {
      const payload = path.join(work, 'payload');
      mkdirSync(payload);
      writeFileSync(path.join(payload, 'resource.txt'), 'resource');
      for (let index = 0; index < count; index++) {
        const folder = path.join(payload, String(index));
        mkdirSync(folder);
        writeFileSync(
          path.join(folder, 'browser-recall-desktop.exe'),
          'packaged',
        );
      }
      const installer = path.join(work, 'setup.exe');
      execFileSync('7z', ['a', '-t7z', installer, '.'], {
        cwd: payload,
        stdio: 'pipe',
      });
      expect(() =>
        verifyWindowsInstalledExecutable(
          installer,
          path.join(work, 'installed.exe'),
        ),
      ).toThrow(
        `Expected one desktop executable in the installer; found ${count}`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
