import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const windowsScript = fileURLToPath(
  new URL('../windows-code-signing.ps1', import.meta.url),
);

export function windowsCodeSigning(
  action,
  file,
  environment,
  run = execFileSync,
) {
  return run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      windowsScript,
      action,
      ...(file ? [file] : []),
    ],
    {
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

export function desktopSigning({
  signing,
  platform,
  environment,
  run = execFileSync,
}) {
  const env = { ...environment };
  if (!['auto', 'unsigned', 'signed'].includes(signing))
    throw new Error('Signing mode must be auto, unsigned, or signed');
  if (signing !== 'auto') {
    for (const key of [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
      'APPLE_API_KEY',
      'APPLE_API_ISSUER',
      'APPLE_API_KEY_PATH',
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    ])
      delete env[key];
  }
  if (signing === 'unsigned') {
    env.APPLE_SIGNING_IDENTITY = '-';
    delete env.WINDOWS_SIGNING_CERTIFICATE;
    delete env.WINDOWS_SIGNING_TIMESTAMP_URL;
  }
  let certificate;
  if (signing === 'signed' && platform === 'darwin') {
    const identity = env.APPLE_SIGNING_IDENTITY?.trim();
    if (!identity || identity === '-')
      throw new Error(
        'build:signed requires APPLE_SIGNING_IDENTITY. List installed certificates with: security find-identity -v -p codesigning',
      );
    const identities = run(
      '/usr/bin/security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const hashes = new Set(
      [...identities.matchAll(/\b([A-Fa-f0-9]{40}) "([^"]+)"/g)]
        .filter(
          ([, hash, name]) =>
            name === identity || hash.toLowerCase() === identity.toLowerCase(),
        )
        .map(([, hash]) => hash.toUpperCase()),
    );
    if (hashes.size !== 1)
      throw new Error(
        'APPLE_SIGNING_IDENTITY must select exactly one valid installed code-signing identity. Use the certificate SHA-1 from: security find-identity -v -p codesigning',
      );
    certificate = [...hashes][0];
    env.APPLE_SIGNING_IDENTITY = certificate;
  } else if (
    platform === 'win32' &&
    (signing === 'signed' || env.WINDOWS_SIGNING_CERTIFICATE)
  ) {
    certificate = env.WINDOWS_SIGNING_CERTIFICATE?.trim().toUpperCase();
    if (!/^[A-F0-9]{40}$/.test(certificate || ''))
      throw new Error(
        'build:signed requires WINDOWS_SIGNING_CERTIFICATE: the SHA-1 thumbprint of a code-signing certificate in Cert:\\CurrentUser\\My',
      );
    env.WINDOWS_SIGNING_CERTIFICATE = certificate;
    windowsCodeSigning('check', null, env, run);
  } else if (signing === 'signed')
    throw new Error(
      'Developer certificate signing supports macOS and Windows only',
    );

  const config =
    platform === 'win32' && (certificate || signing === 'unsigned')
      ? {
          bundle: {
            windows: {
              certificateThumbprint: null,
              signCommand: certificate
                ? {
                    cmd: 'powershell.exe',
                    args: [
                      '-NoProfile',
                      '-NonInteractive',
                      '-File',
                      windowsScript,
                      'sign',
                      '%1',
                    ],
                  }
                : null,
            },
          },
        }
      : null;

  return {
    environment: env,
    config,
    signExecutable(file) {
      if (platform === 'win32' && certificate)
        windowsCodeSigning('sign', file, env, run);
    },
    verify(file) {
      if (!certificate) return;
      if (platform === 'win32') windowsCodeSigning('verify', file, env, run);
      else
        run(
          '/usr/bin/codesign',
          [
            '--verify',
            '--deep',
            '--strict',
            '-R',
            `=certificate leaf = H"${certificate}"`,
            file,
          ],
          { env, stdio: 'pipe' },
        );
    },
  };
}
