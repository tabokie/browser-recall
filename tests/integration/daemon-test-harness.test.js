import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { stopTestDaemon } from './daemon-test-harness.js';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('daemon integration test harness', () => {
  it('rechecks the daemon build on sequential test runs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'browser-recall-build-test-'));
    tempDirs.push(dir);
    const cargoScriptPath = path.join(dir, 'fake-cargo.mjs');
    const countPath = path.join(dir, 'build-count');
    const runnerPath = path.join(dir, 'runner.mjs');
    const harnessUrl = pathToFileURL(
      path.join(process.cwd(), 'tests/integration/daemon-test-harness.js'),
    ).href;

    writeFileSync(
      cargoScriptPath,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(countPath)}, 'built\\n');\n`,
    );
    writeFileSync(
      runnerPath,
      `import { ensureTestDaemonBuilt } from ${JSON.stringify(harnessUrl)};\nawait ensureTestDaemonBuilt();\nawait ensureTestDaemonBuilt();\n`,
    );

    const childEnv = {
      ...process.env,
      BROWSER_RECALL_TEST_CARGO: process.execPath,
      BROWSER_RECALL_TEST_CARGO_SCRIPT: cargoScriptPath,
      TMPDIR: dir,
    };

    const run = spawnSync(process.execPath, [runnerPath], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8',
    });

    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(countPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('force-kills a daemon that ignores graceful shutdown', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGINT', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
    });

    try {
      await stopTestDaemon(child, 50);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
  });
});
