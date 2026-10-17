import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';

export function createDesktopDiskImage(app, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const work = mkdtempSync(
    path.join(path.dirname(destination), '.disk-image-'),
  );
  try {
    const source = path.join(work, 'source');
    mkdirSync(source);
    cpSync(app, path.join(source, 'Browser Recall.app'), { recursive: true });
    symlinkSync('/Applications', path.join(source, 'Applications'));
    const image = path.join(work, 'Browser Recall.dmg');
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'create',
        '-volname',
        'Browser Recall',
        '-srcfolder',
        source,
        '-format',
        'UDZO',
        image,
      ],
      { stdio: 'pipe' },
    );
    renameSync(image, destination);
    return destination;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
