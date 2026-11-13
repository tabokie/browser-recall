import { createHash } from 'node:crypto';
import { generateSlugFromUrl } from '../../packages/core/page-identity.js';
import { generateNoteSlug } from '../../packages/core/utils.js';
import { test, expect } from './fixtures.js';

test('Finder explores production storage and previews readable files', async ({
  page,
  request,
}, testInfo) => {
  const response = await request.get('./demos/finder-data.json');
  expect(response.ok()).toBe(true);
  const { files } = await response.json();
  const paths = files.map((file) => file.path);
  const noteEvents = files
    .filter((file) => file.path.endsWith('.jsonl'))
    .flatMap((file) =>
      file.text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    )
    .filter((event) => event.action === 'create_note');
  for (const event of noteEvents) {
    expect(event.path).toBe(
      `objects/notes/${generateNoteSlug(event.timestamp, event.excerpt)}.json`,
    );
    expect(
      JSON.parse(files.find((file) => file.path === event.path).text).slug,
    ).toBe(event.path.split('/').at(-1).slice(0, -5));
  }
  const featuredNote = noteEvents.find((event) =>
    event.excerpt[0].startsWith('A personal website'),
  );
  expect(new Set(paths.map((path) => path.split('/')[0]))).toEqual(
    new Set(['AGENTS.md', 'logs', 'objects', 'views']),
  );
  expect(paths).toEqual(
    expect.arrayContaining([
      'views/manifest/list-order.json',
      'views/manifest/list-name-to-id.json',
      'views/manifest/orphaned.json',
      'views/manifest/settings.json',
      'views/manifest/replay-progress.json',
    ]),
  );
  const slug = generateSlugFromUrl('https://fieldnotes.example/a-smaller-web');
  const snapshot = files.find((file) => file.path.endsWith('.html'));
  const stem = snapshot.path.split('/').at(-1).slice(0, -5);
  expect(stem).toMatch(new RegExp(`^${slug}-\\d+$`));
  expect(snapshot.path.split('/')[2]).toBe(
    createHash('sha256').update(stem).digest('hex').slice(0, 2),
  );
  expect(paths).toContain(snapshot.path.replace(/\.html$/, '.md'));
  const pageRecord = files.find((file) => file.path.endsWith(`/${slug}.json`));
  expect(pageRecord.path.split('/')[2]).toBe(
    createHash('sha256').update(slug).digest('hex').slice(0, 2),
  );
  expect(JSON.parse(pageRecord.text).childIds).toContain(`snapshot:${stem}`);

  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  const finder = page.locator('.finder-demo');
  const row = (path) =>
    finder
      .locator('[role="treeitem"]')
      .filter({ has: page.locator(`.finder-filename[title="${path}"]`) });
  await expect(finder.getByRole('tree')).toHaveAttribute('aria-busy', 'false');
  await expect(row('logs')).toHaveAttribute('aria-expanded', 'true');
  await expect(row('logs/my-macbook')).toHaveAttribute('aria-expanded', 'true');
  await expect(row('logs/my-macbook/2026-09-16.jsonl')).toBeVisible();
  expect(JSON.stringify(files)).not.toContain('reading-desk');
  await expect(row(featuredNote.path)).toHaveAttribute('aria-selected', 'true');
  await finder.getByRole('button', { name: 'Preview selected file' }).click();
  const dialog = finder.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const note = JSON.parse(await dialog.locator('pre').textContent());
  expect(note.slug).toBe(
    generateNoteSlug(featuredNote.timestamp, featuredNote.excerpt),
  );
  expect(note.excerpt[0]).toContain(
    'A personal website can be a place to think out loud',
  );
  expect(note.cssPath).toHaveLength(note.excerpt.length);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();

  await row(snapshot.path.replace(/\.html$/, '.md')).click();
  await finder.getByRole('button', { name: 'Preview selected file' }).click();
  await expect(dialog.locator('pre')).toContainText('# A smaller, slower web');
  await dialog.screenshot({
    path: testInfo.outputPath('finder-file-preview.png'),
  });
  await dialog.getByRole('button', { name: 'Close file preview' }).click();

  await row('logs').dblclick();
  await expect(finder.locator('.finder-title')).toHaveText('logs');
  await row('logs/my-macbook').dblclick();
  await row('logs/my-macbook/2026-09-16.jsonl').click();
  await page.keyboard.press('Enter');
  const events = (await dialog.locator('pre').textContent())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.action === 'create_snapshot')).toBe(true);
  expect(events.every((event) => !Object.hasOwn(event, 'deviceId'))).toBe(true);
  await page.keyboard.press('Escape');
  await finder.getByRole('button', { name: 'Back to previous folder' }).click();
  await finder.getByRole('button', { name: 'Back to previous folder' }).click();
  await finder
    .getByRole('button', { name: 'Expand views', exact: true })
    .click();
  await finder
    .getByRole('button', { name: 'Expand manifest', exact: true })
    .click();
  await row('views/manifest/settings.json').click();
  await page.keyboard.press(' ');
  const settings = JSON.parse(await dialog.locator('pre').textContent());
  expect(settings).toMatchObject({
    theme: 'light',
    colorScheme: 'amber',
    timestamps: {},
  });
  await page.keyboard.press('Escape');
  await expect(
    finder.getByRole('button', { name: 'Forward to next folder' }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});

test('Finder supports keyboard navigation and narrow screens', async ({
  page,
}, testInfo) => {
  const viewport = page.viewportSize();
  for (const width of [...new Set([viewport.width, 375, 320])]) {
    await page.setViewportSize({ ...viewport, width });
    await page.goto('./');
    const finder = page.locator('.finder-demo');
    await expect(finder.getByRole('tree')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const selected = finder.locator('[role="treeitem"][aria-selected="true"]');
    const notePath = await selected.getAttribute('data-path');
    expect(notePath).toMatch(/^objects\/notes\/\d{6}-[a-z0-9-]+\.json$/);
    await selected.click();
    await page.keyboard.press('ArrowLeft');
    await expect(selected).toHaveAttribute('data-path', 'objects/notes');
    await page.keyboard.press('ArrowLeft');
    await expect(selected).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(selected).toHaveAttribute('data-path', notePath);
    await page.keyboard.press(' ');
    await expect(finder.getByRole('dialog')).toBeVisible();
    const bounds = await finder.getByRole('dialog').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(selected).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await finder.screenshot({
      path: testInfo.outputPath(`finder-${width}.png`),
    });
  }
});
