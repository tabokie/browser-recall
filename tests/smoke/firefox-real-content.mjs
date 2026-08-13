import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupStagedAssets,
  stageFirefoxExtensionAssets,
} from '../../scripts/stage-app-assets.mjs';

const firefoxBinary =
  process.env.FIREFOX_BINARY ||
  '/Applications/Firefox.app/Contents/MacOS/firefox';
if (!fs.existsSync(firefoxBinary)) {
  throw new Error(`Firefox binary does not exist: ${firefoxBinary}`);
}

const extensionDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'browser-recall-firefox-real-extension-'),
);
stageFirefoxExtensionAssets(extensionDir);

let reportResolve;
let reportReject;
const report = new Promise((resolve, reject) => {
  reportResolve = resolve;
  reportReject = reject;
});
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/report?payload=')) {
    reportResolve(
      JSON.parse(
        decodeURIComponent(request.url.slice('/report?payload='.length)),
      ),
    );
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Firefox Content Probe</title>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

fs.writeFileSync(
  path.join(extensionDir, 'firefox-real-content-probe.js'),
  `fetch('http://127.0.0.1:${port}/report?payload=' + encodeURIComponent(JSON.stringify({
  buildTarget: globalThis.browserRecallWebExtension?.buildTarget,
  executionContext: globalThis.browserRecallWebExtension?.executionContext,
  runtimeConnect: typeof chrome.runtime?.connect,
  action: typeof chrome.action,
  contextMenus: typeof chrome.contextMenus,
})));\n`,
);
const manifestPath = path.join(extensionDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.content_scripts.push({
  matches: ['http://127.0.0.1/*'],
  js: [
    'browser-build-target.js',
    'browser-api.js',
    'firefox-real-content-probe.js',
  ],
  run_at: 'document_idle',
});
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

let firefoxOutput = '';
const firefox = spawn(
  'npx',
  [
    '--yes',
    'web-ext@10.5.0',
    'run',
    '--source-dir',
    extensionDir,
    '--firefox',
    firefoxBinary,
    '--start-url',
    `http://127.0.0.1:${port}/probe`,
    '--no-reload',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
firefox.stdout.on('data', (chunk) => {
  firefoxOutput += chunk;
});
firefox.stderr.on('data', (chunk) => {
  firefoxOutput += chunk;
});
firefox.once('error', reportReject);
firefox.once('exit', (code) => {
  if (code !== 0) reportReject(new Error(`Firefox exited with status ${code}`));
});

let timeout;
try {
  const result = await Promise.race([
    report,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for Firefox content probe\n${firefoxOutput}`,
            ),
          ),
        20_000,
      );
    }),
  ]);
  const expected = {
    buildTarget: 'firefox',
    executionContext: 'content',
    runtimeConnect: 'function',
    action: 'undefined',
    contextMenus: 'undefined',
  };
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected Firefox content API contract: ${JSON.stringify(result)}`,
    );
  }
  console.log(
    `Firefox content API contract verified: ${JSON.stringify(result)}`,
  );
} finally {
  clearTimeout(timeout);
  firefox.kill('SIGTERM');
  await new Promise((resolve) => server.close(resolve));
  cleanupStagedAssets(extensionDir);
}
