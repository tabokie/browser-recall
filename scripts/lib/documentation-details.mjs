import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureDocumentationWindow } from './documentation-native-capture.mjs';
import {
  detailTimeline,
  encodeDetailMedia,
  nativeDetailCrop,
} from './documentation-detail-media.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export async function captureDesktopDetails({
  native,
  helper,
  pid,
  work,
  inputs,
  waitFor,
}) {
  const spec = {
    layoutPoints: { width: 960, height: 720 },
    outputPixels: { width: 2080, height: 1600 },
    paddingPoints: 40,
  };
  native('frame', '960', '720');
  const bounds = (name) => JSON.parse(native('bounds', name));
  const center = (name) => {
    const rect = bounds(name);
    return nativeDetailCrop({
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
  };
  const overview = nativeDetailCrop({ x: 0, y: 0, ...spec.layoutPoints });
  const clips = {};
  async function snapshot(name, crop, cursor) {
    native('park');
    const filename = path.join(work, `${name}.png`);
    await captureDocumentationWindow({ helper, pid, filename, spec });
    return { path: filename, crop, cursor };
  }

  const bookmarkFile = path.join(work, 'bookmarks.html');
  cpSync(
    path.join(root, 'tests/fixtures/documentation-bookmarks.html'),
    bookmarkFile,
  );
  native('click', 'settingsBtn');
  native('reveal', 'bookmarkImportBtn');
  native('click', 'bookmarkImportBtn');
  native('reveal', 'bookmarkFileInput');
  native('click', 'bookmarkFileInput');
  await waitFor('bookmark file chooser', () =>
    native('dump').includes('open-panel'),
  );
  native('key', 'go-to-folder');
  await waitFor('bookmark file path field', () =>
    native('dump').includes('PathTextField'),
  );
  native('set-value', 'PathTextField', bookmarkFile);
  await waitFor('bookmark file path entered', () =>
    native('dump').includes(bookmarkFile),
  );
  native('key', 'enter');
  await waitFor('bookmark path accepted', () => {
    const tree = native('dump');
    return (
      !tree.includes('GoToWindow') &&
      tree.includes('bookmarks.html') &&
      native('enabled', 'OKButton') === 'true'
    );
  });
  native('tap', 'OKButton');
  await waitFor(
    'bookmark folder preview',
    () =>
      !native('dump').includes('open-panel') &&
      native('dump').includes('Typography') &&
      native('dump').includes('Fonts'),
  );
  native('reveal', 'importBookmarksBtn');
  const fileInput = bounds('bookmarkFileInput');
  const importCrop = nativeDetailCrop({
    x: fileInput.x - 24,
    y: Math.min(fileInput.y - 48, 720 - 232),
    width: 500,
    height: 232,
  });
  const initialImport = await snapshot(
    'import-choose',
    overview,
    center('bookmarkFileInput'),
  );
  const imported = detailTimeline(initialImport);
  imported.hold(initialImport, 0.8);
  imported.transition({ crop: importCrop });
  for (const name of ['Typography', 'Writing']) {
    const cursor = nativeDetailCrop(JSON.parse(native('checkbox-point', name)));
    imported.transition({ cursor }, 5);
    native('toggle-checkbox', name);
    const selected = await snapshot(
      `import-selected-${name.toLowerCase()}`,
      importCrop,
      cursor,
    );
    if (name === 'Writing') selected.poster = true;
    imported.click(selected);
  }
  let cursor = center('importBookmarksBtn');
  imported.transition({ cursor }, 5);
  native('tap', 'importBookmarksBtn');
  await waitFor('imported bookmark folders', () =>
    native('dump').includes('Imported 3 lists with 3 bookmarks'),
  );
  imported.click(await snapshot('import-complete', importCrop, cursor));
  cursor = center('settingsClose');
  imported.transition({ crop: overview, cursor });
  native('tap', 'settingsClose');
  await waitFor(
    'imported lists in sidebar',
    () =>
      !native('dump').includes('settingsClose') &&
      native('dump').includes('Typography'),
  );
  const list = bounds('Collapse Typography');
  const listCamera = nativeDetailCrop({
    x: 10,
    y: Math.max(0, list.y - 80),
    width: 600,
    height: 367,
  });
  imported.click(await snapshot('import-lists', overview, cursor));
  imported.transition({
    crop: listCamera,
    cursor: center('Collapse Typography'),
  });
  imported.hold(undefined, 2);
  clips['bookmark-import'] = imported.frames;

  return encodeDetailMedia({ kind: 'desktop', work, inputs, clips });
}
