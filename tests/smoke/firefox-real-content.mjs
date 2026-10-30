import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
import { stopFirefoxProcess } from './firefox-process.mjs';
import { installPopupStartupFailure } from '../fixtures/popup-startup-failure.mjs';
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
  installPopupStartupFailure(extensionDir);
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
  if (location.pathname === '/popup-sizing') {
    await chrome.runtime.sendMessage({action:'firefoxSizingReady'});
    return;
  }
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
  const pauseSizing = await chrome.runtime.sendMessage({action:'setRecordingPaused', paused:true});
  if (!pauseSizing?.success) throw new Error(pauseSizing?.error || 'Could not pause the sizing document');
  const sizing = await chrome.runtime.sendMessage({action:'firefoxRealContentProbe', phase:'openSizing'});
  const resumeSizing = await chrome.runtime.sendMessage({action:'setRecordingPaused', paused:false});
  if (!resumeSizing?.success) throw new Error(resumeSizing?.error || 'Could not resume the sizing document');
  const nativePopups = await chrome.runtime.sendMessage({action:'firefoxRealContentProbe', phase:'native-popups', tabId:sizing.tabId});
  await report({ initial, destination, dormant, excluded, recovered, options, nativePopups, contentErrors: globalThis.firefoxRealContentErrors });
} catch (error) {
  await report({ error: error.message, contentErrors: globalThis.firefoxRealContentErrors });
}
})();\n`,
  );
  fs.writeFileSync(
    path.join(extensionDir, 'firefox-real-background-probe.js'),
    `globalThis.browserRecallBackgroundTestActions = new Set(['firefoxRealContentProbe', 'firefoxDormantReady', 'firefoxPopupReady', 'firefoxSizingReady']);
let resolveDormant;
const dormantReady = new Promise(resolve => { resolveDormant = resolve; });
let resolveSizing;
const sizingReady = new Promise(resolve => { resolveSizing = resolve; });
const popupWaiters = new Map();
chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.action === 'firefoxDormantReady') { resolveDormant(); return Promise.resolve({ success: true }); }
  if (request.action === 'firefoxSizingReady') { resolveSizing(); return Promise.resolve({success:true}); }
  if (request.action === 'firefoxPopupReady') { popupWaiters.get(request.phase)?.(request.snapshot); return Promise.resolve({ success: true }); }
  if (request.action !== 'firefoxRealContentProbe') return false;
  return (async () => {
    if (request.phase === 'openSizing') {
      const tab = await chrome.tabs.create({url:'http://127.0.0.1:${port}/popup-sizing', active:true});
      await sizingReady;
      return {tabId:tab.id};
    }
    if (request.phase === 'native-popups') {
      const tab = await chrome.tabs.get(request.tabId);
      const prepared = await globalThis.browserRecallPreparedPopupForTest.prepare({tabId:tab.id});
      const results = {};
      for (const [phase, popupPath] of [['sizing',prepared.popupPath], ['fatal-short','popup.html?startupFailure=short'], ['fatal-long','popup.html?startupFailure=long']]) {
        const ready = new Promise(resolve => popupWaiters.set(phase, resolve));
        const popupUrl = new URL(chrome.runtime.getURL(popupPath));
        popupUrl.searchParams.set('firefoxProbe',phase);
        await chrome.tabs.update(tab.id,{active:true});
        await chrome.windows.update(tab.windowId,{focused:true});
        await chrome.action.setPopup({tabId:tab.id,popup:popupUrl.href});
        await chrome.action.openPopup({windowId:tab.windowId});
        results[phase] = await ready;
        popupWaiters.delete(phase);
        for (let attempt = 0; chrome.extension.getViews({type:'popup'}).length; attempt++) {
          if (attempt === 100) throw new Error('Firefox popup did not close');
          await new Promise(resolve => setTimeout(resolve,20));
        }
      }
      await chrome.tabs.remove(tab.id);
      return results;
    }
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
const native = phase === 'sizing' || phase.startsWith('fatal-');
const wait = async (name, read) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  throw new Error('Firefox popup timed out: ' + name);
};
if (native) {
  let snapshot;
  try {
    await wait('reveal', () => !document.documentElement.hasAttribute('data-popup-hidden'));
    await document.fonts.ready;
    if (phase === 'sizing') {
      const layout = () => {
        const frame = document.getElementById('dashboard').getBoundingClientRect();
        return {height:innerHeight,width:innerWidth,bottom:frame.bottom,right:frame.right,count:document.querySelectorAll('#listChips .list-chip').length};
      };
      const fitted = count => {
        const size = layout();
        globalThis.lastPopupLayout = size;
        return (count === undefined || size.count === count) && Math.abs(size.height-size.bottom) < 1.1 && Math.abs(size.width-size.right) < 1.1 ? size : null;
      };
      const small = await wait('small frame',()=>fitted());
      const ids = [];
      for (let index = 0; index < 12; index++) {
        const saved = await chrome.runtime.sendMessage({action:'saveListMeta',name:'Live reading '+index});
        if (!saved.success) throw new Error(saved.error);
        ids.push(saved.listId);
      }
      const large = await wait('grown frame',()=>{ const size=fitted(10); return size && size.height > small.height+50 ? size : null; });
      for (const listId of ids) {
        const deleted = await chrome.runtime.sendMessage({action:'deleteList',listId});
        if (!deleted.success) throw new Error(deleted.error);
      }
      const restored = await wait('shrunk frame',()=>{const size=fitted(small.count); return size && size.height === small.height ? size : null;});
      snapshot = {small,large,restored};
    } else {
      const reload = document.getElementById('fatalReloadBtn');
      await wait('reload',()=>reload?.getBoundingClientRect().height);
      const title = reload.parentElement.firstElementChild.getBoundingClientRect();
      const message = reload.previousElementSibling;
      const button = reload.getBoundingClientRect();
      if (title.top < 0 || button.bottom > innerHeight || button.right > innerWidth) throw new Error('Fatal error controls are clipped');
      if (document.documentElement.scrollWidth > innerWidth) throw new Error('Fatal error overflows horizontally');
      if (getComputedStyle(document.getElementById('dashboard')).display !== 'none') throw new Error('Fatal error did not replace the dashboard');
      const scrollable = message.scrollHeight > message.clientHeight;
      if (scrollable !== (phase === 'fatal-long')) throw new Error('Fatal message scrolling is incorrect');
      snapshot = {height:innerHeight,reloadBottom:button.bottom,scrollable,calls:globalThis.popupStartupFailureCalls};
    }
  } catch(error) { snapshot = {error:error.message,layout:globalThis.lastPopupLayout}; }
  await chrome.runtime.sendMessage({action:'firefoxPopupReady',phase,snapshot});
  window.close();
  return;
}
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (document.documentElement.dataset.popupHidden === undefined) {
    await chrome.runtime.sendMessage({ action: 'firefoxPopupReady', phase, snapshot: {
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
    {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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
  for (const phase of ['sizing', 'fatal-short', 'fatal-long']) {
    assert.equal(
      result.nativePopups?.[phase]?.error,
      undefined,
      JSON.stringify(result.nativePopups),
    );
    assert(
      result.nativePopups?.[phase],
      'Missing native Firefox popup result: ' + phase,
    );
  }
  assert(
    result.nativePopups.sizing.small.height < 320,
    JSON.stringify(result.nativePopups),
  );
  assert(
    result.nativePopups.sizing.large.height >
      result.nativePopups.sizing.small.height + 50,
  );
  assert.equal(
    result.nativePopups.sizing.restored.height,
    result.nativePopups.sizing.small.height,
  );
  for (const phase of ['fatal-short', 'fatal-long'])
    assert.equal(result.nativePopups[phase].calls, 1);
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
} finally {
  clearTimeout(timeout);
  // Every allocation, including staging and daemon startup, is inside this boundary.
  const cleanup = await Promise.allSettled([
    stopFirefoxProcess(firefox),
    stopTestDaemon(daemon),
    ...[server, portReservation]
      .filter((entry) => entry?.listening)
      .map(
        (entry) =>
          new Promise((resolve, reject) => {
            entry.close((error) => (error ? reject(error) : resolve()));
            // A browser request must not hold cleanup open after the probe.
            entry.closeAllConnections?.();
          }),
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
console.log(
  'Real Firefox verified page capture, navigation, URL normalization, daemon persistence, paused-document exclusion until refresh, options-page messages, native popup growth and shrinkage, and fatal-error controls; process cleanup completed.',
);
