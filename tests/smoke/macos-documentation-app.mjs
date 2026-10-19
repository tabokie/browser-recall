import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { verifyMacosDocumentationApp } from '../../scripts/verify-macos-documentation-app.mjs';
import { macosAppRegistrar } from './macos-desktop-process.mjs';

export async function buildAndRegisterMacosDocumentationApp({
  build,
  app,
  readHandler,
  expectedHandler,
}) {
  await build();
  // Check the retained bundle, since removing URL schemes from only a temporary
  // capture copy still lets the retained bundle change macOS URL routing.
  verifyMacosDocumentationApp(app);
  // The build can give LaunchServices time to discover the production app on a
  // clean runner. Compare routing immediately around documentation registration.
  const previousHandler = readHandler();
  if (expectedHandler !== undefined)
    assert.equal(
      previousHandler,
      expectedHandler,
      'Production URL handler fixture is missing',
    );
  execFileSync(macosAppRegistrar, ['-f', app]);
  assert.equal(
    readHandler(),
    previousHandler,
    'Registering the retained documentation app changed Browser Recall URL routing',
  );
  return previousHandler;
}
