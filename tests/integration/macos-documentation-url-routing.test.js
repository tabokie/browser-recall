import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { compileDocumentationWindow } from '../../scripts/lib/documentation-native-capture.mjs';
import { buildAndRegisterMacosDocumentationApp } from '../smoke/macos-documentation-app.mjs';
import { withCleanup } from '../smoke/desktop-test-cleanup.mjs';
import {
  macosAppRegistrar,
  unregisterMacosTestApp,
} from '../smoke/macos-desktop-process.mjs';

test.skipIf(process.platform !== 'darwin')(
  'documentation registration preserves a production handler discovered during the build',
  async () => {
    // Keep app fixtures outside macOS's temporary directory so LaunchServices
    // can resolve the registered bundles. test-results is ignored by Git.
    const fixtureRoot = path.resolve(import.meta.dirname, '../../test-results');
    mkdirSync(fixtureRoot, { recursive: true });
    const work = mkdtempSync(path.join(fixtureRoot, 'browser-recall-routing-'));
    const productionApp = path.join(work, 'Production.app');
    const documentationApp = path.join(work, 'Documentation.app');
    // A unique scheme exercises LaunchServices without touching Browser Recall
    // routing or the user's chosen default application.
    const scheme = `browser-recall-test-${randomUUID()}`;
    await withCleanup(async () => {
      const helper = compileDocumentationWindow(work);
      const readHandler = () =>
        execFileSync(helper, ['url-handler', `${scheme}://open`], {
          encoding: 'utf8',
        }).trim();
      expect(readHandler()).toBe('none');
      const previousHandler = await buildAndRegisterMacosDocumentationApp({
        app: documentationApp,
        readHandler,
        build: async () => {
          // Force the same transition as a clean CI runner: production routing
          // becomes available while the documentation build is in progress.
          writeApp(productionApp, `app.${scheme}`, helper, [scheme]);
          execFileSync(macosAppRegistrar, ['-f', productionApp]);
          await expect.poll(readHandler).toBe(productionApp);
          writeApp(
            documentationApp,
            'app.browser-recall.documentation',
            helper,
          );
        },
      });
      expect(previousHandler).toBe(productionApp);
      expect(readHandler()).toBe(productionApp);
      // Moving the baseline must still reject a retained documentation bundle
      // that declares URL schemes, before registering that bundle.
      writeApp(documentationApp, 'app.browser-recall.documentation', helper, [
        scheme,
      ]);
      await expect(
        buildAndRegisterMacosDocumentationApp({
          app: documentationApp,
          readHandler,
          build: async () => {},
        }),
      ).rejects.toThrow('Documentation app must not register URL schemes');
      expect(readHandler()).toBe(productionApp);
    }, [
      () => unregisterMacosTestApp(documentationApp),
      () => unregisterMacosTestApp(productionApp),
      () => rmSync(work, { recursive: true, force: true }),
    ]);
  },
);

function writeApp(app, identifier, executable, schemes = []) {
  const executableDir = path.join(app, 'Contents/MacOS');
  mkdirSync(executableDir, { recursive: true });
  copyFileSync(executable, path.join(executableDir, 'routing-test'));
  const plist = path.join(app, 'Contents/Info.plist');
  writeFileSync(
    plist,
    JSON.stringify({
      CFBundleIdentifier: identifier,
      CFBundleName: path.basename(app, '.app'),
      CFBundleExecutable: 'routing-test',
      CFBundlePackageType: 'APPL',
      CFBundleVersion: '1',
      CFBundleURLTypes: schemes.length
        ? [
            {
              CFBundleTypeRole: 'Editor',
              CFBundleURLName: `${identifier} ${schemes[0]}`,
              CFBundleURLSchemes: schemes,
            },
          ]
        : [],
    }),
  );
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', plist]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], {
    stdio: 'pipe',
  });
}
