#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyMacosDocumentationApp(appPath) {
  const plist = JSON.parse(
    execFileSync(
      '/usr/bin/plutil',
      [
        '-convert',
        'json',
        '-o',
        '-',
        path.join(appPath, 'Contents/Info.plist'),
      ],
      { encoding: 'utf8' },
    ),
  );
  if (plist.CFBundleIdentifier !== 'app.browser-recall.documentation') {
    throw new Error(
      'Documentation app must use its isolated bundle identifier',
    );
  }
  if (
    plist.CFBundleURLTypes !== undefined &&
    (!Array.isArray(plist.CFBundleURLTypes) ||
      plist.CFBundleURLTypes.length > 0)
  ) {
    throw new Error('Documentation app must not register URL schemes');
  }
  // Reject older bundles before executing them: an older binary may ignore the
  // preflight argument and start its normal tray instead.
  if (plist.BrowserRecallNoTray !== true) {
    throw new Error('Documentation app is missing no-tray build metadata');
  }
  if (
    typeof plist.CFBundleExecutable !== 'string' ||
    path.basename(plist.CFBundleExecutable) !== plist.CFBundleExecutable
  ) {
    throw new Error('Documentation app executable is invalid');
  }
  try {
    const mode = execFileSync(
      path.join(appPath, 'Contents/MacOS', plist.CFBundleExecutable),
      ['--check-no-tray'],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (mode !== 'no-tray') throw new Error('Unexpected build mode');
  } catch (error) {
    throw new Error('Documentation app must be built with no-tray', {
      cause: error,
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyMacosDocumentationApp(process.argv[2]);
  console.log('Documentation app does not register URL schemes.');
}
