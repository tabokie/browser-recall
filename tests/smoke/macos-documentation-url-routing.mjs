import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileDocumentationWindow } from '../../scripts/lib/documentation-native-capture.mjs';
import { buildAndRegisterMacosDocumentationApp } from './macos-documentation-app.mjs';
import { withCleanup } from './desktop-test-cleanup.mjs';
import { unregisterMacosTestApp } from './macos-desktop-process.mjs';

if (process.platform !== 'darwin') {
  console.log('macOS documentation URL routing check skipped');
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, '../..');
const app = path.join(
  root,
  'target/release/bundle/macos/Browser Recall Documentation.app',
);
const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-url-routing-'));
const testApp = path.join(work, 'Browser Recall URL Test.app');
let pid;
await withCleanup(async () => {
  const helper = compileDocumentationWindow(work);
  const handler = () =>
    execFileSync(helper, ['url-handler', 'browser-recall://open'], {
      encoding: 'utf8',
    }).trim();
  const previousHandler = await buildAndRegisterMacosDocumentationApp({
    app,
    readHandler: handler,
    build: () =>
      new Promise((resolve, reject) => {
        const build = spawn(
          process.execPath,
          [
            path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
            'build',
            '--bundles',
            'app',
            '--config',
            path.join(root, 'scripts/documentation-tauri.conf.json'),
          ],
          { cwd: path.join(root, 'apps/desktop'), stdio: 'inherit' },
        );
        build.once('error', reject);
        build.once('exit', (code, signal) =>
          code === 0
            ? resolve()
            : reject(
                new Error(`Documentation build failed: ${signal || code}`),
              ),
        );
      }),
  });
  cpSync(app, testApp, { recursive: true });
  renameSync(
    path.join(testApp, 'Contents/MacOS/browser-recall-desktop'),
    path.join(testApp, 'Contents/MacOS/browser-recall-url-test'),
  );
  execFileSync('/usr/libexec/PlistBuddy', [
    '-c',
    'Set :CFBundleExecutable browser-recall-url-test',
    path.join(testApp, 'Contents/Info.plist'),
  ]);
  execFileSync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    testApp,
  ]);
  execFileSync('/usr/bin/open', [
    '-n',
    '-F',
    '--env',
    `BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR=${path.join(work, 'profile')}`,
    '--env',
    'BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION=1',
    '--env',
    'BROWSER_RECALL_SKIP_LOGIN_ITEM_REGISTRATION=1',
    testApp,
  ]);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      pid = Number(
        execFileSync(helper, ['pid', testApp], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      );
      execFileSync(helper, [String(pid), 'dump'], { stdio: 'ignore' });
      break;
    } catch {
      await setTimeout(100);
    }
  }
  assert(pid, 'Isolated URL test app did not launch');
  // Target the isolated app explicitly so this check never changes the user's
  // default URL handler. The preceding registration check covers OS routing.
  console.log(
    execFileSync(
      helper,
      [String(pid), 'reuse-url', 'browser-recall://open', testApp],
      { encoding: 'utf8' },
    ).trim(),
  );
  assert.equal(
    handler(),
    previousHandler,
    'Native app activation changed URL routing',
  );
  console.log(
    'Retained documentation bundle preserves Browser Recall URL routing.',
  );
}, [
  async () => {
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        pid = null;
        return;
      }
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') {
            pid = null;
            break;
          }
          throw error;
        }
        await setTimeout(100);
      }
      if (pid) throw new Error('Isolated URL test app did not exit');
    }
  },
  () => unregisterMacosTestApp(app),
  () => unregisterMacosTestApp(testApp),
  () => rmSync(work, { recursive: true, force: true }),
]);
