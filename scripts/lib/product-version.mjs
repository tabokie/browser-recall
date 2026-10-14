import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));

export function validateProductVersion(version) {
  if (
    typeof version !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version.split('.').some((part) => Number(part) > 65535) ||
    version === '0.0.0'
  ) {
    throw new Error(
      'Browser Recall must use a three-part numeric version supported by browser extensions; use the prerelease input for preview releases',
    );
  }
  return version;
}

export function readProductVersion(root = defaultRoot) {
  const readJson = (file) =>
    JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  const version = validateProductVersion(readJson('package.json').version);
  for (const file of [
    'apps/desktop/package.json',
    'apps/desktop/src-tauri/tauri.conf.json',
    'apps/extension/package.json',
    'apps/extension/manifest.json',
    'apps/desktop/src-tauri/Cargo.toml',
  ]) {
    const actual = file.endsWith('.toml')
      ? readFileSync(path.join(root, file), 'utf8').match(
          /^version\s*=\s*"([^"]+)"\s*$/m,
        )?.[1]
      : readJson(file).version;
    if (actual !== version)
      throw new Error(
        `${file} version ${actual} must match Browser Recall version ${version}`,
      );
  }
  const lock = readJson('package-lock.json');
  for (const actual of [
    lock.version,
    ...['', 'apps/desktop', 'apps/extension'].map(
      (name) => lock.packages[name]?.version,
    ),
  ]) {
    if (actual !== version)
      throw new Error(
        `package-lock.json must match Browser Recall version ${version}`,
      );
  }
  const cargo = readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  if (
    cargo.match(
      /\[\[package\]\]\s+name = "browser-recall-desktop"\s+version = "([^"]+)"/,
    )?.[1] !== version
  )
    throw new Error(`Cargo.lock must match Browser Recall version ${version}`);
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(readProductVersion(process.argv[2]));
}
