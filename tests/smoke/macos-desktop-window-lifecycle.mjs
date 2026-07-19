import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

if (process.platform !== 'darwin') {
  console.log('macOS desktop window lifecycle smoke test skipped');
  process.exit(0);
}

if (process.env.BROWSER_RECALL_ISOLATED_MACOS_SESSION !== '1') {
  throw new Error(
    'Native tray testing registers a macOS status item. Run only in an ephemeral user/session with BROWSER_RECALL_ISOLATED_MACOS_SESSION=1.',
  );
}

const root = path.resolve(import.meta.dirname, '../..');
const sourceApp = path.join(root, 'dist/desktop/macos/app/Browser Recall.app');
if (!existsSync(sourceApp)) {
  throw new Error(
    `Desktop app bundle is missing at ${sourceApp}; build the desktop app first`,
  );
}

const workDir = mkdtempSync(
  path.join(tmpdir(), 'browser-recall-window-smoke-'),
);
const testApp = path.join(workDir, 'Browser Recall Lifecycle Test.app');
const testHome = path.join(workDir, 'home');
const executableDir = path.join(testApp, 'Contents/MacOS');
const executableName = 'browser-recall-lifecycle-test';
const captureSource = path.join(workDir, 'capture.swift');
const captureExecutable = path.join(workDir, 'capture');
const pausedStartupScreenshot = path.join(workDir, 'paused-startup.png');
const pausedStartupBitmap = path.join(workDir, 'paused-startup.bmp');
let pid = null;

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function appleScript(source) {
  return run('/usr/bin/osascript', ['-e', source]);
}

function launchTestApp() {
  run('/usr/bin/open', [
    '-n',
    '-F',
    '--env',
    `HOME=${testHome}`,
    '--env',
    'BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION=1',
    testApp,
  ]);
}

function waitForAppPid() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = spawnSync('/usr/bin/pgrep', ['-x', executableName], {
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout.trim()) {
      return Number(result.stdout.trim().split('\n').at(-1));
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error('Desktop lifecycle test app did not launch');
}

function waitForProcessExit(processId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(processId, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error('Desktop lifecycle test app did not exit');
}

function assertWebviewPainted(bitmapPath) {
  const bitmap = readFileSync(bitmapPath);
  const pixelOffset = bitmap.readUInt32LE(10);
  const width = bitmap.readInt32LE(18);
  const signedHeight = bitmap.readInt32LE(22);
  const height = Math.abs(signedHeight);
  if (bitmap.readUInt16LE(28) !== 32 || width <= 0 || height <= 0) {
    throw new Error('Desktop screenshot is not a 32-bit bitmap');
  }
  let paintedPixels = 0;
  let sampledPixels = 0;
  for (let y = 120; y < height - 20; y += 4) {
    const sourceY = signedHeight < 0 ? y : height - 1 - y;
    for (let x = 20; x < width - 20; x += 4) {
      const offset = pixelOffset + (sourceY * width + x) * 4;
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      sampledPixels += 1;
      if (red < 245 || green < 245 || blue < 245) paintedPixels += 1;
    }
  }
  if (paintedPixels / sampledPixels < 0.01) {
    throw new Error('Desktop webview remained blank after startup');
  }
}

try {
  writeFileSync(
    captureSource,
    `import AppKit
import CoreGraphics
import Foundation

let ownerPid = Int32(CommandLine.arguments[1])!
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let windows = CGWindowListCopyWindowInfo(
  [.optionOnScreenOnly, .excludeDesktopElements],
  kCGNullWindowID
) as! [[String: Any]]
let window = windows.first { info in
  (info[kCGWindowOwnerPID as String] as? Int32) == ownerPid &&
    (info[kCGWindowLayer as String] as? Int) == 0
}!
let windowId = CGWindowID(window[kCGWindowNumber as String] as! UInt32)
let bounds = CGRect(
  dictionaryRepresentation: window[kCGWindowBounds as String] as! CFDictionary
)!
let image = CGWindowListCreateImage(
  .null,
  .optionIncludingWindow,
  windowId,
  [.boundsIgnoreFraming, .bestResolution]
)!
let bitmap = NSBitmapImageRep(cgImage: image)
try bitmap.representation(using: .png, properties: [:])!.write(to: output)
print("\\(bounds.origin.x),\\(bounds.origin.y),\\(bounds.width),\\(bounds.height)")
`,
  );
  const swiftArchitecture = process.arch === 'x64' ? 'x86_64' : process.arch;
  if (!['arm64', 'x86_64'].includes(swiftArchitecture)) {
    throw new Error(`Unsupported macOS architecture: ${process.arch}`);
  }
  run('/usr/bin/swiftc', [
    '-suppress-warnings',
    '-target',
    `${swiftArchitecture}-apple-macos14.0`,
    captureSource,
    '-o',
    captureExecutable,
  ]);
  cpSync(sourceApp, testApp, { recursive: true });
  const originalExecutable = readdirSync(executableDir)[0];
  renameSync(
    path.join(executableDir, originalExecutable),
    path.join(executableDir, executableName),
  );
  run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleExecutable ${executableName}`,
    '-c',
    'Set :CFBundleIdentifier app.browser-recall.desktop-lifecycle-test',
    '-c',
    'Set :CFBundleName Browser Recall Lifecycle Test',
    '-c',
    'Set :CFBundleDisplayName Browser Recall Lifecycle Test',
    '-c',
    'Delete :CFBundleURLTypes',
    path.join(testApp, 'Contents/Info.plist'),
  ]);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', testApp]);

  const dataDir = path.join(testHome, 'browser-data');
  const configDir = path.join(
    testHome,
    'Library/Application Support/app.browser-recall.desktop/daemon',
  );
  const malformedLogPath = path.join(
    dataDir,
    'logs/smoke-device/2026-07-15.jsonl',
  );
  mkdirSync(path.join(dataDir, 'logs/smoke-device'), { recursive: true });
  writeFileSync(
    malformedLogPath,
    `${JSON.stringify({
      timestamp: 1_710_000_000_000,
      action: 'visit_page',
      url: 'https://smoke.example/page',
      title: 'Smoke Page',
    })}\n`,
  );
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      device_id: 'smoke-device',
      data_dir: dataDir,
      last_port: null,
      launch_at_login: false,
      log_level: 'info',
      setup_complete: true,
      connectors: [],
      sync_github_token: null,
      sync_github_user: null,
      sync_remember_token: true,
      sync_paused_devices: [],
      sync_devices: {},
    }),
  );

  spawnSync('/usr/bin/pkill', ['-x', executableName]);
  launchTestApp();
  pid = waitForAppPid();

  appleScript(`
    tell application "System Events"
      set targetProcess to missing value
      repeat 100 times
        set matches to application processes whose unix id is ${pid}
        if (count of matches) > 0 then
          set targetProcess to item 1 of matches
          exit repeat
        end if
        delay 0.05
      end repeat
      if targetProcess is missing value then error "application process unavailable"
      repeat 100 times
        if (count of windows of targetProcess) > 0 then exit repeat
        delay 0.05
      end repeat
      if (count of windows of targetProcess) is 0 then error "initial window unavailable"
      set size of window 1 of targetProcess to {980, 680}
      set position of window 1 of targetProcess to {170, 160}
      set frontmost of targetProcess to true
      repeat 100 times
        if name of window 1 of targetProcess is "Browser Recall - Error" then exit repeat
        delay 0.05
      end repeat
      if name of window 1 of targetProcess is not "Browser Recall - Error" then error "daemon startup failure was not reported"
      delay 1
    end tell
  `);
  run(captureExecutable, [String(pid), pausedStartupScreenshot]);
  run('/usr/bin/sips', [
    '-s',
    'format',
    'bmp',
    pausedStartupScreenshot,
    '--out',
    pausedStartupBitmap,
  ]);
  assertWebviewPainted(pausedStartupBitmap);

  // Playwright covers the visible Resume command wiring, while the desktop
  // Rust test starts the real absent daemon after repairing this same startup
  // failure. GitHub-hosted macOS sessions reject synthetic WKWebView input, so
  // repair storage and relaunch before exercising native window behavior.
  writeFileSync(malformedLogPath, '');
  process.kill(pid, 'SIGTERM');
  waitForProcessExit(pid);
  pid = null;
  launchTestApp();
  pid = waitForAppPid();

  // Reopen-only assertions can miss no-op closes and delayed focus theft, so
  // verify both the hidden transition and the final focus handoff explicitly.
  const result = appleScript(`
    tell application "System Events"
      set targetProcess to missing value
      repeat 100 times
        set matches to application processes whose unix id is ${pid}
        if (count of matches) > 0 then
          set targetProcess to item 1 of matches
          exit repeat
        end if
        delay 0.05
      end repeat
      if targetProcess is missing value then error "recovered application process unavailable"
      repeat 100 times
        if (count of windows of targetProcess) > 0 then exit repeat
        delay 0.05
      end repeat
      if (count of windows of targetProcess) is 0 then error "recovered window unavailable"
      repeat 100 times
        if name of window 1 of targetProcess is "Browser Recall" then exit repeat
        delay 0.05
      end repeat
      if name of window 1 of targetProcess is not "Browser Recall" then error "desktop did not recover after storage repair"

      set size of window 1 of targetProcess to {980, 680}
      set position of window 1 of targetProcess to {170, 160}
      set frontmost of targetProcess to true
      delay 1
      set baselinePosition to position of window 1 of targetProcess
      set baselineSize to size of window 1 of targetProcess

      repeat with cycle from 1 to 5
        click button 1 of window 1 of targetProcess
        repeat 40 times
          if (count of windows of targetProcess) is 0 then exit repeat
          delay 0.05
        end repeat
        if (count of windows of targetProcess) is not 0 then error "window did not hide on cycle " & cycle
        if (count of menu bars of targetProcess) < 2 then error "tray menu bar unavailable"
        set trayItem to menu bar item 1 of menu bar 2 of targetProcess
        set trayPosition to position of trayItem
        set traySize to size of trayItem
        if (item 1 of traySize) < 1 or (item 2 of traySize) < 1 then error "tray item has no visible frame"
        if (item 1 of trayPosition) < 0 or (item 2 of trayPosition) < 0 or (item 2 of trayPosition) > 80 then error "tray item is outside the visible menu bar"
        tell trayItem
          perform action "AXShowMenu"
          delay 0.1
          click menu item "Open" of menu 1
        end tell
        repeat 40 times
          if (count of windows of targetProcess) > 0 and frontmost of targetProcess and (value of attribute "AXMain" of window 1 of targetProcess) and position of window 1 of targetProcess is equal to baselinePosition and size of window 1 of targetProcess is equal to baselineSize then exit repeat
          delay 0.05
        end repeat
        if (count of windows of targetProcess) is 0 then error "window did not reopen on cycle " & cycle
        if not frontmost of targetProcess then error "window did not focus on cycle " & cycle
        if not (value of attribute "AXMain" of window 1 of targetProcess) then error "window did not become main on cycle " & cycle
        set actualPosition to position of window 1 of targetProcess
        set actualSize to size of window 1 of targetProcess
        if actualPosition is not equal to baselinePosition then error "window position changed on cycle " & cycle & "; expected " & (item 1 of baselinePosition) & "," & (item 2 of baselinePosition) & ", got " & (item 1 of actualPosition) & "," & (item 2 of actualPosition)
        if actualSize is not equal to baselineSize then error "window size changed on cycle " & cycle & "; expected " & (item 1 of baselineSize) & "," & (item 2 of baselineSize) & ", got " & (item 1 of actualSize) & "," & (item 2 of actualSize)
      end repeat

      click button 1 of window 1 of targetProcess
      repeat 40 times
        if (count of windows of targetProcess) is 0 then exit repeat
        delay 0.05
      end repeat
      if (count of windows of targetProcess) is not 0 then error "window did not hide before focus test"
      tell menu bar item 1 of menu bar 2 of targetProcess
        perform action "AXShowMenu"
        delay 0.1
        click menu item "Open" of menu 1
      end tell
      repeat 40 times
        if frontmost of targetProcess and (value of attribute "AXMain" of window 1 of targetProcess) then exit repeat
        delay 0.05
      end repeat
      if not frontmost of targetProcess then error "window did not focus before focus handoff test"
      if not (value of attribute "AXMain" of window 1 of targetProcess) then error "window did not become main before focus handoff test"
      delay 0.15
      set frontmost of application process "Finder" to true
      delay 0.2
      if frontmost of targetProcess then error "focus retry stole focus from Finder"
      return "five tray reopen cycles preserved geometry and focus"
    end tell
  `);
  const listeners = run('/usr/sbin/lsof', [
    '-nP',
    '-a',
    '-p',
    String(pid),
    '-iTCP',
    '-sTCP:LISTEN',
  ])
    .split('\n')
    .filter((line) => /127\.0\.0\.1:2847[1-3]\s+\(LISTEN\)/.test(line));
  if (listeners.length !== 1) {
    throw new Error(
      `Recovered desktop must leave exactly one listener; found ${listeners.length}`,
    );
  }
  console.log(result);
} finally {
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  if (existsSync(testApp)) {
    spawnSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-u', testApp],
    );
  }
  rmSync(workDir, { recursive: true, force: true });
}
