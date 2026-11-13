import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { generateSlugFromUrl } from '../packages/core/page-identity.js';
import { generateNoteSlug } from '../packages/core/utils.js';
import { documentationSeed } from './lib/documentation-seed.mjs';
import { buildSeedFiles } from './lib/seed-builder.mjs';
import { featuredPage } from '../packages/demo/collection.js';

// Refresh only the website's fictional library. Website builds stay Node-only;
// generating the sample uses the same Rust replay and paths as native captures.
const root = new URL('../', import.meta.url);
process.env.TZ = 'UTC';
const seed = documentationSeed();
const deviceId = 'my-macbook';
const url = featuredPage.url;
const sourceEvents = seed.events.filter(
  (event) => event.action === 'create_list' || event.url === url,
);
const notePaths = new Map(
  sourceEvents
    .filter((event) => event.action === 'create_note')
    .map((event) => [
      event.path,
      `objects/notes/${generateNoteSlug(event.timestamp, event.excerpt)}.json`,
    ]),
);
const events = sourceEvents.map((event) => ({
  ...event,
  ...(event.path ? { path: notePaths.get(event.path) || event.path } : {}),
  ...(event.listOwner === seed.deviceId ? { listOwner: deviceId } : {}),
  ...(event.deviceId === seed.deviceId ? { deviceId } : {}),
}));
const timestamp = Date.parse('2026-09-16T13:05:00Z');
const stem = `${generateSlugFromUrl(url)}-${timestamp}`;
const shard = createHash('sha256').update(stem).digest('hex').slice(0, 2);
const snapshotPath = `objects/snapshots/${shard}/${stem}`;
const article = events.find((event) => event.action === 'create_note');
// A deleted older highlight also gives the sample a real orphaned checkpoint.
events.push({
  action: 'delete_note',
  timestamp: timestamp - 60000,
  url,
  path: article.path,
});
events.push({
  action: 'create_snapshot',
  timestamp,
  url,
  path: snapshotPath,
  title: article.title,
});
events.sort((a, b) => a.timestamp - b.timestamp);
const files = await buildSeedFiles(events, {
  deviceId,
  baseSettings: { timestamps: {}, ...seed.settings },
  settings: seed.settings,
});
const escapeHtml = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = `# ${article.title}\n\n${url}\n\n${article.excerpt[0]}\n`;
const html = `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${escapeHtml(article.title)}</title></head>\n<body>\n<article>\n<h1>${escapeHtml(article.title)}</h1>\n<p>${escapeHtml(article.excerpt[0])}</p>\n</article>\n</body>\n</html>\n`;
const guide = readFileSync(
  new URL('crates/daemon/resources/data-AGENTS.md', root),
  'utf8',
).replaceAll('{{DEVICE_ID}}', deviceId);
const rendered = files.map((file) => ({
  path: file.path,
  text: file.lines
    ? `${file.lines.map(({ deviceId: _deviceId, ...event }) => JSON.stringify(event)).join('\n')}\n`
    : `${JSON.stringify(file.data, null, 2)}\n`,
}));
rendered.push(
  { path: 'AGENTS.md', text: guide },
  { path: `${snapshotPath}.html`, text: html },
  { path: `${snapshotPath}.md`, text },
  {
    path: 'views/manifest/replay-progress.json',
    text: `${JSON.stringify({ [deviceId]: timestamp }, null, 2)}\n`,
  },
);
const output = new URL('website/demos/finder-data.json', root);
writeFileSync(
  output,
  await format(
    JSON.stringify({
      modified: '2026-09-16',
      files: rendered.sort((a, b) => a.path.localeCompare(b.path, 'en')),
    }),
    { parser: 'json' },
  ),
);
console.log(
  `Generated ${rendered.length} sample files in ${fileURLToPath(output)}`,
);
