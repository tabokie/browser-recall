import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export function prepareCiRelease({ root, directory, environmentFile }) {
  const configPath = path.join(root, 'apps/desktop/src-tauri/tauri.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (typeof config.plugins?.updater?.pubkey !== 'string')
    throw new Error('Desktop updater public key is missing');
  mkdirSync(directory, { recursive: true });
  const key = path.join(directory, 'updater.key');
  // Capture signer output: neither generated private keys nor passwords belong
  // in CI logs. The disposable checkout embeds the matching temporary public key.
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules/@tauri-apps/cli/tauri.js'),
        'signer',
        'generate',
        '--ci',
        '-p',
        '',
        '-w',
        key,
      ],
      { stdio: 'pipe' },
    );
  } catch {
    throw new Error('Generating the disposable CI signing key failed');
  }
  config.plugins.updater.pubkey = readFileSync(`${key}.pub`, 'utf8').trim();
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  appendFileSync(
    environmentFile,
    `TAURI_SIGNING_PRIVATE_KEY=${key}\nTAURI_SIGNING_PRIVATE_KEY_PASSWORD=\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    !process.env.RUNNER_TEMP ||
    !process.env.GITHUB_ENV
  )
    throw new Error(
      'CI release preparation requires a disposable GitHub Actions checkout',
    );
  prepareCiRelease({
    root: repoRoot,
    directory: path.join(process.env.RUNNER_TEMP, 'browser-recall-ci-signing'),
    environmentFile: process.env.GITHUB_ENV,
  });
}
