import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { prepareCiRelease } from '../../scripts/prepare-ci-release.mjs';
import { generateRustCoverage } from '../../scripts/rust-coverage.mjs';
import { validateMacosSignatureMetadata } from '../../scripts/verify-macos-app-bundle.mjs';

test('Windows validation gate surfaces the failed test from its JSON report and still blocks packaging', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const workflow = readFileSync(
    path.join(root, '.github/workflows/desktop-release-validation.yml'),
    'utf8',
  );
  const gate = workflow
    .split('      - name: Require Windows validation checks to pass\n')[1]
    .split('\n      - name: ')[0];
  const command = gate.match(/        run: (?:\|\n\s*)?(node[^\n]+)/)[1];
  const args = command.startsWith('node -e ')
    ? ['-e', JSON.parse(command.slice('node -e '.length))]
    : [path.join(root, command.slice('node '.length))];
  const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-windows-gate-'));
  try {
    const reports = path.join(work, 'test-results/windows-validation');
    mkdirSync(reports, { recursive: true });
    writeFileSync(
      path.join(reports, 'cleanup.json'),
      JSON.stringify({
        testResults: [
          {
            assertionResults: [
              {
                fullName:
                  'Windows installer relaunch retains the isolated profile',
                status: 'failed',
                failureMessages: [
                  'DuplicateTokenEx failed (5): Access is denied',
                ],
              },
            ],
          },
        ],
      }),
    );
    for (const outcome of ['success', 'failure', 'cancelled', 'skipped']) {
      const result = spawnSync(process.execPath, args, {
        cwd: work,
        env: {
          ...process.env,
          WINDOWS_SIGNING_RESULT: 'success',
          WINDOWS_CLEANUP_RESULT: outcome,
          WINDOWS_ARTIFACTS_RESULT: 'success',
        },
        encoding: 'utf8',
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(outcome === 'success' ? 0 : 1);
      if (outcome === 'failure') {
        expect(result.stderr).toContain(
          'Windows installer relaunch retains the isolated profile',
        );
        expect(result.stderr).toContain(
          'DuplicateTokenEx failed (5): Access is denied',
        );
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('local CI executes JavaScript and Rust tests only through coverage', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-ci-plan-'));
  try {
    const source = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const scripts = { ...source.scripts };
    for (const name of [
      'ci:check-docs',
      'ci:install-playwright',
      'ci:test-extension-e2e',
      'ci:install-desktop-visual-browsers',
      'ci:test-desktop-visual',
      'ci:lint-js',
      'ci:lint-rust',
      'test:cold-scripts',
      'coverage:monitor',
    ])
      scripts[name] = 'node check.mjs other';
    for (const name of ['test', 'coverage:js'])
      scripts[name] = 'node check.mjs javascript';
    for (const name of ['ci:test-rust', 'coverage:rust'])
      scripts[name] = 'node check.mjs rust';
    writeFileSync(path.join(work, 'package.json'), JSON.stringify({ scripts }));
    writeFileSync(
      path.join(work, 'check.mjs'),
      "import { appendFileSync } from 'node:fs'; appendFileSync('executions', process.argv[2] + '\\n');",
    );
    execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : 'npm',
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm run ci']
        : ['run', 'ci'],
      { cwd: work, stdio: 'pipe' },
    );
    const executions = readFileSync(
      path.join(work, 'executions'),
      'utf8',
    ).split('\n');
    expect(executions.filter((name) => name === 'javascript')).toHaveLength(1);
    expect(executions.filter((name) => name === 'rust')).toHaveLength(1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('CI signing preparation refuses a normal developer checkout', () => {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.RUNNER_TEMP;
  delete env.GITHUB_ENV;
  const result = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dirname, '../../scripts/prepare-ci-release.mjs')],
    { env, encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'requires a disposable GitHub Actions checkout',
  );
});

test('CI embeds a matching disposable signing key without changing other desktop configuration', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-ci-release-'));
  try {
    const configPath = path.join(
      work,
      'apps/desktop/src-tauri/tauri.conf.json',
    );
    mkdirSync(path.dirname(configPath), { recursive: true });
    const config = {
      version: '1.0.1',
      identifier: 'app.example',
      plugins: {
        updater: {
          pubkey: 'production-public-key',
          endpoints: ['https://example.test/latest.json'],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const directory = path.join(work, 'signing');
    const environmentFile = path.join(work, 'environment');
    prepareCiRelease({ root: work, directory, environmentFile });
    const key = path.join(directory, 'updater.key');
    const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
    expect(publicKey).not.toBe(config.plugins.updater.pubkey);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      ...config,
      plugins: { updater: { ...config.plugins.updater, pubkey: publicKey } },
    });
    const environment = readFileSync(environmentFile, 'utf8');
    expect(environment).toContain(`TAURI_SIGNING_PRIVATE_KEY=${key}\n`);
    expect(environment).not.toContain(readFileSync(key, 'utf8').trim());
    const packagePath = path.join(work, 'fixture.bin');
    writeFileSync(packagePath, 'signed CI package');
    execFileSync(
      process.execPath,
      [
        path.resolve(
          import.meta.dirname,
          '../../node_modules/@tauri-apps/cli/tauri.js',
        ),
        'signer',
        'sign',
        '-f',
        key,
        '-p',
        '',
        packagePath,
      ],
      { stdio: 'pipe' },
    );
    expect(readFileSync(`${packagePath}.sig`, 'utf8').trim()).not.toBe('');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Rust coverage executes tests once and generates both reports from the same run', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-coverage-'));
  const calls = [];
  try {
    generateRustCoverage(work, (command, args) => {
      expect(command).toBe('cargo');
      calls.push(args);
      return { status: 0 };
    });
    const testRuns = calls.filter(
      (args) => args[1] !== 'report' && args[1] !== 'clean',
    );
    expect(testRuns).toHaveLength(1);
    expect(testRuns[0]).toEqual(
      expect.arrayContaining(['--workspace', '--all-targets', '--locked']),
    );
    const reports = calls.filter((args) => args[1] === 'report');
    expect(reports).toHaveLength(2);
    expect(reports.flat()).toContain(
      path.join(work, 'coverage/rust/coverage-summary.json'),
    );
    expect(reports.flat()).toContain(
      path.join(work, 'coverage/rust/missing.txt'),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('Rust coverage preserves command failures without rerunning the suite', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-coverage-'));
  const calls = [];
  try {
    expect(() =>
      generateRustCoverage(work, (_command, args) => {
        calls.push(args);
        return { status: 17 };
      }),
    ).toThrow('exit code 17');
    expect(calls).toHaveLength(1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// Retain the strict signature parser check formerly mixed with YAML string tests.
test('macOS signature verification requires the stable identifier and hardened runtime', () => {
  const identifier = 'app.browser-recall.desktop';
  const requirements = `designated => identifier "${identifier}"`;
  expect(() =>
    validateMacosSignatureMetadata(
      `Identifier=${identifier}\nCodeDirectory v=20500 flags=0x0(none)`,
      identifier,
      requirements,
    ),
  ).toThrow(/hardened runtime/);
  expect(() =>
    validateMacosSignatureMetadata(
      `Identifier=${identifier}\nCodeDirectory v=20500 flags=0x10000(runtime)`,
      identifier,
      requirements,
    ),
  ).not.toThrow();
});
