#!/usr/bin/env node
// Native Tauri captures backed by the real daemon; the hero combines both schemes.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { buildManualSeedFiles } from './lib/manual-seed.mjs';
import { documentationSeed } from './lib/documentation-seed.mjs';
import { composeDocumentationHero } from './compose-documentation-hero.mjs';
import {
  captureInputs,
  assertCaptureInputs,
} from './lib/documentation-freshness.mjs';
import { documentationCaptureSpec } from './lib/documentation-image-spec.mjs';
import {
  launchTestDaemon,
  waitForDaemonListening,
  stopTestDaemon,
} from '../tests/integration/daemon-test-harness.js';

if (process.platform !== 'darwin') {
  throw new Error(
    'Documentation screenshots require macOS, Accessibility, and Screen Recording permission.',
  );
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const inputs = captureInputs(root, 'desktop');
const work = realpathSync(
  mkdtempSync(path.join(tmpdir(), 'browser-recall-documentation-')),
);
const profile = path.join(work, 'profile');
const output = path.join(work, 'images');
const app = path.join(work, 'Browser Recall Documentation.app');
const helper = path.join(work, 'documentation-window');
let daemon;
let pid;
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    ...options,
  }).trim();
const native = (...args) => run(helper, [String(pid), ...args]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function build(command, args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`Build failed: ${signal || code}`)),
    );
  });
}

async function waitFor(description, check) {
  const deadline = Date.now() + 15000;
  let lastError;
  do {
    try {
      const result = check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await setTimeout(200);
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out: ${description}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function capture(name, includes, outputPixels, excludes = []) {
  const ready = () => {
    const tree = native('dump');
    return (
      includes.every((text) => tree.includes(text)) &&
      excludes.every((text) => !tree.includes(text))
    );
  };
  await waitFor(`${name} content`, ready);
  native('unfocus');
  // Wait for actual pixels to settle, including native navigation transitions.
  let previous;
  let stable = 0;
  const filename = path.join(output, `${name}.png`);
  await waitFor(`${name} paint`, () => {
    // Output pixels are not source pixels. The shared ScreenCaptureKit helper
    // uses the host window's backing scale and display color profile; a 1×
    // virtual display can yield an upscaled, softer 2× PNG. Native font and
    // browser rendering can also vary by OS, so these files are not suitable
    // for byte-for-byte comparison across different machines.
    native(
      'capture',
      filename,
      String(outputPixels.width),
      String(outputPixels.height),
    );
    const current = hash(readFileSync(filename));
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    return stable >= 3;
  });
  if (!ready()) throw new Error(`${name} changed during capture`);
  const bytes = readFileSync(filename);
  console.log(
    `Captured ${name}: ${bytes.readUInt32BE(16)} × ${bytes.readUInt32BE(20)}`,
  );
}

try {
  // A distinct compiled identifier isolates Tauri's single-instance socket too.
  await build('npm', ['run', 'build:desktop-ui']);
  await build('npm', ['run', 'build:test-daemon']);
  await build(
    process.execPath,
    [
      path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
      'build',
      '--bundles',
      'app',
      '--config',
      JSON.stringify({
        identifier: 'app.browser-recall.documentation',
        productName: 'Browser Recall Documentation',
        // Only this isolated documentation build permits a compact Timeline.
        app: {
          windows: JSON.parse(
            readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'),
          ).app.windows.map((window) => ({ ...window, minHeight: 500 })),
        },
      }),
    ],
    path.join(root, 'apps/desktop'),
  );

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const configDir = path.join(profile, 'daemon');
  daemon = launchTestDaemon(configDir, { ports: [port] });
  await waitForDaemonListening(daemon);
  // SIGINT follows the daemon's graceful shutdown path and flushes settings.
  await new Promise((resolve, reject) => {
    daemon.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Seed daemon exited ${code}`)),
    );
    daemon.kill('SIGINT');
  });
  const configPath = path.join(configDir, 'config.json');
  const config = JSON.parse(readFileSync(configPath));
  const currentSettings = JSON.parse(
    readFileSync(path.join(config.data_dir, 'views/manifest/settings.json')),
  );
  const { events, ...options } = documentationSeed();
  const files = await buildManualSeedFiles(events, {
    currentSettings,
    ...options,
  });
  // Replace only the temporary daemon's data, after all writes have flushed.
  if (!config.data_dir.startsWith(profile + path.sep))
    throw new Error('Seed data escaped the isolated profile');
  rmSync(config.data_dir, { recursive: true });
  for (const dir of ['logs', 'objects', 'views'])
    mkdirSync(path.join(config.data_dir, dir), { recursive: true });
  for (const file of files) {
    const destination = path.join(config.data_dir, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      file.lines
        ? file.lines.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        : JSON.stringify(file.data),
    );
  }
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      device_id: options.deviceId,
      launch_at_login: false,
    }),
  );
  cpSync(
    path.join(
      root,
      'target/release/bundle/macos/Browser Recall Documentation.app',
    ),
    app,
    { recursive: true },
  );
  // System Events resolves process references by name after a PID lookup.
  // Give the capture process its own name so the user's app cannot receive input.
  renameSync(
    path.join(app, 'Contents/MacOS/browser-recall-desktop'),
    path.join(app, 'Contents/MacOS/browser-recall-documentation'),
  );
  // Keep OS URL routing with the user's installed application.
  run('/usr/libexec/PlistBuddy', [
    '-c',
    'Set :CFBundleExecutable browser-recall-documentation',
    '-c',
    'Delete :CFBundleURLTypes',
    path.join(app, 'Contents/Info.plist'),
  ]);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);
  run('/usr/bin/swiftc', [
    '-suppress-warnings',
    '-target',
    `${arch}-apple-macos14.0`,
    path.join(root, 'scripts/lib/documentation-window.swift'),
    '-o',
    helper,
  ]);
  mkdirSync(output);
  run('/usr/bin/open', [
    '-n',
    '-F',
    '--env',
    `BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR=${profile}`,
    '--env',
    'BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION=1',
    '--env',
    'BROWSER_RECALL_SKIP_LOGIN_ITEM_REGISTRATION=1',
    '--env',
    `BROWSER_RECALL_PORTS=${port}`,
    app,
  ]);
  pid = Number(
    await waitFor('documentation app launch', () => run(helper, ['pid', app])),
  );
  await waitFor('documentation window', () =>
    native('dump').includes('AXWindow'),
  );
  const names = [];
  for (const scheme of ['amber', 'mono']) {
    if (scheme === 'mono') {
      native('click', 'settingsBtn');
      await waitFor('color scheme picker', () =>
        native('dump').includes('Mono'),
      );
      native('click', 'Mono');
      await waitFor(
        'persisted mono scheme',
        () =>
          JSON.parse(
            readFileSync(
              path.join(config.data_dir, 'views/manifest/settings.json'),
            ),
          ).colorScheme === 'mono',
      );
      native('click', 'settingsClose');
      await waitFor(
        'settings closed',
        () => !native('dump').includes('settingsClose'),
      );
      native('click', 'exploreBtn');
      await waitFor('Timeline search control', () =>
        native('dump').includes('searchDraftInput'),
      );
      if (native('dump').includes('searchDraftClearBtn'))
        native('click', 'searchDraftClearBtn');
    }
    const name = (view) => {
      const filename = scheme === 'amber' ? view : `${view}-mono`;
      names.push(filename);
      return filename;
    };
    const timelineSpec = documentationCaptureSpec.desktop.timeline;
    native(
      'frame',
      String(timelineSpec.layoutPoints.width),
      String(timelineSpec.layoutPoints.height),
    );
    const labeledPages = [
      'A smaller, slower web',
      'Why I still keep a personal website',
    ];
    await capture(
      name('timeline'),
      [...labeledPages, 'exploreBtn'],
      timelineSpec.outputPixels,
    );
    for (const title of labeledPages) {
      if (native('visible-text', title) !== 'true')
        throw new Error(`${scheme} Timeline clips labeled page ${title}`);
    }
    if (scheme === 'mono') continue;
    const bookSpec = documentationCaptureSpec.desktop.book;
    native(
      'frame',
      String(bookSpec.layoutPoints.width),
      String(bookSpec.layoutPoints.height),
    );
    native('click', 'highlightsHistoryBtn');
    await capture(
      name('book'),
      [
        '260916',
        '260915',
        '260913',
        'A personal website can be a place',
        'Leave the unfinished bits in.',
        'This is what bothered me',
        'The pages I return to rarely',
        'We notice care in the small decisions.',
        'Reading an old notebook is a conversation',
        'Some ideas need to be met twice.',
      ],
      bookSpec.outputPixels,
      ['searchDraftInput'],
    );
    for (const text of ['Leave the unfinished bits in.', 'matters to them.']) {
      if (native('visible-text', text) !== 'true')
        throw new Error(`${scheme} Book clips ${text}`);
    }
  }

  const screenshots = Object.fromEntries(
    names.map((name) => {
      const bytes = readFileSync(path.join(output, `${name}.png`));
      return [
        `${name}.png`,
        {
          sha256: hash(bytes),
          width: bytes.readUInt32BE(16),
          height: bytes.readUInt32BE(20),
        },
      ];
    }),
  );
  screenshots['timeline-styles.png'] = await composeDocumentationHero(output);
  assertCaptureInputs(root, 'desktop', inputs);
  writeFileSync(
    path.join(output, 'capture.json'),
    await format(
      JSON.stringify({
        command: 'npm run docs:screenshots',
        inputs,
        platform: 'macOS / native Tauri WKWebView',
        seedSha256: hash(
          readFileSync(path.join(root, 'scripts/lib/documentation-seed.mjs')),
        ),
        colorSchemes: ['amber', 'mono'],
        layoutPoints: {
          timeline: documentationCaptureSpec.desktop.timeline.layoutPoints,
          book: documentationCaptureSpec.desktop.book.layoutPoints,
        },
        outputPixels: {
          timeline: documentationCaptureSpec.desktop.timeline.outputPixels,
          book: documentationCaptureSpec.desktop.book.outputPixels,
        },
        screenshots,
      }),
      { parser: 'json' },
    ),
  );
  mkdirSync(path.join(root, 'docs/images'), { recursive: true });
  // Publish the complete set only after every state has passed inspection.
  for (const name of [...Object.keys(screenshots), 'capture.json']) {
    const destination = path.join(root, 'docs/images', name);
    cpSync(path.join(output, name), `${destination}.tmp`);
    renameSync(`${destination}.tmp`, destination);
  }
  console.log('Documentation screenshots saved to docs/images/');
} catch (error) {
  if (pid) {
    const failureDir = path.join(root, 'test-results/documentation');
    mkdirSync(failureDir, { recursive: true });
    try {
      writeFileSync(path.join(failureDir, 'accessibility.txt'), native('dump'));
      native(
        'capture',
        path.join(failureDir, 'failure.png'),
        String(documentationCaptureSpec.desktop.timeline.outputPixels.width),
        String(documentationCaptureSpec.desktop.timeline.outputPixels.height),
      );
    } catch (captureError) {
      console.error(captureError.message);
    }
  }
  throw error;
} finally {
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  await stopTestDaemon(daemon);
  const unregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  try {
    run(unregister, ['-u', app]);
  } catch (error) {
    console.error(`Could not unregister documentation app: ${error.message}`);
  }
  rmSync(work, { recursive: true, force: true });
}
