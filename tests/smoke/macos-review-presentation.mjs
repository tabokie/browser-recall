import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.log('macOS review presentation regression skipped');
  process.exit(0);
}
const root = path.resolve(import.meta.dirname, '../..');
const workDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'browser-recall-review-'),
);
try {
  const bundle = path.join(workDir, 'Review Probe.app');
  const macOS = path.join(bundle, 'Contents/MacOS');
  fs.mkdirSync(macOS, { recursive: true });
  fs.writeFileSync(
    path.join(bundle, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>app.browser-recall.review-probe</string>
    <key>CFBundleExecutable</key><string>review-probe</string>
    <key>CFBundlePackageType</key><string>APPL</string>
  </dict></plist>`,
  );
  const executable = path.join(macOS, 'review-probe');
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-warnings-as-errors',
      '-parse-as-library',
      '-module-cache-path',
      path.join(workDir, 'module-cache'),
      '-framework',
      'AppKit',
      '-framework',
      'StoreKit',
      path.join(root, 'apps/desktop/src-tauri/src/reviews.swift'),
      path.join(root, 'tests/smoke/macos-review-presentation.swift'),
      '-o',
      executable,
    ],
    { stdio: 'inherit' },
  );
  console.log(
    execFileSync(executable, { encoding: 'utf8', timeout: 30000 }).trim(),
  );
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
