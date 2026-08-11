import { readFileSync } from 'node:fs';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { tauriBuildInvocation } from '../../scripts/build-tauri-app.mjs';
import { canonicalDesktopBundles } from '../../scripts/collect-desktop-artifacts.mjs';
import { desktopBuildPlan } from '../../scripts/desktop-build-plan.mjs';
import { finalizeDesktopBuild } from '../../scripts/finalize-desktop-build.mjs';
import { encodeWindowsIco } from '../../scripts/generate-icons.mjs';

describe('Tauri build launcher', () => {
  it('keeps schema-producing plugin dependencies host-independent', () => {
    const cargoManifest = readFileSync(
      new URL('../../apps/desktop/src-tauri/Cargo.toml', import.meta.url),
      'utf8',
    );
    const commonDependencies = cargoManifest.match(
      /\[dependencies\]([\s\S]*?)(?=\n\[)/,
    )?.[1];

    expect(commonDependencies).toContain('tauri-plugin-autostart');

    const schemaDirectory = new URL(
      '../../apps/desktop/src-tauri/gen/schemas/',
      import.meta.url,
    );
    const platformSchemas = ['desktop', 'macOS', 'windows'].map((platform) =>
      readFileSync(new URL(`${platform}-schema.json`, schemaDirectory), 'utf8'),
    );
    expect(new Set(platformSchemas).size).toBe(1);

    const aclManifests = JSON.parse(
      readFileSync(new URL('acl-manifests.json', schemaDirectory), 'utf8'),
    );
    expect(aclManifests).toHaveProperty('autostart');
  });

  it('normalizes platform build and artifact policy once', () => {
    expect(desktopBuildPlan('darwin')).toEqual({
      artifactPlatform: 'macos',
      bundles: ['app'],
      finalizeMacosApp: true,
      tauriArgs: ['build', '--bundles', 'app'],
      verifyMacosApp: true,
    });
    expect(desktopBuildPlan('win32')).toEqual({
      artifactPlatform: 'windows',
      bundles: [],
      finalizeMacosApp: false,
      tauriArgs: ['build', '--no-bundle'],
      verifyMacosApp: false,
    });
    expect(Object.isFrozen(desktopBuildPlan('linux'))).toBe(true);
  });

  it('launches the JavaScript CLI with Node instead of a platform-specific npm shim', () => {
    const invocation = tauriBuildInvocation({ platform: 'darwin' });

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args.slice(1)).toEqual(['build', '--bundles', 'app']);
    expect(invocation.args[0].replaceAll('\\', '/')).toMatch(
      /\/node_modules\/@tauri-apps\/cli\/tauri\.js$/,
    );
  });

  it('builds and collects a macOS app without selecting an installer elsewhere', () => {
    expect(tauriBuildInvocation({ platform: 'darwin' }).args.slice(1)).toEqual([
      'build',
      '--bundles',
      'app',
    ]);
    expect(tauriBuildInvocation({ platform: 'win32' }).args.slice(1)).toEqual([
      'build',
      '--no-bundle',
    ]);
    expect(tauriBuildInvocation({ platform: 'linux' }).args.slice(1)).toEqual([
      'build',
      '--no-bundle',
    ]);

    expect(canonicalDesktopBundles('macos')).toEqual(['app']);
    expect(canonicalDesktopBundles('windows')).toEqual([]);
    expect(canonicalDesktopBundles('linux')).toEqual([]);
  });

  it('does not run macOS finalization or verification on Windows', () => {
    const calls = [];

    finalizeDesktopBuild({
      platform: 'win32',
      finalizeMacosApp: () => calls.push('finalize-macos'),
      collect: (options) => calls.push(['collect', options]),
      verifyMacosApp: () => calls.push('verify-macos'),
    });

    expect(calls).toEqual([
      ['collect', { bundles: [], platformName: 'windows' }],
    ]);
  });

  it('encodes PNG images into a Windows ICO resource', () => {
    const ico = encodeWindowsIco([
      { size: 16, png: Buffer.from('small') },
      { size: 256, png: Buffer.from('large') },
    ]);

    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico[6]).toBe(16);
    expect(ico[22]).toBe(0);
    expect(ico.readUInt32LE(18)).toBe(38);
    expect(ico.subarray(38).toString()).toBe('smalllarge');
  });
});
