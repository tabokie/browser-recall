import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { captureInputs } from '../../scripts/lib/documentation-freshness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const checker = path.join(root, 'scripts/check-documentation-screenshots.mjs');

test('screenshot CI checks actual files, capture provenance, and README references', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-freshness-'));
  const file = (relative) => path.join(work, relative);
  const write = (relative, content) => {
    mkdirSync(path.dirname(file(relative)), { recursive: true });
    writeFileSync(file(relative), content);
  };
  const run = (...args) =>
    spawnSync(process.execPath, [checker, work, ...args], { encoding: 'utf8' });
  const fails = (...messages) => {
    const result = run();
    expect(result.status).toBe(1);
    for (const message of messages) expect(result.stderr).toContain(message);
  };
  try {
    // A disposable source tree exercises the same CLI used by hosted CI.
    const inputs = new Set([
      'README.md',
      ...Object.keys(captureInputs(root, 'desktop')),
      ...Object.keys(captureInputs(root, 'browser')),
    ]);
    for (const name of inputs) {
      mkdirSync(path.dirname(file(name)), { recursive: true });
      cpSync(path.join(root, name), file(name));
    }
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4AAAAABJRU5ErkJggg==',
      'base64',
    );
    const sha256 = createHash('sha256').update(png).digest('hex');
    const desktop = { inputs: captureInputs(work, 'desktop'), screenshots: {} };
    const browser = { inputs: captureInputs(work, 'browser'), screenshots: {} };
    for (const [manifest, names] of [
      [
        desktop,
        [
          'timeline.png',
          'timeline-mono.png',
          'timeline-styles.png',
          'book.png',
        ],
      ],
      [browser, ['browser-popup-window.png', 'browser-note-window.png']],
    ]) {
      for (const name of names) {
        write(`docs/images/${name}`, png);
        manifest.screenshots[name] = { sha256, width: 1, height: 1 };
      }
    }
    desktop.screenshots['timeline-styles.png'].composition = {
      sources: ['timeline.png', 'timeline-mono.png'],
      sourceSha256: [sha256, sha256],
    };
    const save = () => {
      write('docs/images/capture.json', JSON.stringify(desktop));
      write('docs/images/browser-capture.json', JSON.stringify(browser));
    };
    save();
    expect(run().status).toBe(0);

    const css = 'apps/desktop/ui/shared.css';
    const originalCss = readFileSync(file(css));
    write(css, Buffer.concat([originalCss, Buffer.from('\n/* changed */')]));
    fails('desktop screenshot inputs changed', css, 'npm run docs:screenshots');
    expect(run('--images-only').status).toBe(0);
    write(css, originalCss);
    const extensionCss = 'apps/extension/extension-surface.css';
    const originalExtensionCss = readFileSync(file(extensionCss));
    write(extensionCss, '/* changed */');
    fails(
      'browser screenshot inputs changed',
      extensionCss,
      'npm run docs:screenshots:browser',
    );
    write(extensionCss, originalExtensionCss);

    write('packages/core/new-capture-input.js', 'export const changed = true;');
    fails(
      'desktop screenshot inputs changed',
      'browser screenshot inputs changed',
      'packages/core/new-capture-input.js',
    );
    rmSync(file('packages/core/new-capture-input.js'));
    renameSync(file(css), file(`${css}.renamed`));
    fails(css, `${css}.renamed`);
    renameSync(file(`${css}.renamed`), file(css));

    delete desktop.inputs;
    save();
    fails('desktop capture has no source fingerprints');
    desktop.inputs = captureInputs(work, 'desktop');
    save();
    write('docs/images/book.png', Buffer.concat([png, Buffer.from('changed')]));
    fails('Screenshot does not match capture manifest: book.png');
    expect(run('--images-only').status).toBe(1);
    write('docs/images/book.png', png);
    rmSync(file('docs/images/book.png'));
    fails('book.png');
    write('docs/images/book.png', png);
    desktop.screenshots['book.png'].height = 2;
    save();
    fails('Screenshot does not match capture manifest: book.png');
    desktop.screenshots['book.png'].height = 1;
    desktop.screenshots['timeline-styles.png'].composition.sourceSha256[0] =
      'stale';
    save();
    fails('Timeline composition is stale');
    desktop.screenshots['timeline-styles.png'].composition.sourceSha256[0] =
      sha256;
    save();
    write(
      'README.md',
      readFileSync(file('README.md'), 'utf8').replace(
        'docs/images/book.png',
        'docs/images/missing.png',
      ),
    );
    fails('README must reference');
    write('README.md', readFileSync(path.join(root, 'README.md')));
    // Backend-only and prose edits should not force manual native recapture.
    write('crates/daemon/src/ws_server.rs', '// unrelated transport change');
    write('DEVELOPMENT.md', 'Updated setup instructions');
    expect(run().status).toBe(0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
