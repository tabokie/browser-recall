import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
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
const clickSource = path.join(workDir, 'click.swift');
const clickExecutable = path.join(workDir, 'click');
let pid = null;

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function appleScript(source) {
  return run('/usr/bin/osascript', ['-e', source]);
}

try {
  writeFileSync(
    clickSource,
    `import CoreGraphics
import Foundation

let point = CGPoint(
  x: Double(CommandLine.arguments[1])!,
  y: Double(CommandLine.arguments[2])!
)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: 0.02)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
`,
  );
  run('/usr/bin/swiftc', [clickSource, '-o', clickExecutable]);
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

  run('/usr/bin/open', [
    '-n',
    '-F',
    '--env',
    `HOME=${testHome}`,
    '--env',
    'BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION=1',
    testApp,
  ]);

  for (let attempt = 0; attempt < 100 && pid === null; attempt += 1) {
    const result = spawnSync('/usr/bin/pgrep', ['-x', executableName], {
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout.trim()) {
      pid = Number(result.stdout.trim().split('\n').at(-1));
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (!pid) throw new Error('Desktop lifecycle test app did not launch');

  // Reopen-only assertions can miss no-op closes and delayed focus theft, so
  // verify both the hidden transition and the final focus handoff explicitly.
  const result = appleScript(`
    tell application "System Events"
      set targetProcess to first application process whose unix id is ${pid}
      repeat 100 times
        if (count of windows of targetProcess) > 0 then exit repeat
        delay 0.05
      end repeat
      if (count of windows of targetProcess) is 0 then error "initial window unavailable"
      set frontmost of targetProcess to true
      set position of window 1 of targetProcess to {170, 160}
      set size of window 1 of targetProcess to {980, 680}
      delay 0.2

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
        set trayX to (item 1 of trayPosition) + ((item 1 of traySize) div 2)
        set trayY to (item 2 of trayPosition) + ((item 2 of traySize) div 2)
        do shell script "${clickExecutable} " & trayX & " " & trayY
        repeat 40 times
          if (count of windows of targetProcess) > 0 and frontmost of targetProcess then exit repeat
          delay 0.05
        end repeat
        if (count of windows of targetProcess) is 0 then error "window did not reopen on cycle " & cycle
        if not frontmost of targetProcess then error "window did not focus on cycle " & cycle
        if position of window 1 of targetProcess is not equal to {170, 160} then error "window position changed on cycle " & cycle
        if size of window 1 of targetProcess is not equal to {980, 680} then error "window size changed on cycle " & cycle
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
      repeat 10 times
        if frontmost of targetProcess then exit repeat
        delay 0.005
      end repeat
      if not frontmost of targetProcess then error "window did not focus before focus handoff test"
      set frontmost of application process "Finder" to true
      delay 0.2
      if frontmost of targetProcess then error "focus retry stole focus from Finder"
      return "five tray reopen cycles preserved geometry and focus"
    end tell
  `);
  console.log(result);
} finally {
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  rmSync(workDir, { recursive: true, force: true });
}
