import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { compileDocumentationWindow } from '../../scripts/lib/documentation-native-capture.mjs';
import {
  assertMacosUrlHandler,
  buildAndRegisterMacosDocumentationApp,
} from '../smoke/macos-documentation-app.mjs';
import { withCleanup } from '../smoke/desktop-test-cleanup.mjs';
import { verifyMacosDocumentationApp } from '../../scripts/verify-macos-documentation-app.mjs';
import {
  macosAppRegistrar,
  MacosAppRegistrations,
} from '../smoke/macos-desktop-process.mjs';

test.skipIf(process.platform !== 'darwin')(
  'documentation verification rejects an executable without the no-tray build contract',
  () => {
    const work = mkdtempSync(
      path.join('/private/tmp', 'browser-recall-tray-contract-'),
    );
    try {
      const app = path.join(work, 'Documentation.app');
      writeApp(app, 'app.browser-recall.documentation', '/usr/bin/false');
      expect(() => verifyMacosDocumentationApp(app)).toThrow(/no-tray/);
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        'Delete :BrowserRecallNoTray',
        path.join(app, 'Contents/Info.plist'),
      ]);
      expect(() => verifyMacosDocumentationApp(app)).toThrow(
        /missing no-tray build metadata/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'documentation registration preserves identity when LaunchServices switches between production copies',
  async () => {
    // Keep app fixtures outside macOS's temporary directory so LaunchServices
    // can resolve the registered bundles. test-results is ignored by Git.
    const fixtureRoot = path.resolve(import.meta.dirname, '../../test-results');
    mkdirSync(fixtureRoot, { recursive: true });
    const work = mkdtempSync(path.join(fixtureRoot, 'browser-recall-routing-'));
    const productionApp = path.join(work, 'dist/Production.app');
    const extractedApp = path.join(work, 'release-check/Production.app');
    const documentationApp = path.join(work, 'Documentation.app');
    // A unique scheme exercises LaunchServices without touching Browser Recall
    // routing or the user's chosen default application.
    const scheme = `browser-recall-test-${randomUUID()}`;
    const registrations = new MacosAppRegistrations();
    let previousPath;
    let reads = 0;
    await withCleanup(async () => {
      const helper = compileDocumentationWindow(work);
      const nativeHandler = () =>
        execFileSync(helper, ['url-handler', `${scheme}://open`], {
          encoding: 'utf8',
        }).trim();
      const readHandler = () => {
        if (++reads === 2) {
          // Force LaunchServices to choose the other registered production copy
          // between the baseline and post-registration reads. Neither app's
          // identity or URL schemes changed.
          execFileSync(macosAppRegistrar, ['-u', previousPath]);
          const retired = path.join(work, 'retired.noindex');
          mkdirSync(retired);
          renameSync(previousPath, path.join(retired, 'Production.app'));
        }
        const selected = nativeHandler();
        if (reads === 1) previousPath = selected;
        return selected;
      };
      expect(nativeHandler()).toBe('none');
      const previousHandler = await buildAndRegisterMacosDocumentationApp({
        app: documentationApp,
        readHandler,
        productionApp,
        registrations,
        build: async () => {
          // Release validation also extracts the production bundle. LaunchServices
          // may select that copy rather than the original path passed by CI.
          writeApp(productionApp, `app.${scheme}`, helper, [scheme]);
          cpSync(productionApp, extractedApp, { recursive: true });
          registrations.register(productionApp);
          registrations.register(extractedApp);
          await expect
            .poll(nativeHandler)
            .toSatisfy((handler) =>
              [productionApp, extractedApp].includes(handler),
            );
          writeApp(
            documentationApp,
            'app.browser-recall.documentation',
            helper,
          );
        },
      });
      expect(previousHandler.identifier).toBe(`app.${scheme}`);
      expect(previousHandler.path).toBe(previousPath);
      expect(nativeHandler()).not.toBe(previousPath);
      // Reproduce CI's primary and teardown failure together: a valid bundle is
      // built, but fixture validation rejects it before registration. Cleanup
      // must not add a LaunchServices error for that unregistered bundle.
      const unregisteredApp = path.join(work, 'Unregistered Documentation.app');
      const failedRegistrations = new MacosAppRegistrations();
      const failure = await withCleanup(
        () =>
          buildAndRegisterMacosDocumentationApp({
            app: unregisteredApp,
            readHandler: nativeHandler,
            productionApp: unregisteredApp,
            registrations: failedRegistrations,
            build: async () =>
              writeApp(
                unregisteredApp,
                'app.browser-recall.documentation',
                helper,
              ),
          }),
        [() => failedRegistrations.cleanup()],
      ).catch((error) => error);
      expect(failure).not.toBeInstanceOf(AggregateError);
      expect(failure.code).toBe('ERR_ASSERTION');
      expect(failure.message).toContain(
        'URL handler is not the production application',
      );
      expect(existsSync(unregisteredApp)).toBe(true);
      await failedRegistrations.cleanup();
      // Moving the baseline must still reject a retained documentation bundle
      // that declares URL schemes, before registering that bundle.
      const invalidApp = path.join(work, 'invalid.noindex/Documentation.app');
      writeApp(invalidApp, 'app.browser-recall.documentation', helper, [
        scheme,
      ]);
      await expect(
        buildAndRegisterMacosDocumentationApp({
          app: invalidApp,
          readHandler,
          registrations,
          build: async () => {},
        }),
      ).rejects.toThrow('Documentation app must not register URL schemes');
      expect([productionApp, extractedApp]).toContain(nativeHandler());
      // An actual change of application identity still fails. Move the remaining
      // production copy out of discovery, then register a different handler.
      const remaining = nativeHandler();
      execFileSync(macosAppRegistrar, ['-u', remaining]);
      const retired = path.join(work, 'also-retired.noindex');
      mkdirSync(retired);
      renameSync(remaining, path.join(retired, 'Production.app'));
      const otherApp = path.join(work, 'Other.app');
      writeApp(otherApp, `app.other-${scheme}`, helper, [scheme]);
      registrations.register(otherApp);
      await expect.poll(nativeHandler).toBe(otherApp);
      expect(() =>
        assertMacosUrlHandler(
          nativeHandler,
          previousHandler,
          'Routing changed',
        ),
      ).toThrow('Routing changed');
    }, [
      () => registrations.cleanup(),
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
      ...(identifier === 'app.browser-recall.documentation'
        ? { BrowserRecallNoTray: true }
        : {}),
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
