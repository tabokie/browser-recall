import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  runTestProcess,
  waitForExit,
  stopTestProcess,
  removeTestProfile,
} from './windows-desktop-process.mjs';
import {
  waitForDesktopStartup,
  waitForProcessProbe,
} from './desktop-process-readiness.mjs';
import { withCleanup } from './desktop-test-cleanup.mjs';

import {
  isolatedDesktopEnvironment,
  isolatedDesktopLogDir,
} from './windows-desktop-test-profile.mjs';

if (process.platform !== 'win32') {
  console.log('Windows desktop single-instance smoke test skipped');
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, '../..');
const executable =
  process.env.BROWSER_RECALL_DESKTOP_TEST_EXECUTABLE ||
  path.join(root, 'dist/desktop/windows/bin/browser-recall-desktop.exe');
if (!existsSync(executable)) {
  throw new Error(
    `Desktop executable is missing at ${executable}; build the desktop app first`,
  );
}

const windowsIcon = path.join(root, 'apps/desktop/src-tauri/icons/icon.ico');
const windowsIconSizes = [
  16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 256,
];

function extractIcoPngs(icoPath, outDir) {
  const ico = readFileSync(icoPath);
  const count = ico.readUInt16LE(4);
  const sizes = [];
  mkdirSync(outDir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const size = ico[entryOffset] || 256;
    const length = ico.readUInt32LE(entryOffset + 8);
    const imageOffset = ico.readUInt32LE(entryOffset + 12);
    writeFileSync(
      path.join(outDir, `icon-${size}.png`),
      ico.subarray(imageOffset, imageOffset + length),
    );
    sizes.push(size);
  }
  return sizes;
}

async function verifyEmbeddedWindowsIcons() {
  const probeDir = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-embedded-icons-'),
  );
  try {
    const sizes = extractIcoPngs(windowsIcon, probeDir);
    if (JSON.stringify(sizes) !== JSON.stringify(windowsIconSizes)) {
      throw new Error(`Unexpected Windows ICO sizes: ${sizes.join(', ')}`);
    }
    const output = (
      await runTestProcess(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrowserRecallIconProbe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern uint PrivateExtractIcons(string file, int index, int width, int height, IntPtr[] icons, uint[] ids, uint count, uint flags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr icon);
}
'@
$sizes = 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 256
foreach ($size in $sizes) {
  $handles = New-Object IntPtr[] 1
  $ids = New-Object uint32[] 1
  $count = [BrowserRecallIconProbe]::PrivateExtractIcons($env:BROWSER_RECALL_ICON_EXE, 0, $size, $size, $handles, $ids, 1, 0)
  if ($count -ne 1 -or $handles[0] -eq [IntPtr]::Zero) {
    throw "The executable does not expose a $($size)px icon"
  }
  $source = New-Object System.Drawing.Bitmap (Join-Path $env:BROWSER_RECALL_ICON_SLOTS "icon-$size.png")
  $icon = [System.Drawing.Icon]::FromHandle($handles[0])
  $embedded = $icon.ToBitmap()
  try {
    if ($source.Width -ne $size -or $source.Height -ne $size -or $embedded.Width -ne $size -or $embedded.Height -ne $size) {
      throw "The $($size)px icon dimensions do not match"
    }
    for ($y = 0; $y -lt $size; $y += 1) {
      for ($x = 0; $x -lt $size; $x += 1) {
        if ($source.GetPixel($x, $y).ToArgb() -ne $embedded.GetPixel($x, $y).ToArgb()) {
          throw "The embedded $($size)px icon differs from the generated ICO"
        }
      }
    }
  } finally {
    $source.Dispose()
    $embedded.Dispose()
    [BrowserRecallIconProbe]::DestroyIcon($handles[0]) | Out-Null
  }
}
Write-Output ($sizes -join ',')
`,
        ],
        {
          env: {
            ...process.env,
            BROWSER_RECALL_ICON_EXE: executable,
            BROWSER_RECALL_ICON_SLOTS: probeDir,
          },
        },
      )
    ).trim();
    if (output !== windowsIconSizes.join(',')) {
      throw new Error(`Unexpected native icon probe output: ${output}`);
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

async function verifyRuntimeWindowsIcons(processId, timeoutMs = 15_000) {
  const output = (
    await runTestProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrowserRecallRuntimeIconProbe {
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr type, IntPtr dpi);
  [DllImport("user32.dll")]
  public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetricsForDpi(int index, uint dpi);
  [DllImport("user32.dll")]
  public static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("gdi32.dll")]
  public static extern int GetObject(IntPtr handle, int size, out BITMAP bitmap);
  [DllImport("gdi32.dll")]
  public static extern bool DeleteObject(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)]
  public struct ICONINFO {
    [MarshalAs(UnmanagedType.Bool)] public bool isIcon;
    public uint xHotspot;
    public uint yHotspot;
    public IntPtr mask;
    public IntPtr color;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAP {
    public int type;
    public int width;
    public int height;
    public int widthBytes;
    public ushort planes;
    public ushort bitsPixel;
    public IntPtr bits;
  }
}
'@
$process = Get-Process -Id ([int]$env:BROWSER_RECALL_ICON_PROCESS)
$window = [IntPtr]$process.MainWindowHandle
if ($window -eq [IntPtr]::Zero) {
  throw "Desktop process has no main window"
}
$dpi = [BrowserRecallRuntimeIconProbe]::GetDpiForWindow($window)
$expectedSmall = [BrowserRecallRuntimeIconProbe]::GetSystemMetricsForDpi(49, $dpi)
$expectedBig = [BrowserRecallRuntimeIconProbe]::GetSystemMetricsForDpi(11, $dpi)
$actual = @()
foreach ($kind in 0, 1) {
  $handle = [BrowserRecallRuntimeIconProbe]::SendMessage($window, 0x7f, [IntPtr]$kind, [IntPtr]$dpi)
  if ($handle -eq [IntPtr]::Zero) {
    throw "Desktop window has no WM_GETICON representation for kind $kind"
  }
  $info = New-Object BrowserRecallRuntimeIconProbe+ICONINFO
  if (-not [BrowserRecallRuntimeIconProbe]::GetIconInfo($handle, [ref]$info)) {
    throw "Could not inspect desktop window icon kind $kind"
  }
  try {
    $bitmap = New-Object BrowserRecallRuntimeIconProbe+BITMAP
    [void][BrowserRecallRuntimeIconProbe]::GetObject(
      $info.color,
      [Runtime.InteropServices.Marshal]::SizeOf($bitmap),
      [ref]$bitmap
    )
    $actual += $bitmap.width
  } finally {
    if ($info.color -ne [IntPtr]::Zero) {
      [void][BrowserRecallRuntimeIconProbe]::DeleteObject($info.color)
    }
    if ($info.mask -ne [IntPtr]::Zero) {
      [void][BrowserRecallRuntimeIconProbe]::DeleteObject($info.mask)
    }
  }
}
if ($actual[0] -ne $expectedSmall) {
  throw "Desktop WM_SMALL icon is $($actual[0])px; expected $expectedSmall px at $dpi DPI"
}
if ($actual[1] -ne $expectedBig) {
  throw "Desktop WM_BIG icon is $($actual[1])px; expected $expectedBig px at $dpi DPI"
}
Write-Output "$dpi,$expectedSmall,$expectedBig"
`,
      ],
      {
        timeoutMs,
        env: {
          ...process.env,
          BROWSER_RECALL_ICON_PROCESS: String(processId),
        },
      },
    )
  ).trim();
  const [dpi, small, big] = output.split(',').map(Number);
  if (![dpi, small, big].every(Number.isInteger)) {
    throw new Error(`Unexpected runtime icon probe output: ${output}`);
  }
  return { dpi, small, big };
}

await verifyEmbeddedWindowsIcons();
if (process.argv.includes('--icons-only')) {
  console.log(
    `Executable contains exact generated icon representations: ${windowsIconSizes.join(', ')} px`,
  );
  process.exit(0);
}

const runningIconProcessArgument = process.argv.find((argument) =>
  argument.startsWith('--running-icons-pid='),
);
if (
  process.argv.includes('--running-icons-only') ||
  runningIconProcessArgument
) {
  const processId = runningIconProcessArgument
    ? Number(runningIconProcessArgument.split('=', 2)[1])
    : Number(
        (
          await runTestProcess('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '(Get-Process browser-recall-desktop | Select-Object -First 1).Id',
          ])
        ).trim(),
      );
  const iconSizes = await verifyRuntimeWindowsIcons(processId);
  console.log(
    `Running desktop exposes ${iconSizes.small}px and ${iconSizes.big}px window icons at ${iconSizes.dpi} DPI`,
  );
  process.exit(0);
}

const taskList = await runTestProcess('tasklist.exe', [
  '/FI',
  `IMAGENAME eq ${path.basename(executable)}`,
  '/FO',
  'CSV',
  '/NH',
]);
if (taskList.toLowerCase().includes(path.basename(executable).toLowerCase())) {
  throw new Error('Close Browser Recall before running the native smoke test');
}

const workDir = mkdtempSync(
  path.join(tmpdir(), 'browser-recall-windows-native-smoke-'),
);
const profileDir = path.join(workDir, 'profile');
const startupTraceFile = `${profileDir}.startup-stages.log`;
const logDir = isolatedDesktopLogDir(profileDir);
const desktopEnvironment = isolatedDesktopEnvironment(process.env, profileDir);
const diagnosticsDir = path.join(
  root,
  'test-results/native-lifecycle',
  path.basename(workDir),
);

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(failureMessage);
}

function readNewLogs() {
  if (!existsSync(logDir)) return '';
  let result = '';
  for (const name of readdirSync(logDir)) {
    if (!name.startsWith('browser-recall') || !name.endsWith('.log')) continue;
    const file = path.join(logDir, name);
    result += readFileSync(file, 'utf8');
  }
  return result;
}

let first;
let second;
let startupOutput = '';
let startupReadyMs;
let started;
let capturedDiagnostics;
function readStartupStages() {
  try {
    return readFileSync(startupTraceFile, 'utf8');
  } catch (error) {
    return `Startup stages unavailable: ${error.message}`;
  }
}
function startupDiagnostics() {
  if (capturedDiagnostics !== undefined) return capturedDiagnostics;
  const details = [
    `Startup stages (${startupTraceFile}):\n${readStartupStages()}`,
  ];
  try {
    details.push(`Profile files:\n${readdirSync(profileDir).join('\n')}`);
  } catch (error) {
    details.push(`Profile files unavailable: ${error.message}`);
  }
  try {
    const processes = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        String.raw`
$ownerId = [int]$env:BROWSER_RECALL_STARTUP_PID
Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId OR ParentProcessId = $ownerId" |
  Select-Object Name, ProcessId, ParentProcessId, KernelModeTime, UserModeTime, ExecutablePath,
    @{Name='FileVersion'; Expression={
      if (!$_.ExecutablePath) { return 'Unavailable: process path not reported' }
      try { (Get-Item -LiteralPath $_.ExecutablePath -ErrorAction Stop).VersionInfo.FileVersion }
      catch { "Unavailable: $($_.Exception.Message)" }
    }} |
  ConvertTo-Json -Compress
`,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        killSignal: 'SIGKILL',
        env: {
          ...desktopEnvironment,
          BROWSER_RECALL_STARTUP_PID: String(first.pid),
        },
      },
    );
    details.push(`Startup processes:\n${processes.trim()}`);
  } catch (error) {
    details.push(`Startup process inspection failed: ${error.message}`);
  }
  capturedDiagnostics = details.join('\n');
  return capturedDiagnostics;
}
const startupFailure = (error) => {
  const message = `${error.message}; exitCode=${first.exitCode}, signal=${first.signalCode}\nOutput:\n${startupOutput}\nLogs:\n${error.startupLogs || ''}\n${startupDiagnostics()}${error.followUp ? `\n${error.followUp}` : ''}`;
  if (process.env.GITHUB_ACTIONS === 'true') {
    const annotation = message
      .replaceAll('%', '%25')
      .replaceAll('\r', '%0D')
      .replaceAll('\n', '%0A');
    console.log(`::error title=Windows native startup::${annotation}`);
  }
  return new Error(message, { cause: error });
};

function preserveStartupDiagnostics(error = null) {
  mkdirSync(diagnosticsDir, { recursive: true });
  const stages = readStartupStages();
  writeFileSync(path.join(diagnosticsDir, 'startup-stages.log'), stages);
  writeFileSync(path.join(diagnosticsDir, 'process-output.log'), startupOutput);
  writeFileSync(
    path.join(diagnosticsDir, 'native-environment.txt'),
    startupDiagnostics(),
  );
  if (existsSync(logDir)) {
    cpSync(logDir, path.join(diagnosticsDir, 'logs'), { recursive: true });
  }
  writeFileSync(
    path.join(diagnosticsDir, 'startup.json'),
    `${JSON.stringify(
      {
        outcome: error ? 'failed' : 'passed',
        executable,
        revision: process.env.GITHUB_SHA || null,
        runnerImage: process.env.ImageOS || null,
        runnerImageVersion: process.env.ImageVersion || null,
        processId: first?.pid || null,
        startupReadyMs: startupReadyMs ?? null,
        elapsedMs: started === undefined ? null : performance.now() - started,
      },
      null,
      2,
    )}\n`,
  );
  if (error) {
    writeFileSync(
      path.join(diagnosticsDir, 'failure.txt'),
      error.stack || String(error),
    );
  }
  console.log(`Windows startup stages:\n${stages}`);
  console.log(`Windows startup diagnostics saved to ${diagnosticsDir}`);
}

await withCleanup(
  async () => {
    // windowsHide applies SW_HIDE to GUI apps too. Honor the application's first
    // ShowWindow call, as the native update/relaunch scenario does.
    started = performance.now();
    first = spawn(executable, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: desktopEnvironment,
    });
    for (const stream of [first.stdout, first.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (text) => (startupOutput += text));
    }
    await once(first, 'spawn');
    try {
      await waitForDesktopStartup(first, {
        readLogs: readNewLogs,
        readStages: readStartupStages,
      });
      startupReadyMs = performance.now() - started;
    } catch (error) {
      throw startupFailure(error);
    }
    const iconSizes = await waitForProcessProbe(
      first,
      verifyRuntimeWindowsIcons,
      {
        timeoutMs: 15_000,
        description: 'The desktop window icons',
      },
    );

    second = spawn(executable, ['browser-recall://settings'], {
      stdio: 'ignore',
      env: desktopEnvironment,
    });
    const secondExit = await waitForExit(second, 15000);
    if (secondExit.code !== 0 || secondExit.signal !== null) {
      throw new Error(
        `The forwarded second process exited unexpectedly: ${JSON.stringify(secondExit)}`,
      );
    }
    if (first.exitCode !== null) {
      throw new Error('The original desktop process exited during forwarding');
    }

    await waitFor(
      () => {
        const logs = readNewLogs();
        return (
          logs.includes('received deep link') &&
          logs.includes('route="settings"')
        );
      },
      10000,
      'The original desktop process did not receive the forwarded settings route',
    );

    console.log(
      `Second launch exited cleanly; process ${first.pid} received browser-recall://settings; runtime icons are ${iconSizes.small}px and ${iconSizes.big}px at ${iconSizes.dpi} DPI`,
    );
    preserveStartupDiagnostics();
  },
  [
    () => stopTestProcess(second),
    () => stopTestProcess(first),
    () => removeTestProfile(workDir),
  ],
  { onFailure: preserveStartupDiagnostics },
);
