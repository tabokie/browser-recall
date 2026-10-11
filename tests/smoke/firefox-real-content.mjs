import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  canonicalizePageUrl,
  generateSlugFromUrl,
} from '../../packages/core/page-identity.js';
import {
  launchTestDaemon,
  waitForDaemonListening,
  stopTestDaemon,
} from '../integration/daemon-test-harness.js';

import {
  cleanupStagedAssets,
  stageFirefoxExtensionAssets,
} from '../../scripts/stage-app-assets.mjs';

const firefoxBinary =
  process.env.FIREFOX_BINARY ||
  (process.platform === 'darwin'
    ? '/Applications/Firefox.app/Contents/MacOS/firefox'
    : '/usr/bin/firefox');
if (!fs.existsSync(firefoxBinary)) {
  throw new Error(`Firefox binary does not exist: ${firefoxBinary}`);
}

function readVisitRecords(configDir) {
  const logsDir = path.join(configDir, 'browser-data/logs');
  if (!fs.existsSync(logsDir)) return [];
  return fs.readdirSync(logsDir).flatMap((device) =>
    fs
      .readdirSync(path.join(logsDir, device))
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) =>
        fs
          .readFileSync(path.join(logsDir, device, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ),
  );
}

let extensionDir;
let configDir;
let portReservation;
let daemon;
let server;
let firefox;
let timeout;
try {
  extensionDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-firefox-real-extension-'),
  );
  stageFirefoxExtensionAssets(extensionDir);
  configDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'browser-recall-firefox-real-daemon-'),
  );
  portReservation = net.createServer();
  await new Promise((resolve, reject) => {
    portReservation.once('error', reject);
    portReservation.listen(0, '127.0.0.1', resolve);
  });
  const daemonPort = portReservation.address().port;
  await new Promise((resolve) => portReservation.close(resolve));
  daemon = launchTestDaemon(configDir, { ports: [daemonPort] });
  await waitForDaemonListening(daemon);
  const clientPath = path.join(extensionDir, 'connector/ws-client.js');
  fs.writeFileSync(
    clientPath,
    `globalThis.__BROWSER_RECALL_CONNECTOR_PORTS = [${daemonPort}];\n` +
      fs.readFileSync(clientPath, 'utf8'),
  );

  let reportResolve;
  let reportReject;
  const report = new Promise((resolve, reject) => {
    reportResolve = resolve;
    reportReject = reject;
  });
  server = http.createServer(async (request, response) => {
    if (request.url.startsWith('/unrecorded?')) {
      const url = canonicalizePageUrl(
        new URL(request.url, 'http://localhost').searchParams.get('url'),
      );
      const captured = readVisitRecords(configDir).some(
        (record) => record.url === url,
      );
      response.writeHead(captured ? 500 : 200, {
        'content-type': 'application/json',
      });
      response.end(
        JSON.stringify({
          success: !captured,
          error: captured
            ? 'Paused document was recorded before refresh'
            : undefined,
        }),
      );
      return;
    }
    if (request.url.startsWith('/visit?')) {
      try {
        const url = canonicalizePageUrl(
          new URL(request.url, 'http://localhost').searchParams.get('url'),
        );
        const deadline = Date.now() + 10000;
        while (
          !readVisitRecords(configDir).some(
            (record) => record.action === 'visit_page' && record.url === url,
          )
        ) {
          if (Date.now() >= deadline)
            throw new Error(
              'Automatic Firefox capture did not persist the visit: ' + url,
            );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true }));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: false, error: error.message }));
      }
      return;
    }
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
    if (request.url === '/navigate.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(
        "document.title = 'Firefox Navigation Destination'; history.pushState({}, '', '/destination?client=firefox-b-d&q=next&id=1&id=2&_tracking=discard');",
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Firefox Content Probe</title>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const initialUrl = `http://127.0.0.1:${port}/probe?client=firefox-b-d&q=test&id=1&id=2&_tracking=discard`;
  const destinationUrl = `http://127.0.0.1:${port}/destination?client=firefox-b-d&q=next&id=1&id=2&_tracking=discard`;
  const pausedUrl = `http://127.0.0.1:${port}/paused`;

  fs.writeFileSync(
    path.join(extensionDir, 'firefox-real-content-probe.js'),
    `(async () => {
const report = (value) => fetch('http://127.0.0.1:${port}/report?payload=' + encodeURIComponent(JSON.stringify(value)));
// Verify persisted visits before identity or navigation probes: those probes
// can trigger capture and hide a broken automatic-capture event path.
const waitForVisit = async (url) => {
  const response = await fetch('http://127.0.0.1:${port}/visit?url=' + encodeURIComponent(url));
  const result = await response.json();
  if (!response.ok || result.success !== true) throw new Error(result.error || 'Automatic capture failed');
};
try {
  if (location.pathname === '/paused') {
    const recording = await chrome.runtime.sendMessage({ action: 'getRecordingState' });
    if (recording?.mode === 'private') {
      await chrome.runtime.sendMessage({ action: 'firefoxDormantReady' });
    } else if (recording?.mode === 'default') {
      await waitForVisit(location.href);
    } else { throw new Error('Paused tab recording state is invalid'); }
    return;
  }
  await waitForVisit(location.href);
  const initial = await chrome.runtime.sendMessage({ action: 'firefoxRealContentProbe' });
  if (initial.error) throw new Error(initial.error);
  let connector;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    connector = await chrome.runtime.sendMessage({ action: 'getDesktopConnectorState' });
    if (connector?.state === 'connected') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (connector?.state !== 'connected') throw new Error('Firefox did not connect to the test daemon: ' + JSON.stringify(connector));
  const script = document.createElement('script');
  script.src = 'http://127.0.0.1:${port}/navigate.js';
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  await waitForVisit(location.href);
  const destination = await chrome.runtime.sendMessage({ action: 'firefoxRealContentProbe' });
  const paused = await chrome.runtime.sendMessage({ action: 'setRecordingPaused', paused: true });
  if (!paused?.success) throw new Error(paused?.error || 'Could not pause recording');
  const dormant = await chrome.runtime.sendMessage({ action: 'firefoxRealContentProbe', phase: 'openDormant' });
  const resumed = await chrome.runtime.sendMessage({ action: 'setRecordingPaused', paused: false });
  if (!resumed?.success) throw new Error(resumed?.error || 'Could not resume recording');
  const excluded = await chrome.runtime.sendMessage({ action: 'firefoxRealContentProbe', tabId: dormant.tabId });
  if (excluded.identity?.recordingEligible !== false) throw new Error('Resuming enabled a paused document');
  const flushExcluded = await chrome.runtime.sendMessage({ action: 'flushDesktopQueue' });
  if (!flushExcluded?.success) throw new Error(flushExcluded?.error || 'Could not flush capture queue');
  const unrecorded = await fetch('http://127.0.0.1:${port}/unrecorded?url=' + encodeURIComponent('http://127.0.0.1:${port}/paused'));
  if (!unrecorded.ok) throw new Error((await unrecorded.json()).error);
  await chrome.runtime.sendMessage({ action: 'firefoxRealContentProbe', phase: 'refreshDormant', tabId: dormant.tabId });
  await waitForVisit('http://127.0.0.1:${port}/paused');
  const recovered = await chrome.runtime.sendMessage({ action: 'firefoxRealContentProbe', tabId: dormant.tabId });
  const flush = await chrome.runtime.sendMessage({ action: 'flushDesktopQueue' });
  if (!flush?.success) throw new Error(flush?.error || 'Could not flush captured visits');
  const options = await chrome.runtime.sendMessage({ action: 'firefoxRealContentProbe', phase: 'options' });
  await report({ initial, destination, dormant, excluded, recovered, options, contentErrors: globalThis.firefoxRealContentErrors });
} catch (error) {
  await report({ error: error.message, contentErrors: globalThis.firefoxRealContentErrors });
}
})();\n`,
  );
  fs.writeFileSync(
    path.join(extensionDir, 'firefox-real-background-probe.js'),
    `globalThis.browserRecallBackgroundTestActions = new Set(['firefoxRealContentProbe', 'firefoxDormantReady', 'firefoxOptionsPopupReady']);
let resolveDormant;
const dormantReady = new Promise(resolve => { resolveDormant = resolve; });
const popupWaiters = new Map();
chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.action === 'firefoxDormantReady') { resolveDormant(); return Promise.resolve({ success: true }); }
  if (request.action === 'firefoxOptionsPopupReady') { popupWaiters.get(request.phase)?.(request.snapshot); return Promise.resolve({ success: true }); }
  if (request.action !== 'firefoxRealContentProbe') return false;
  return (async () => {
    if (request.phase === 'options') {
      const optionsUrl = chrome.runtime.getURL('options-stub.html');
      const optionsTab = await chrome.tabs.create({ url: optionsUrl, active: true });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await chrome.tabs.get(optionsTab.id);
        if (current.url === optionsUrl && current.status === 'complete') break;
        if (attempt === 99) throw new Error('Firefox options page did not finish loading');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const prepared = await globalThis.browserRecallPreparedPopupForTest.prepare({ tabId: optionsTab.id });
      const snapshots = {};
      for (const [phase, popupPath] of [['prepared', prepared.popupPath], ['direct', 'popup.html']]) {
        const ready = new Promise(resolve => popupWaiters.set(phase, resolve));
        const popupUrl = new URL(chrome.runtime.getURL(popupPath));
        popupUrl.searchParams.set('firefoxProbe', phase);
        const popupTab = await chrome.tabs.create({ url: popupUrl.href, active: false });
        snapshots[phase] = await ready;
        popupWaiters.delete(phase);
        await chrome.tabs.remove(popupTab.id);
      }
      await chrome.tabs.remove(optionsTab.id);
      return { preparedMode: prepared.mode, expectedTitle: chrome.i18n.getMessage('extensionNotAvailablePage'), ...snapshots };
    }
    if (request.phase === 'refreshDormant') {
      await chrome.tabs.reload(request.tabId);
      return { success: true };
    }
    let tabId = request.tabId ?? sender.tab.id;
    if (request.phase === 'openDormant') {
      const tab = await chrome.tabs.create({ url: 'http://127.0.0.1:${port}/paused' });
      await dormantReady;
      tabId = tab.id;
    }
    let lastError;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const identity = await chrome.tabs.sendMessage(tabId, { action: 'getPageIdentity' }, { frameId: 0 });
        const tab = await chrome.tabs.get(tabId);
        if (identity?.success && identity.url === tab.url) return { identity, ...(request.phase === 'openDormant' ? { tabId } : {}) };
        lastError = 'Production content receiver did not acknowledge delivery: ' + JSON.stringify({ identity });
      } catch (error) {
        lastError = error.message;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { error: lastError };
  })();
});\n`,
  );
  fs.writeFileSync(
    path.join(extensionDir, 'firefox-real-popup-probe.js'),
    `(async () => {
const phase = new URL(location.href).searchParams.get('firefoxProbe');
if (!phase) return;
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (document.documentElement.dataset.popupHidden === undefined) {
    await chrome.runtime.sendMessage({ action: 'firefoxOptionsPopupReady', phase, snapshot: {
      title: document.getElementById('pageDiagnosticTitle').textContent,
      message: document.getElementById('pageDiagnosticMessage').textContent,
      detail: document.getElementById('pageDiagnosticDetail').textContent,
      pageActionsVisible: ['visitsLikesSection', 'listSection', 'notesSection', 'snapshotSection'].some(id => getComputedStyle(document.getElementById(id)).display !== 'none'),
    } });
    return;
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
})();\n`,
  );
  const popupPath = path.join(extensionDir, 'popup.html');
  fs.writeFileSync(
    popupPath,
    fs
      .readFileSync(popupPath, 'utf8')
      .replace(
        '</body>',
        '<script src="firefox-real-popup-probe.js"></script></body>',
      ),
  );
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(
    path.join(extensionDir, 'firefox-real-diagnostics.js'),
    `globalThis.firefoxRealContentErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  globalThis.firefoxRealContentErrors.push(args.map(value => String(value?.message || value) + ' ' + String(value?.stack || '')).join(' '));
  originalConsoleError(...args);
};\n`,
  );
  manifest.content_scripts
    .find((script) => script.js.includes('content.js'))
    .js.unshift('firefox-real-diagnostics.js');
  manifest.background.scripts.push('firefox-real-background-probe.js');
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
  firefox = spawn(
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
      initialUrl,
      '--arg=-headless',
      '--no-input',
      '--no-config-discovery',
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
    if (code !== 0)
      reportReject(new Error(`Firefox exited with status ${code}`));
  });

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
        40_000,
      );
    }),
  ]);
  assert.equal(result.error, undefined, JSON.stringify(result));
  for (const [phase, url] of [
    ['initial', initialUrl],
    ['destination', destinationUrl],
    ['recovered', pausedUrl],
  ]) {
    assert.deepEqual(
      result[phase]?.identity,
      {
        success: true,
        embedded: false,
        url,
        slug: generateSlugFromUrl(url),
        recordingEligible: true,
      },
      JSON.stringify(result),
    );
  }
  assert.equal(
    result.dormant?.identity?.recordingEligible,
    false,
    JSON.stringify(result),
  );
  assert.deepEqual(result.contentErrors, [], JSON.stringify(result));
  assert.equal(
    result.options?.preparedMode,
    'unavailable',
    JSON.stringify(result),
  );
  for (const phase of ['prepared', 'direct']) {
    assert.deepEqual(
      result.options[phase],
      {
        title: result.options.expectedTitle,
        message: '',
        detail: '',
        pageActionsVisible: false,
      },
      JSON.stringify(result.options),
    );
  }
  // Graceful daemon shutdown flushes accepted visits before reading the logs.
  await stopTestDaemon(daemon);
  const records = readVisitRecords(configDir);
  for (const url of [initialUrl, destinationUrl, pausedUrl]) {
    assert(
      records.some(
        (record) =>
          record.action === 'visit_page' &&
          record.url === canonicalizePageUrl(url),
      ),
      'Firefox did not persist the visit: ' + url,
    );
  }
  console.log(
    'Real Firefox verified page capture, navigation, URL normalization, daemon persistence, paused-document exclusion until refresh, and options-page popup messages.',
  );
} finally {
  clearTimeout(timeout);
  // Every allocation, including staging and daemon startup, is inside this boundary.
  const cleanup = await Promise.allSettled([
    (async () => {
      if (!firefox || firefox.exitCode !== null || firefox.signalCode !== null)
        return;
      const exited = new Promise((resolve) => firefox.once('exit', resolve));
      firefox.kill('SIGTERM');
      const force = setTimeout(() => firefox.kill('SIGKILL'), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    })(),
    stopTestDaemon(daemon),
    ...[server, portReservation]
      .filter((entry) => entry?.listening)
      .map(
        (entry) =>
          new Promise((resolve, reject) =>
            entry.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  ]);
  cleanupStagedAssets(extensionDir);
  if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  const failures = cleanup.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Firefox check cleanup failed',
    );
}
