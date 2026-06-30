import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    const binDir = path.join(dir, 'bin');
    const cargoPath = path.join(binDir, 'cargo');
    const countPath = path.join(dir, 'build-count');
    const runnerPath = path.join(dir, 'runner.mjs');
    const harnessUrl = pathToFileURL(
      path.join(process.cwd(), 'tests/integration/daemon-test-harness.js'),
    ).href;

    mkdirSync(binDir);
    writeFileSync(
      cargoPath,
      `#!/bin/sh\nprintf 'built\\n' >> '${countPath}'\n`,
      { mode: 0o755, flag: 'w' },
    );
    chmodSync(cargoPath, 0o755);
    writeFileSync(
      runnerPath,
      `import { ensureTestDaemonBuilt } from ${JSON.stringify(harnessUrl)};\nawait ensureTestDaemonBuilt();\nawait ensureTestDaemonBuilt();\n`,
    );

    const run = spawnSync(process.execPath, [runnerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        TMPDIR: dir,
      },
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
