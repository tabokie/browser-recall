import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifyMacosDocumentationApp } from '../../scripts/verify-macos-documentation-app.mjs';

function bundleIdentifier(bundle) {
  return execFileSync(
    '/usr/libexec/PlistBuddy',
    [
      '-c',
      'Print :CFBundleIdentifier',
      path.join(bundle, 'Contents/Info.plist'),
    ],
    { encoding: 'utf8' },
  ).trim();
}

function urlHandler(readHandler) {
  const selected = readHandler();
  return {
    path: selected,
    identifier: selected === 'none' ? null : bundleIdentifier(selected),
  };
}

export function assertMacosUrlHandler(readHandler, previous, message) {
  const current = urlHandler(readHandler);
  // LaunchServices can switch between production copies while discovering apps.
  // Preserve application identity; retain both paths only for diagnostics.
  assert.equal(
    current.identifier,
    previous.identifier,
    `${message}\nPrevious app: ${previous.path}\nCurrent app: ${current.path}`,
  );
}

export async function buildAndRegisterMacosDocumentationApp({
  build,
  app,
  readHandler,
  productionApp,
  registrations,
}) {
  await build();
  // Check the retained bundle, since removing URL schemes from only a temporary
  // capture copy still lets the retained bundle change macOS URL routing.
  verifyMacosDocumentationApp(app);
  // The build can give LaunchServices time to discover the production app on a
  // clean runner. Compare routing immediately around documentation registration.
  const previousHandler = urlHandler(readHandler);
  if (productionApp !== undefined) {
    assert.notEqual(
      previousHandler.identifier,
      null,
      'Production URL handler fixture is missing',
    );
    assert.equal(
      previousHandler.identifier,
      bundleIdentifier(productionApp),
      'URL handler is not the production application',
    );
  }
  registrations.register(app);
  assertMacosUrlHandler(
    readHandler,
    previousHandler,
    'Registering the retained documentation app changed Browser Recall URL routing',
  );
  return previousHandler;
}
