export function requireIsolatedMacosSession() {
  if (
    process.platform === 'darwin' &&
    process.env.BROWSER_RECALL_ISOLATED_MACOS_SESSION !== '1'
  ) {
    throw new Error(
      'Native Browser Recall automation registers macOS menu bar items. Run only in a disposable macOS user account or CI runner with BROWSER_RECALL_ISOLATED_MACOS_SESSION=1. A temporary HOME or app identifier does not isolate Control Center ownership. Do not set this flag in your personal login session.',
    );
  }
}
import { execFileSync } from 'node:child_process';
import { verifyMacosDocumentationApp } from '../verify-macos-documentation-app.mjs';

export function launchMacosDocumentationApp(app, environment) {
  verifyMacosDocumentationApp(app);
  const variables = Object.entries(environment).flatMap(([key, value]) => [
    '--env',
    `${key}=${value}`,
  ]);
  execFileSync('/usr/bin/open', ['-n', '-F', ...variables, app]);
}
