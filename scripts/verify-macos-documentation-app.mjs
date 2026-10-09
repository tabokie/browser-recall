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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyMacosDocumentationApp(process.argv[2]);
  console.log('Documentation app does not register URL schemes.');
}
