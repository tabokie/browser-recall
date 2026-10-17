import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { CONNECTOR_PROTOCOL_VERSION } from '../../apps/extension/connector/pairing.js';
import { readProductVersion } from '../../scripts/lib/product-version.mjs';
import { finalizeMacosAppBundle } from '../../scripts/finalize-macos-app-bundle.mjs';
import { compileDocumentationWindow } from '../../scripts/lib/documentation-native-capture.mjs';
import { unregisterMacosTestApp } from './macos-desktop-process.mjs';
import { isolatedDesktopEnvironment } from './windows-desktop-test-profile.mjs';
import { removeTestProfile } from './windows-desktop-process.mjs';
import { requireIsolatedMacosSession } from '../../scripts/lib/macos-native-session.mjs';
import { frameNativeUpdateWindow } from './native-update-window.mjs';
import { verifyWindowsInstalledExecutable } from '../../scripts/verify-windows-installed-executable.mjs';

if (!['darwin', 'win32'].includes(process.platform))
  throw new Error('Native update lifecycle requires macOS or Windows');
requireIsolatedMacosSession();
if (
  process.platform === 'win32' &&
  process.env.BROWSER_RECALL_ISOLATED_WINDOWS_SESSION !== '1'
)
  throw new Error(
    'Run native Windows installer tests in a disposable session with BROWSER_RECALL_ISOLATED_WINDOWS_SESSION=1',
  );
const root = path.resolve(import.meta.dirname, '../..');
const version = readProductVersion(root);
const platform = process.platform === 'darwin' ? 'macos' : 'windows';
const suffix =
  process.platform === 'darwin'
    ? `macos-${process.arch}.app.tar.gz`
    : 'windows-x64-setup.exe';
const packagePath = path.join(
  root,
  'release-assets',
  `browser-recall-v${version}-${suffix}`,
);
assert(
  existsSync(packagePath),
  'Build the signed release package before testing native updates',
);
const directory = path.join(root, 'test-results/native-update');
mkdirSync(directory, { recursive: true });
const work = mkdtempSync(path.join(directory, `${platform}-`));
const profile = path.join(work, 'profile');
const data = path.join(work, 'collection');
const installed = path.join(work, 'installed');
const app = path.join(installed, 'Browser Recall.app');
const executable =
  process.platform === 'darwin'
    ? path.join(app, 'Contents/MacOS/browser-recall-desktop')
    : path.join(installed, 'browser-recall-desktop.exe');
let helper;
let pid;
let child;
let socket;
let windowsInstalled = false;
let downloads = 0;
let manifests = 0;
const server = http.createServer((request, response) => {
  if (request.url === '/latest.json') {
    manifests++;
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        version,
        url: `http://127.0.0.1:${server.address().port}/package`,
        signature: readFileSync(`${packagePath}.sig`, 'utf8').trim(),
      }),
    );
  } else if (request.url === '/package') {
    downloads++;
    createReadStream(packagePath).pipe(response);
  } else {
    response.writeHead(404);
    response.end();
  }
});
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  }).trim();
async function waitFor(description, check, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${description}: ${lastError?.message || 'timed out'}`);
}
async function execute(command, args, options = {}) {
  const task = spawn(command, args, { stdio: 'inherit', ...options });
  const [code, signal] = await once(task, 'exit');
  assert.equal(code, 0, `${command} failed: ${signal || code}`);
}
function runningPid() {
  if (process.platform === 'darwin') return Number(run(helper, ['pid', app]));
  return Number(
    run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:BROWSER_RECALL_UPDATE_EXE } | Select-Object -First 1).ProcessId',
      ],
      { env: { ...process.env, BROWSER_RECALL_UPDATE_EXE: executable } },
    ),
  );
}
function ui(action, label = '') {
  if (process.platform === 'darwin')
    return run(helper, [String(pid), action, ...(label ? [label] : [])]);
  return run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(root, 'tests/smoke/windows-desktop-update-ui.ps1'),
    ],
    {
      env: {
        ...process.env,
        BROWSER_RECALL_UPDATE_PID: String(pid),
        BROWSER_RECALL_UPDATE_UI_ACTION: action,
        BROWSER_RECALL_UPDATE_UI_LABEL: label,
      },
    },
  );
}
function request(connection, message, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`No ${type} response`)),
      5000,
    );
    const onMessage = (bytes) => {
      const response = JSON.parse(bytes);
      if (response.type === 'error' || response.type === 'auth_fail')
        finish(new Error(JSON.stringify(response)));
      else if (response.type === type) finish(null, response);
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error(`Connector closed before ${type}`));
    const finish = (error, result) => {
      clearTimeout(timer);
      connection.off('message', onMessage);
      connection.off('error', onError);
      connection.off('close', onClose);
      if (error) reject(error);
      else resolve(result);
    };
    connection.on('message', onMessage);
    connection.once('error', onError);
    connection.once('close', onClose);
    connection.send(JSON.stringify(message));
  });
}
async function connect(port) {
  const connection = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
  });
  connection.on('error', () => {});
  try {
    await once(connection, 'open');
    await request(
      connection,
      {
        type: 'auth',
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        token: 'native-upgrade-test-token',
        browserName: 'Chrome',
      },
      'auth_ok',
    );
    return connection;
  } catch (error) {
    connection.terminate();
    throw error;
  }
}
async function command(action, fields) {
  const result = await request(
    socket,
    { type: 'run_command', action, request: fields },
    'command_result',
  );
  assert.equal(result.success, true, result.error);
  return result.response;
}
try {
  // Never shut down a user's Browser Recall process to make room for this test.
  if (process.platform === 'darwin') {
    const processes = run('/bin/ps', ['-axo', 'comm=']);
    assert(
      !processes
        .split('\n')
        .some((line) => line.trim().endsWith('/browser-recall-desktop')),
      'Quit Browser Recall before running the isolated native upgrade test',
    );
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fixture = path.join(work, 'old-version.json');
  writeFileSync(
    fixture,
    JSON.stringify({
      version: '0.0.1',
      plugins: {
        updater: {
          endpoints: [`http://127.0.0.1:${server.address().port}/latest.json`],
          dangerousInsecureTransportProtocol: true,
        },
      },
    }),
  );
  await execute(
    process.execPath,
    [
      path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
      'build',
      '--bundles',
      process.platform === 'darwin' ? 'app' : 'nsis',
      '--config',
      fixture,
    ],
    { cwd: path.join(root, 'apps/desktop') },
  );
  mkdirSync(installed);
  if (process.platform === 'darwin') {
    const source = path.join(
      root,
      'target/release/bundle/macos/Browser Recall.app',
    );
    finalizeMacosAppBundle(source);
    cpSync(source, app, { recursive: true });
    helper = compileDocumentationWindow(work);
  } else {
    const installer = path.join(
      root,
      'target/release/bundle/nsis/Browser Recall_0.0.1_x64-setup.exe',
    );
    await execute(installer, ['/S', `/D=${installed}`]);
    windowsInstalled = true;
  }
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  mkdirSync(path.join(profile, 'daemon'), { recursive: true });
  mkdirSync(data);
  const connector = {
    browser_id: 'chrome',
    browser_name: 'Chrome',
    extension_id: 'abcdefghijklmnopabcdefghijklmnop',
    browser_profile: null,
    token: 'native-upgrade-test-token',
    approved_at: 1,
    last_seen_at: null,
  };
  writeFileSync(
    path.join(profile, 'daemon/config.json'),
    JSON.stringify({
      device_id: 'native-upgrade-test',
      data_dir: data,
      last_port: port,
      launch_at_login: false,
      log_level: 'info',
      setup_complete: true,
      connectors: [connector],
      sync_github_token: null,
      sync_github_user: null,
      sync_remember_token: true,
      sync_paused_devices: [],
      sync_devices: {},
    }),
  );
  const environment = {
    ...isolatedDesktopEnvironment(process.env, profile),
    BROWSER_RECALL_PORTS: String(port),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--force-renderer-accessibility',
  };
  const log = path.join(directory, `${platform}-application.log`);
  child = spawn(executable, [], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes) => {
      output += bytes;
      writeFileSync(log, output);
    });
  pid = await waitFor('Old Browser Recall process', runningPid);
  if (process.platform === 'darwin') {
    await frameNativeUpdateWindow(helper, pid);
  }
  socket = await waitFor('Old daemon authentication', () => connect(port));
  await command('saveSettingsKey', { key: 'localeOverride', value: 'en' });
  await command('saveSettingsKey', { key: 'colorScheme', value: 'mono' });
  const note = await command('createNote', {
    url: 'https://native-upgrade.example/persisted',
    title: 'Native update',
    excerpt: ['retained across update'],
    cssPath: ['main > p'],
    note: 'before update',
  });
  await waitFor(
    'Settings button',
    () =>
      ui('click', process.platform === 'darwin' ? 'settingsBtn' : 'Settings') ||
      true,
  );
  await waitFor('Old version in Settings', () => ui('dump').includes('0.0.1'));
  assert.equal(manifests, 0, 'Isolated profiles must not check automatically');
  await waitFor(
    'Manual update check',
    () => ui('click', 'Check for updates') || true,
  );
  await waitFor('Update available', () =>
    ui('dump').includes(`Update available (${version})`),
  );
  assert.equal(downloads, 0, 'Checking must never download or install');
  // Leave a connector session open and accept another write immediately before installation.
  const edited = await command('updateNote', {
    noteSlug: note.noteSlug,
    note: 'accepted immediately before installation',
  });
  assert.equal(typeof edited.noteSlug, 'string');
  assert.notEqual(edited.noteSlug, note.noteSlug);
  const oldPid = pid;
  let disconnected = false;
  socket.once('close', () => {
    disconnected = true;
  });
  // The Settings modal hides the toolbar notice, and the versioned status is
  // not an actionable control. Press the actual install button directly.
  await waitFor(
    'Update and restart button',
    () => ui('click', 'Update and restart') || true,
  );
  await waitFor('Connector shutdown', () => disconnected);
  await waitFor(
    'Native relaunch',
    () => {
      const candidate = runningPid();
      return candidate && candidate !== oldPid && candidate;
    },
    90000,
  ).then((value) => {
    pid = value;
  });
  await waitFor(
    'Relaunched Settings button',
    () =>
      ui('click', process.platform === 'darwin' ? 'settingsBtn' : 'Settings') ||
      true,
  );
  await waitFor('Installed product version', () =>
    ui('dump').includes(version),
  );
  if (process.platform === 'darwin')
    assert.equal(
      run('/usr/libexec/PlistBuddy', [
        '-c',
        'Print CFBundleShortVersionString',
        path.join(app, 'Contents/Info.plist'),
      ]),
      version,
    );
  else verifyWindowsInstalledExecutable(packagePath, executable);
  socket = await waitFor('Connector reconnect using retained token', () =>
    connect(port),
  );
  const settings = await request(
    socket,
    { type: 'get_settings' },
    'settings_result',
  );
  assert.equal(settings.success, true);
  assert.equal(settings.settings.colorScheme, 'mono');
  const stored = JSON.parse(
    readFileSync(path.join(data, 'objects/notes', `${edited.noteSlug}.json`)),
  );
  assert.equal(stored.note, 'accepted immediately before installation');
  await command('updateNote', {
    noteSlug: edited.noteSlug,
    note: 'written after reconnect',
  });
  const config = JSON.parse(
    readFileSync(path.join(profile, 'daemon/config.json')),
  );
  assert.equal(config.data_dir, data);
  assert.equal(config.device_id, 'native-upgrade-test');
  assert.equal(config.connectors[0].token, connector.token);
  assert.equal(downloads, 1);
  console.log(
    `Native ${platform} update: 0.0.1 → ${version}, relaunch, retained data/settings/pairing, and connector writes verified.`,
  );
} finally {
  socket?.terminate();
  if (existsSync(path.join(profile, 'logs'))) {
    cpSync(
      path.join(profile, 'logs'),
      path.join(directory, `${platform}-logs`),
      { recursive: true },
    );
  }
  if (pid) {
    try {
      writeFileSync(path.join(directory, `${platform}-ui.txt`), ui('dump'));
    } catch {
      /* The test process may already have exited. */
    }
    if (process.platform === 'win32') {
      try {
        run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
      } catch (error) {
        if (runningPid() === pid) throw error;
      }
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await waitFor('Test process cleanup', () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code === 'ESRCH') return true;
        throw error;
      }
    });
  }
  if (process.platform === 'darwin') unregisterMacosTestApp(app);
  if (windowsInstalled)
    await execute(path.join(installed, 'uninstall.exe'), ['/S']);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (process.platform === 'win32') await removeTestProfile(work);
  else rmSync(work, { recursive: true, force: true });
}
