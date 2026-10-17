import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { buildDesktop } from '../../scripts/build-desktop.mjs';
import { finalizeMacosAppBundle } from '../../scripts/finalize-macos-app-bundle.mjs';

const hash = 'ABCDEF01'.repeat(5);
const identity = 'Apple Development: Contributor (ABCDE12345)';
const environment = {
  PATH: process.env.PATH,
  APPLE_SIGNING_IDENTITY: identity,
  APPLE_CERTIFICATE: 'release-certificate',
  APPLE_CERTIFICATE_PASSWORD: 'release-password',
  APPLE_ID: 'contributor@example.test',
  APPLE_PASSWORD: 'notarization-password',
  APPLE_TEAM_ID: 'ABCDE12345',
  APPLE_API_KEY: 'notarization-key',
  APPLE_API_ISSUER: 'notarization-issuer',
  APPLE_API_KEY_PATH: '/release/notarization-key',
  TAURI_SIGNING_PRIVATE_KEY: '/release/updater-key',
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'updater-password',
};

test('explicit local builds keep one signing choice through staging, Tauri, collection, and certificate verification', () => {
  for (const [signing, selectedIdentity] of [
    ['unsigned', identity],
    ['signed', identity],
    ['signed', hash.toLowerCase()],
  ]) {
    const calls = [];
    buildDesktop({
      signing,
      platform: 'darwin',
      environment: { ...environment, APPLE_SIGNING_IDENTITY: selectedIdentity },
      finalize: (options) => {
        options.verifySignature('/stage/app/Browser Recall.app');
        return options.outDir;
      },
      run: (command, args, options) => {
        calls.push({ command, args, options });
        if (command === '/usr/bin/security')
          return `  1) ${hash} "${identity}"\n  1 valid identities found\n`;
      },
    });
    const steps = calls.filter(({ command }) => command === process.execPath);
    expect(steps.map(({ args }) => path.basename(args[0]))).toEqual([
      'stage-app-assets.mjs',
      'build-tauri-app.mjs',
    ]);
    expect(steps[0].args[1]).toBe('desktop-ui');
    for (const { options } of steps) {
      expect(options.env).toEqual({
        PATH: environment.PATH,
        APPLE_SIGNING_IDENTITY: signing === 'unsigned' ? '-' : hash,
      });
    }
    if (signing === 'signed') {
      expect(calls.at(-1).command).toBe('/usr/bin/codesign');
      expect(calls.at(-1).args).toContain(`=certificate leaf = H"${hash}"`);
      expect(calls.at(-1).args.at(-1)).toBe('/stage/app/Browser Recall.app');
    } else expect(calls).toHaveLength(2);
  }
  expect(environment.APPLE_SIGNING_IDENTITY).toBe(identity);
  expect(environment.APPLE_PASSWORD).toBe('notarization-password');
});

test('signed builds reject absent, ad-hoc, unavailable, or ambiguous certificates before compiling', () => {
  for (const selected of [undefined, '', ' ', '-', identity]) {
    const builds = [];
    expect(() =>
      buildDesktop({
        signing: 'signed',
        platform: 'darwin',
        environment: { APPLE_SIGNING_IDENTITY: selected },
        run: (command) => {
          if (command === '/usr/bin/security')
            return '  0 valid identities found\n';
          builds.push(command);
        },
      }),
    ).toThrow(/APPLE_SIGNING_IDENTITY/);
    expect(builds).toEqual([]);
  }
  expect(() =>
    buildDesktop({
      signing: 'signed',
      platform: 'darwin',
      environment,
      run: () =>
        `1) ${hash} "${identity}"\n2) ${'1'.repeat(40)} "${identity}"\n`,
    }),
  ).toThrow(/exactly one/);
  for (const platform of ['win32', 'linux']) {
    expect(() =>
      buildDesktop({ signing: 'signed', platform, environment }),
    ).toThrow(
      platform === 'win32'
        ? /WINDOWS_SIGNING_CERTIFICATE/
        : /macOS and Windows only/,
    );
  }
});

test('default builds retain existing signing configuration and failed compilation prevents collection', () => {
  const steps = [];
  expect(() =>
    buildDesktop({
      environment,
      run: (command, args, options) => {
        expect(options.env).toEqual(environment);
        steps.push(path.basename(args[0]));
        if (steps.length === 2) throw new Error('Compilation failed');
      },
    }),
  ).toThrow('Compilation failed');
  expect(steps).toEqual(['stage-app-assets.mjs', 'build-tauri-app.mjs']);
});

test('Windows signing checks the certificate before compilation and verifies staged executables using the same certificate', () => {
  const actions = [];
  const result = buildDesktop({
    signing: 'signed',
    platform: 'win32',
    environment: { WINDOWS_SIGNING_CERTIFICATE: hash.toLowerCase() },
    run: (command, args, options) => {
      if (command === 'powershell.exe') {
        expect(options.env.WINDOWS_SIGNING_CERTIFICATE).toBe(hash);
        actions.push(args[4]);
      } else if (path.basename(args[0]) === 'build-tauri-app.mjs') {
        expect(args.slice(1, 3)).toEqual(['build', '--no-bundle']);
        const config = JSON.parse(args.at(-1));
        expect(config.bundle.windows.signCommand.args).toContain('%1');
        actions.push('compile');
      }
    },
    finalize: (options) => {
      options.verifySignature('/stage/bin/browser-recall-desktop.exe');
      return options.outDir;
    },
  });
  expect(actions).toEqual(['check', 'compile', 'sign', 'verify']);
  expect(result.executable).toContain('browser-recall-desktop.exe');
});

test.skipIf(process.platform !== 'darwin')(
  'a signed build rejects a real ad-hoc app using a valid codesign certificate requirement',
  () => {
    const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-signing-'));
    const app = path.join(
      work,
      'target/release/bundle/macos/Browser Recall.app',
    );
    try {
      mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
      cpSync('/bin/echo', path.join(app, 'Contents/MacOS/fixture'));
      writeFileSync(
        path.join(app, 'Contents/Info.plist'),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.browser-recall.signing-fixture</string><key>CFBundleExecutable</key><string>fixture</string></dict></plist>',
      );
      finalizeMacosAppBundle(app, { APPLE_SIGNING_IDENTITY: '-' });
      cpSync(
        '/bin/echo',
        path.join(work, 'target/release/browser-recall-desktop'),
      );
      const previous = path.join(work, 'dist/desktop/macos/previous');
      mkdirSync(path.dirname(previous), { recursive: true });
      writeFileSync(previous, 'previous verified output');
      let verification;
      expect(() =>
        buildDesktop({
          signing: 'signed',
          platform: 'darwin',
          environment,
          root: work,
          run: (command, args) => {
            if (command === '/usr/bin/security')
              return `1) ${hash} "${identity}"\n`;
            if (command === '/usr/bin/codesign') {
              verification = spawnSync(command, args, {
                encoding: 'utf8',
              });
              if (verification.status !== 0)
                throw new Error(verification.stderr);
            }
          },
        }),
      ).toThrow(/failed to satisfy/);
      expect(verification.stderr).not.toContain('invalid requirement');
      expect(readFileSync(previous, 'utf8')).toBe('previous verified output');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test('contributor command reports missing certificate configuration without starting a build', () => {
  const env = { ...process.env };
  delete env.APPLE_SIGNING_IDENTITY;
  delete env.WINDOWS_SIGNING_CERTIFICATE;
  const result = spawnSync(
    process.execPath,
    [path.resolve('scripts/build-desktop.mjs'), 'signed'],
    { env, encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(
    process.platform === 'darwin'
      ? 'security find-identity'
      : process.platform === 'win32'
        ? 'WINDOWS_SIGNING_CERTIFICATE'
        : 'macOS and Windows only',
  );
});
