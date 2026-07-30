import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') {
  console.log('macOS WKWebView chart-layout regression skipped');
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, '../..');
const source = path.join(
  root,
  'tests/smoke/macos-wkwebview-chart-layout.swift',
);
const indexPath = path.join(root, 'dist/desktop/ui/index.html');
if (!fs.existsSync(indexPath)) {
  throw new Error(
    `Staged desktop UI is missing at ${indexPath}; run npm run build:desktop-ui first`,
  );
}

const workDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'browser-recall-wkwebview-chart-'),
);
const executable = path.join(workDir, 'chart-layout-probe');

try {
  execFileSync(
    '/usr/bin/swiftc',
    [
      '-suppress-warnings',
      '-framework',
      'AppKit',
      '-framework',
      'WebKit',
      source,
      '-o',
      executable,
    ],
    { stdio: 'inherit' },
  );
  const output = execFileSync(executable, [indexPath], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
  const result = JSON.parse(output.split('\n').at(-1));
  const expectedGap = 16;
  if (Math.abs(result.before.visibleGap - expectedGap) > 0.5) {
    throw new Error(
      `The initial WKWebView chart-to-list gap changed from ${expectedGap}px to ${result.before.visibleGap}px:\n${JSON.stringify(result, null, 2)}`,
    );
  }
  const shift = result.after.visibleGap - result.before.visibleGap;
  if (Math.abs(shift) > 0.5) {
    throw new Error(
      `Selecting a page widened the WKWebView chart-to-list gap by ${shift}px:\n${JSON.stringify(result, null, 2)}`,
    );
  }
  console.log('WKWebView chart-to-list spacing remained stable');
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
