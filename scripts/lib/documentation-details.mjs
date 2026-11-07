import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureDocumentationWindow } from './documentation-native-capture.mjs';
import { withCleanup } from '../../tests/smoke/desktop-test-cleanup.mjs';
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
  dataDir,
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
  const call = (targetPid, ...args) =>
    execFileSync(helper, [String(targetPid), ...args], {
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
  async function snapshot(
    name,
    crop,
    cursor,
    targetPid = pid,
    captureSpec = spec,
  ) {
    call(targetPid, 'park');
    // An inactive TextEdit document has no blinking insertion caret. Keyboard
    // actions reactivate TextEdit; window capture itself never changes focus.
    if (targetPid !== pid) native('frame', '960', '720');
    const filename = path.join(work, `${name}.png`);
    await captureDocumentationWindow({
      helper,
      pid: targetPid,
      filename,
      spec: captureSpec,
    });
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
    y: Math.min(fileInput.y - 64, 720 - 260),
    width: 500,
    height: 260,
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
  imported.hold(undefined, 1);
  imported.transition({ crop: overview });
  imported.hold(undefined, 2);
  clips['bookmark-import'] = imported.frames;

  native('tap', 'exploreBtn');
  const titles = [
    'A smaller, slower web',
    'Why I still keep a personal website',
    'Library catalogue — The Creative Act',
  ];
  await waitFor('copy source pages', () =>
    titles.every((title) => native('visible-text', title) === 'true'),
  );
  const first = bounds(titles[0]);
  const sourceCrop = nativeDetailCrop({
    x: first.x - 20,
    y: first.y - 24,
    width: 540,
    height: 330,
  });
  const source = await snapshot('copy-source', overview, center('exploreBtn'));
  const copy = detailTimeline(source);
  copy.hold(source, 0.8);
  copy.transition({ crop: sourceCrop });
  for (const [index, title] of titles.entries()) {
    cursor = center(title);
    const keys = index ? '⌘ Click' : undefined;
    copy.transition({ cursor, keys }, 5);
    native('tap', title, 'window', index ? 'command' : 'none');
    copy.click({
      ...(await snapshot(`copy-selected-${index}`, sourceCrop, cursor)),
      keys,
    });
  }
  native('key', 'copy');
  const copied = await waitFor('copied page titles and URLs', () => {
    const text = native('clipboard');
    return titles.every((title) => text.includes(`${title} <https://`)) &&
      text.split('\n').length === 3
      ? text
      : false;
  });
  copy.hold({ ...copy.current(), keys: '⌘ C' }, 0.9);

  // A separate TextEdit process and a temporary file keep personal documents out
  // of the capture. The actual clipboard crosses the application boundary twice.
  const notePath = path.join(work, 'Reading notes.txt');
  writeFileSync(notePath, '');
  let editorPid;
  let editorFailure;
  try {
    editorPid = Number(
      execFileSync(helper, ['open-editor', notePath], {
        encoding: 'utf8',
        timeout: 15000,
      }).trim(),
    );
    await waitFor('temporary TextEdit window', () =>
      call(editorPid, 'dump').includes('Reading notes'),
    );
    call(editorPid, 'frame', '520', '360');
    const editorSpec = {
      layoutPoints: { width: 520, height: 360 },
      outputPixels: { width: 1200, height: 880 },
      paddingPoints: 40,
    };
    const editorCamera = nativeDetailCrop({
      x: 0,
      y: 0,
      width: 520,
      height: 360,
    });
    const textView = JSON.parse(call(editorPid, 'bounds', 'First Text View'));
    const editorCursor = nativeDetailCrop({
      x: textView.x + textView.width / 2,
      y: textView.y + textView.height / 2,
    });
    const emptyEditor = await snapshot(
      'copy-textedit-empty',
      editorCamera,
      editorCursor,
      editorPid,
      editorSpec,
    );
    copy.hold(emptyEditor, 0.6);
    call(editorPid, 'tap', 'First Text View');
    copy.click(emptyEditor);
    call(editorPid, 'editor-command', 'paste');
    await waitFor(
      'readable text pasted into TextEdit',
      () => call(editorPid, 'editor-text') === copied,
    );
    const editorText = await snapshot(
      'copy-textedit-pasted',
      editorCamera,
      editorCursor,
      editorPid,
      editorSpec,
    );
    copy.hold({ ...editorText, keys: '⌘ V', poster: true }, 2.2);
    call(editorPid, 'tap', 'First Text View');
    call(editorPid, 'editor-command', 'select-all');
    call(editorPid, 'editor-command', 'copy');
    await waitFor(
      'plain text copied back from TextEdit',
      () => native('clipboard') === copied,
    );
    call(editorPid, 'editor-command', 'save');
    await waitFor(
      'temporary reading notes saved',
      () => readFileSync(notePath, 'utf8').trim() === copied,
    );
  } catch (error) {
    editorFailure = error;
    try {
      if (editorPid)
        writeFileSync(
          path.join(work, 'copy-textedit-accessibility.txt'),
          call(editorPid, 'dump'),
        );
    } catch (diagnosticError) {
      console.error(diagnosticError.message);
    }
    throw error;
  } finally {
    await withCleanup(async () => {
      if (editorFailure) throw editorFailure;
    }, [
      () => {
        if (editorPid)
          call(editorPid, 'quit-pid', '/System/Applications/TextEdit.app');
      },
    ]);
  }

  cursor = center('createListBtn');
  const returnFrame = await snapshot('copy-return', overview, cursor);
  copy.hold(returnFrame, 0.5);
  native('click', 'createListBtn');
  await waitFor('new list name field', () =>
    native('dump').includes('List name...'),
  );
  native('set-value', 'List name...', 'Reading');
  native('key', 'enter');
  await waitFor(
    'Reading list',
    () =>
      native('dump').includes('Reading') &&
      !native('dump').includes('List name...'),
  );
  copy.click(await snapshot('copy-created-list', overview, cursor));
  cursor = center('Reading');
  copy.transition({ cursor }, 5);
  native('click', 'Reading');
  await waitFor(
    'Reading destination selected',
    () => bounds('Reading').x > 280,
  );
  const emptyList = await snapshot('copy-empty-list', overview, cursor);
  copy.click(emptyList);
  native('key', 'paste');
  await waitFor('pages pasted into Reading', () => {
    const names = JSON.parse(
      readFileSync(path.join(dataDir, 'views/manifest/list-name-to-id.json')),
    );
    const id = Object.entries(names.paths).find(([key]) =>
      key.endsWith('/Reading'),
    )?.[1];
    if (!id) return false;
    const list = JSON.parse(
      readFileSync(path.join(dataDir, 'views/lists', `${id}.json`)),
    );
    return (
      list.pins.length === 3 &&
      titles.every((title) => native('visible-text', title) === 'true')
    );
  });
  const destination = await snapshot(
    'copy-pasted',
    sourceCrop,
    center(titles[0]),
  );
  copy.hold({ ...destination, keys: '⌘ V' }, 1);
  copy.transition({ crop: overview, keys: undefined });
  copy.hold(undefined, 2);
  clips['page-copy-paste'] = copy.frames;
  return encodeDetailMedia({ kind: 'desktop', work, inputs, clips });
}
