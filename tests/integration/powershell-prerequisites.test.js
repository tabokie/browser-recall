import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runTestProcess } from '../smoke/windows-desktop-process.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const rollbackTests = 'tests/integration/windows-update-environment.test.js';

function portableEnvironment() {
  const environment = { ...process.env };
  delete environment.GITHUB_ACTIONS;
  delete environment.BROWSER_RECALL_TEST_POWERSHELL;
  return environment;
}

test('missing PowerShell fails the portable rollback checks instead of skipping', () => {
  const work = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-no-powershell-'),
  );
  const reportFile = path.join(work, 'report.json');
  try {
    const result = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        rollbackTests,
        '--reporter=json',
        `--outputFile=${reportFile}`,
      ],
      {
        cwd: root,
        env: { ...portableEnvironment(), PATH: work, Path: work },
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    expect(report.numFailedTests).toBe(2);
    expect(report.numPendingTests).toBe(1);
    expect(JSON.stringify(report)).toContain('PowerShell is required');
    const prerequisite = spawnSync(
      process.execPath,
      ['scripts/check-test-prerequisites.mjs'],
      {
        cwd: root,
        env: { ...portableEnvironment(), PATH: work, Path: work },
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    expect(prerequisite.error).toBeUndefined();
    expect(prerequisite.status).toBe(1);
    expect(prerequisite.stderr).toContain('PowerShell is required');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'slow PowerShell startup still executes both real rollback scenarios',
  async () => {
    const work = mkdtempSync(
      path.join(tmpdir(), 'browser-recall-slow-powershell-'),
    );
    const launcher = path.join(work, 'pwsh.mjs');
    const reportFile = path.join(work, 'report.json');
    const executable = process.env.BROWSER_RECALL_TEST_POWERSHELL || 'pwsh';
    try {
      writeFileSync(
        launcher,
        `#!/usr/bin/env node
import { spawn } from 'node:child_process';
setTimeout(() => {
  const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), { stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}, 11000);
`,
      );
      chmodSync(launcher, 0o700);
      await runTestProcess(
        process.execPath,
        [
          vitest,
          'run',
          rollbackTests,
          '--reporter=json',
          `--outputFile=${reportFile}`,
        ],
        {
          env: {
            ...portableEnvironment(),
            BROWSER_RECALL_TEST_POWERSHELL: launcher,
          },
          timeoutMs: 80000,
        },
      );
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      expect(report.numPassedTests).toBe(2);
      expect(report.numFailedTests).toBe(0);
      expect(report.numPendingTests).toBe(1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  90000,
);
