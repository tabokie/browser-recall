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
import { crc32 } from 'node:zlib';
import { expect, test } from 'vitest';
import { captureInputs } from '../../scripts/lib/documentation-freshness.mjs';
import { documentationWallpaper } from '../../scripts/lib/documentation-image-spec.mjs';

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
      'apps/desktop/src-tauri/src/main.rs',
      'apps/desktop/src-tauri/Cargo.toml',
      'apps/desktop/src-tauri/build.rs',
      'apps/desktop/src-tauri/build_support.rs',
      'apps/desktop/src-tauri/capabilities/main.json',
      'Cargo.lock',
      'Cargo.toml',
      'rust-toolchain.toml',
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
    const dimensions = {
      'timeline.png': [2080, 1400],
      'timeline-mono.png': [2080, 1400],
      'timeline-styles.png': [2080, 1400],
      'book.png': [2080, 1400],
      'browser-popup-window.png': [1760, 1028],
      'browser-note-window.png': [1760, 1028],
    };
    const image = (name, override) => {
      const bytes = Buffer.from(png);
      const [width, height] = override || dimensions[name];
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      return bytes;
    };
    const desktop = { inputs: captureInputs(work, 'desktop'), screenshots: {} };
    const browser = { inputs: captureInputs(work, 'browser'), screenshots: {} };
    for (const manifest of [desktop, browser]) {
      manifest.wallpaper = {
        ...documentationWallpaper,
        sha256: manifest.inputs[documentationWallpaper.file],
      };
    }
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
        const bytes = image(name);
        const [width, height] = dimensions[name];
        write(`docs/images/${name}`, bytes);
        manifest.screenshots[name] = {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          width,
          height,
        };
      }
    }
    desktop.screenshots['timeline-styles.png'].composition = {
      sources: ['timeline.png', 'timeline-mono.png'],
      sourceSha256: [
        desktop.screenshots['timeline.png'].sha256,
        desktop.screenshots['timeline-mono.png'].sha256,
      ],
    };
    const save = () => {
      write('docs/images/capture.json', JSON.stringify(desktop));
      write('docs/images/browser-capture.json', JSON.stringify(browser));
    };
    save();
    const storeNames = ['browser-popup-window.png', 'browser-note-window.png'];
    const store = { inputs: {}, screenshots: {} };
    const storeInputs = [
      ...storeNames.map((name) => `docs/images/${name}`),
      'scripts/export-chrome-web-store-screenshots.mjs',
      'scripts/lib/store-screenshot.swift',
      'scripts/lib/store-screenshots.mjs',
    ];
    for (const name of storeInputs.filter((name) =>
      name.startsWith('scripts/'),
    )) {
      write(name, `// disposable exporter input: ${name}`);
    }
    const saveStore = () => {
      for (const name of storeInputs) {
        store.inputs[name] = createHash('sha256')
          .update(readFileSync(file(name)))
          .digest('hex');
      }
      write('docs/images/chrome-web-store/capture.json', JSON.stringify(store));
    };
    for (const name of storeNames) {
      const bytes = readFileSync(
        path.join(root, 'docs/images/chrome-web-store', name),
      );
      write(`docs/images/chrome-web-store/${name}`, bytes);
      store.screenshots[name] = {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        width: 1280,
        height: 800,
      };
    }
    saveStore();
    const readmeImages = [
      'timeline-styles.png',
      'browser-popup-window.png',
      'browser-note-window.png',
      'book.png',
    ];
    write(
      'README.md',
      readmeImages
        .map((name) => `![Screenshot](docs/images/${name})`)
        .join('\n'),
    );
    expect(run().status).toBe(0);

    const storeImage = 'docs/images/chrome-web-store/browser-popup-window.png';
    const originalStoreImage = readFileSync(file(storeImage));
    rmSync(file(storeImage));
    fails('chrome-web-store', 'browser-popup-window.png');
    write(
      storeImage,
      Buffer.concat([originalStoreImage, Buffer.from('corrupt')]),
    );
    fails('Chrome Web Store screenshot does not match');
    expect(run('--images-only').status).toBe(1);
    write(storeImage, originalStoreImage);
    const invalidFormat = Buffer.from(originalStoreImage);
    invalidFormat[25] = 6;
    const wrongDimensions = Buffer.from(originalStoreImage);
    wrongDimensions.writeUInt32BE(1279, 16);
    // RGB PNGs can also carry transparency through a tRNS chunk.
    const transparency = Buffer.alloc(18);
    transparency.writeUInt32BE(6);
    transparency.write('tRNS', 4, 'ascii');
    transparency.writeUInt32BE(crc32(transparency.subarray(4, 14)), 14);
    const transparentRgb = Buffer.concat([
      originalStoreImage.subarray(0, 33),
      transparency,
      originalStoreImage.subarray(33),
    ]);
    for (const bytes of [invalidFormat, wrongDimensions, transparentRgb]) {
      write(storeImage, bytes);
      store.screenshots['browser-popup-window.png'].sha256 = createHash(
        'sha256',
      )
        .update(bytes)
        .digest('hex');
      saveStore();
      fails('24-bit RGB PNG');
    }
    write(storeImage, originalStoreImage);
    store.screenshots['browser-popup-window.png'].sha256 = createHash('sha256')
      .update(originalStoreImage)
      .digest('hex');
    saveStore();
    const browserImage = 'docs/images/browser-popup-window.png';
    const originalBrowserImage = readFileSync(file(browserImage));
    const changedBrowserImage = Buffer.concat([
      originalBrowserImage,
      Buffer.from('new capture'),
    ]);
    write(browserImage, changedBrowserImage);
    browser.screenshots['browser-popup-window.png'].sha256 = createHash(
      'sha256',
    )
      .update(changedBrowserImage)
      .digest('hex');
    save();
    fails('Chrome Web Store screenshot inputs changed', browserImage);
    expect(run('--images-only').status).toBe(1);
    write(browserImage, originalBrowserImage);
    browser.screenshots['browser-popup-window.png'].sha256 = createHash(
      'sha256',
    )
      .update(originalBrowserImage)
      .digest('hex');
    save();
    const exporter = 'scripts/lib/store-screenshot.swift';
    const originalExporter = readFileSync(file(exporter));
    write(exporter, 'changed conversion');
    fails('Chrome Web Store screenshot inputs changed', exporter);
    expect(run('--images-only').status).toBe(0);
    write(exporter, originalExporter);

    const originalWallpaper = readFileSync(file(documentationWallpaper.file));
    write(
      documentationWallpaper.file,
      Buffer.concat([originalWallpaper, Buffer.from('changed')]),
    );
    fails('Documentation wallpaper does not match capture manifest');
    expect(run('--images-only').status).toBe(1);
    write(documentationWallpaper.file, originalWallpaper);

    const gallery = [
      '<img src="icons/browser-recall-default.svg" alt="Browser Recall">',
      '<table><tr><td>',
      '<img src="docs/images/book.png" alt="Book">',
      ...readmeImages
        .filter((name) => name !== 'book.png')
        .map((name) => `<img alt="Screenshot" src='docs/images/${name}'>`),
      '</td></tr></table>',
    ].join('\n');
    write('README.md', gallery);
    expect(run().status).toBe(0);
    write('README.md', `${gallery}\n![Book](docs/images/book.png)`);
    fails('README must reference');
    write(
      'README.md',
      gallery.replace(
        '<img src="docs/images/book.png" alt="Book">',
        '![Book](docs/images/book.png)',
      ),
    );
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

    for (const nativeInput of [
      'apps/desktop/src-tauri/src/main.rs',
      'apps/desktop/src-tauri/Cargo.toml',
      'apps/desktop/src-tauri/build.rs',
      'apps/desktop/src-tauri/build_support.rs',
      'apps/desktop/src-tauri/capabilities/main.json',
      'Cargo.lock',
      'Cargo.toml',
      'rust-toolchain.toml',
    ]) {
      const original = readFileSync(file(nativeInput));
      write(nativeInput, Buffer.concat([original, Buffer.from('\nchanged')]));
      fails('desktop screenshot inputs changed', nativeInput);
      expect(run('--images-only').status).toBe(0);
      write(nativeInput, original);
    }

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
    write(
      'docs/images/book.png',
      Buffer.concat([image('book.png'), Buffer.from('changed')]),
    );
    fails('Screenshot does not match capture manifest: book.png');
    expect(run('--images-only').status).toBe(1);
    write('docs/images/book.png', image('book.png'));
    rmSync(file('docs/images/book.png'));
    fails('book.png');
    write('docs/images/book.png', image('book.png'));
    desktop.screenshots['book.png'].height = 1399;
    save();
    fails('Screenshot does not match capture manifest: book.png');
    desktop.screenshots['book.png'].height = 1400;
    const undersizedBook = image('book.png', [960, 620]);
    write('docs/images/book.png', undersizedBook);
    desktop.screenshots['book.png'] = {
      sha256: createHash('sha256').update(undersizedBook).digest('hex'),
      width: 960,
      height: 620,
    };
    save();
    fails('book.png must be 2080 × 1400 pixels');
    write('docs/images/book.png', image('book.png'));
    desktop.screenshots['book.png'] = {
      sha256: createHash('sha256').update(image('book.png')).digest('hex'),
      width: 2080,
      height: 1400,
    };
    desktop.screenshots['timeline-styles.png'].composition.sourceSha256[0] =
      'stale';
    save();
    fails('Timeline composition is stale');
    desktop.screenshots['timeline-styles.png'].composition.sourceSha256[0] =
      desktop.screenshots['timeline.png'].sha256;
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
