import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

test
  .skipIf(process.platform !== 'darwin')
  .each([
    'tests/smoke/macos-desktop-window-lifecycle.mjs',
    'tests/smoke/desktop-update-lifecycle.mjs',
    'scripts/dev-desktop.mjs',
  ])(
  '%s refuses a personal macOS session before invoking native tools',
  (script) => {
    if (script === 'scripts/dev-desktop.mjs') {
      const desktopPackage = JSON.parse(
        readFileSync(path.join(root, 'apps/desktop/package.json')),
      );
      expect(desktopPackage.scripts.dev).toBe(
        'node ../../scripts/dev-desktop.mjs',
      );
    }
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-session-guard-'),
    );
    const env = { ...process.env, TMPDIR: work };
    delete env.BROWSER_RECALL_ISOLATED_MACOS_SESSION;
    try {
      // If a guard regresses, prevent builds, app launches, and OS registration.
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import childProcess from 'node:child_process';
         import { syncBuiltinESMExports } from 'node:module';
         const blocked = () => { throw new Error('Native tool invoked before session guard'); };
         childProcess.spawn = blocked;
         childProcess.spawnSync = blocked;
         childProcess.execFileSync = blocked;
         syncBuiltinESMExports();
         await import(${JSON.stringify(path.join(root, script))});`,
        ],
        { cwd: root, env, encoding: 'utf8', timeout: 15000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'BROWSER_RECALL_ISOLATED_MACOS_SESSION=1',
      );
      expect(result.stderr).not.toContain(
        'Native tool invoked before session guard',
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);
