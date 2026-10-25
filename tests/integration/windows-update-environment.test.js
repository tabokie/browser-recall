import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { isolatedDesktopEnvironment } from '../smoke/windows-desktop-test-profile.mjs';
import { withCleanup } from '../smoke/desktop-test-cleanup.mjs';
import { runPowerShell } from '../smoke/powershell-process.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const environmentHelper = path.join(
  root,
  'tests/smoke/windows-desktop-update-environment.ps1',
);

// These reader checks are portable and mandatory; only registry changes below
// require a disposable Windows runner. Missing PowerShell must never look green.
test.each([false, true])(
  'environment rollback iterates separate absent and existing entries; Windows PowerShell array behavior: %s',
  async (windowsArrayBehavior) => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-rollback-json-'),
    );
    try {
      const state = path.join(work, 'environment.json');
      const entries = [
        {
          name: 'BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR',
          present: false,
          value: null,
          kind: null,
        },
        {
          name: 'BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION',
          present: true,
          value: 'original',
          kind: 'String',
        },
        {
          name: 'WEBVIEW2_USER_DATA_FOLDER',
          present: true,
          value: '%LOCALAPPDATA%\\original webview',
          kind: 'ExpandString',
        },
      ];
      writeFileSync(state, JSON.stringify(entries));
      const script = path.join(work, 'read-snapshot.ps1');
      writeFileSync(
        script,
        String.raw`
$ErrorActionPreference = 'Stop'
. $env:BROWSER_RECALL_SNAPSHOT_HELPER
# Windows PowerShell 5.1 emits a JSON array as one pipeline object. Reproduce
# that behavior on PowerShell 7 through the real cmdlet's NoEnumerate option.
if ($env:BROWSER_RECALL_WINDOWS_JSON_ARRAY -eq '1' -and $PSVersionTable.PSVersion.Major -ge 7) {
  function ConvertFrom-Json {
    param([string]$InputObject)
    Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $InputObject -NoEnumerate
  }
}
$snapshot = Read-WindowsUpdateEnvironmentSnapshot $env:BROWSER_RECALL_SNAPSHOT_FILE
# Observe the same foreach iteration used by restoration. Windows PowerShell
# 5.1 can serialize the whole parsed array with extra value/Count properties.
foreach ($entry in $snapshot) {
  ConvertTo-Json -InputObject $entry -Depth 5 -Compress
}
`,
      );
      const result = await runPowerShell(['-File', script], {
        env: {
          ...process.env,
          BROWSER_RECALL_SNAPSHOT_HELPER: path.join(
            root,
            'tests/smoke/windows-update-environment-snapshot.ps1',
          ),
          BROWSER_RECALL_SNAPSHOT_FILE: state,
          BROWSER_RECALL_WINDOWS_JSON_ARRAY: windowsArrayBehavior ? '1' : '0',
        },
      });
      expect(
        result
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line)),
      ).toEqual(entries);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  75_000,
);

// User environment changes and token-based launches belong on disposable runners.
test.skipIf(
  process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true',
)(
  'Windows installer relaunch retains the isolated profile and restores the user environment after failure',
  async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-update env-'));
    const state = path.join(work, 'environment.json');
    const probe = path.join(work, 'probe.cjs');
    const result = path.join(work, 'result.json');
    const environment = {
      ...isolatedDesktopEnvironment(process.env, path.join(work, 'profile')),
      BROWSER_RECALL_ISOLATED_WINDOWS_SESSION: '1',
      BROWSER_RECALL_PORTS: '54321',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--force-renderer-accessibility',
    };
    const names = [
      'BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR',
      'BROWSER_RECALL_SKIP_DEEP_LINK_REGISTRATION',
      'BROWSER_RECALL_SKIP_LOGIN_ITEM_REGISTRATION',
      'BROWSER_RECALL_PORTS',
      'WEBVIEW2_USER_DATA_FOLDER',
      'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
    ];
    writeFileSync(
      probe,
      `require('node:fs').writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name] ?? null]))));`,
    );
    const powershell = (args, env = environment) =>
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', ...args],
        {
          env,
          encoding: 'utf8',
          timeout: 20000,
          stdio: 'pipe',
        },
      );
    const launch = () => {
      powershell(
        [
          '-Command',
          String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Path $env:BROWSER_RECALL_TOKEN_LAUNCH_SOURCE
[BrowserRecallTokenLaunch]::Run($env:BROWSER_RECALL_TOKEN_LAUNCH_NODE, $env:BROWSER_RECALL_TOKEN_LAUNCH_PROBE, $env:BROWSER_RECALL_TOKEN_LAUNCH_RESULT)
`,
        ],
        {
          ...environment,
          BROWSER_RECALL_TOKEN_LAUNCH_SOURCE: path.join(
            root,
            'tests/fixtures/windows-token-launch.cs',
          ),
          BROWSER_RECALL_TOKEN_LAUNCH_NODE: process.execPath,
          BROWSER_RECALL_TOKEN_LAUNCH_PROBE: probe,
          BROWSER_RECALL_TOKEN_LAUNCH_RESULT: result,
        },
      );
      return JSON.parse(readFileSync(result, 'utf8'));
    };
    const change = (action, env) =>
      powershell(
        ['-File', environmentHelper, '-Action', action, '-StatePath', state],
        env,
      );
    try {
      // Reproduce the escaped boundary: CreateProcessWithTokenW with a null
      // environment ignores the launcher's process-only profile and port.
      const original = launch();
      expect(original.BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR).not.toBe(
        environment.BROWSER_RECALL_DESKTOP_TEST_PROFILE_DIR,
      );
      expect(() =>
        change('set', {
          ...environment,
          BROWSER_RECALL_ISOLATED_WINDOWS_SESSION: '',
        }),
      ).toThrow(/disposable Windows session/);
      expect(existsSync(state)).toBe(false);
      const failure = new Error('native update UI failed');
      await expect(
        withCleanup(async () => {
          change('set');
          expect(launch()).toEqual(
            Object.fromEntries(names.map((name) => [name, environment[name]])),
          );
          throw failure;
        }, [
          () => {
            if (existsSync(state)) change('restore');
          },
        ]),
      ).rejects.toBe(failure);
      expect(launch()).toEqual(original);
      expect(existsSync(state)).toBe(false);
    } finally {
      if (existsSync(state)) change('restore');
      rmSync(work, { recursive: true, force: true });
    }
  },
);
