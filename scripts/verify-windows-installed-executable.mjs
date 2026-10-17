import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyWindowsInstalledExecutable(installer, executable) {
  const work = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-installer-payload-'),
  );
  try {
    // Tauri patches the NSIS payload's bundle type, then restores the raw build
    // executable. Compare against the package rather than duplicating that patch.
    execFileSync(
      '7z',
      [
        'x',
        path.resolve(installer),
        'browser-recall-desktop.exe',
        '-r',
        `-o${work}`,
        '-y',
      ],
      { stdio: 'pipe', windowsHide: true },
    );
    const candidates = readdirSync(work, {
      recursive: true,
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isFile() && entry.name === 'browser-recall-desktop.exe',
      )
      .map((entry) => path.join(entry.parentPath, entry.name));
    if (candidates.length !== 1)
      throw new Error(
        `Expected one desktop executable in the installer; found ${candidates.length}`,
      );
    const hash = (file) =>
      createHash('sha256').update(readFileSync(file)).digest('hex');
    const expected = hash(candidates[0]);
    const actual = hash(executable);
    if (actual !== expected)
      throw new Error(
        `Installed executable differs from the installer payload: expected ${expected}, got ${actual}`,
      );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [installer, executable] = process.argv.slice(2);
  if (!installer || !executable)
    throw new Error('Expected installer and installed executable paths');
  verifyWindowsInstalledExecutable(installer, executable);
  console.log('Installed executable matches the NSIS installer payload.');
}
