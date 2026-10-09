import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { captureInputs } from '../../scripts/lib/documentation-freshness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test.skipIf(process.platform !== 'darwin')(
  'store export stages on the destination volume and preserves prior output on conversion failure',
  () => {
    const work = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'browser-recall-store-export-')),
    );
    const repo = path.join(work, 'repository');
    const temporary = path.join(work, 'system-temporary');
    const names = ['browser-popup-window.png', 'browser-note-window.png'];
    try {
      const files = [
        ...Object.keys(captureInputs(root, 'browser')),
        'docs/images/browser-capture.json',
        ...names.flatMap((name) => [
          `docs/images/${name}`,
          `docs/images/chrome-web-store/${name}`,
        ]),
        'scripts/export-chrome-web-store-screenshots.mjs',
        'scripts/lib/store-screenshot.swift',
      ];
      for (const name of files) {
        mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
        cpSync(path.join(root, name), path.join(repo, name));
      }
      // Include the shared export boundary when present, without making the red
      // phase depend on a production module that has not been implemented yet.
      const shared = 'scripts/lib/store-screenshots.mjs';
      try {
        cpSync(path.join(root, shared), path.join(repo, shared));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      mkdirSync(temporary);
      const preload = path.join(work, 'virtual-volumes.cjs');
      writeFileSync(
        preload,
        `
      const fs = require('node:fs');
      const path = require('node:path');
      const cp = require('node:child_process');
      const { syncBuiltinESMExports } = require('node:module');
      const repo = ${JSON.stringify(repo)};
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        // Model the repository and system temporary directory on separate
        // volumes, as Node's rename cannot cross that filesystem boundary.
        if (destination.startsWith(repo + path.sep) && !source.startsWith(repo + path.sep)) {
          const error = new Error('EXDEV: cross-device rename');
          error.code = 'EXDEV';
          throw error;
        }
        return rename(source, destination);
      };
      cp.execFileSync = (command, args) => {
        if (command === '/usr/bin/swiftc') return Buffer.alloc(0);
        if (process.env.FAIL_STORE_CONVERSION && args[0].endsWith('browser-note-window.png')) {
          throw new Error('injected second conversion failure');
        }
        fs.copyFileSync(path.join(repo, 'docs/images/chrome-web-store', path.basename(args[0])), args[1]);
        return Buffer.alloc(0);
      };
      syncBuiltinESMExports();
    `,
      );
      const run = (fail = false) =>
        spawnSync(
          process.execPath,
          [
            '--require',
            preload,
            path.join(repo, 'scripts/export-chrome-web-store-screenshots.mjs'),
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              TMPDIR: temporary,
              FAIL_STORE_CONVERSION: fail ? '1' : '',
            },
          },
        );
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      const output = path.join(repo, 'docs/images/chrome-web-store');
      const manifest = readFileSync(path.join(output, 'capture.json'));
      const originals = names.map((name) =>
        readFileSync(path.join(output, name)),
      );
      const originalInodes = names.map(
        (name) => statSync(path.join(output, name)).ino,
      );
      const failed = run(true);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('injected second conversion failure');
      expect(readFileSync(path.join(output, 'capture.json'))).toEqual(manifest);
      names.forEach((name, i) =>
        expect(readFileSync(path.join(output, name))).toEqual(originals[i]),
      );
      expect(
        names.map((name) => statSync(path.join(output, name)).ino),
      ).toEqual(originalInodes);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
