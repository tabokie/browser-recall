import http from 'node:http';
import { test, expect } from './fixtures.js';
import { getSlugForUrl, openHelperPage } from './helpers.js';

function startServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((closeResolve) => server.close(closeResolve));
        },
      }),
    );
  });
}

function stallImageResponse(response) {
  response.writeHead(200, { 'Content-Type': 'image/png' });
  response.write(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

function stallStylesheetResponse(response) {
  response.writeHead(200, { 'Content-Type': 'text/css' });
  response.write('html { background: white; }');
}

test('capture reconstructs serialized shadow DOM in the trusted snapshot viewer', async ({
  extContext,
  extensionId,
  localServer,
  setupDir,
}) => {
  void setupDir;

  localServer.addPage('/shadow-dom-snapshot', {
    title: 'Shadow DOM snapshot',
    body: `
      <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">
      <snapshot-card id="snapshot-card"></snapshot-card>
      <script>
        customElements.define('snapshot-card', class extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML =
              '<style>#shadow-copy { color: rgb(35, 87, 133); }</style>' +
              '<p id="shadow-copy">Captured shadow content</p>';
          }
        });
      </script>
    `,
  });

  const pageUrl = localServer.url('/shadow-dom-snapshot');
  let helper;
  let page;
  let viewer;
  try {
    page = await extContext.newPage();
    await page.goto(pageUrl);
    await expect
      .poll(() =>
        page
          .locator('#snapshot-card')
          .evaluate(
            (element) =>
              element.shadowRoot?.querySelector('#shadow-copy')?.textContent ??
              null,
          ),
      )
      .toBe('Captured shadow content');

    helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    await expect
      .poll(() =>
        helper.evaluate(async () => {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) return null;
          try {
            return await chrome.tabs.sendMessage(tab.id, {
              action: 'isPdfPage',
            });
          } catch {
            return null;
          }
        }),
      )
      .toEqual({ isPdf: false });

    const capture = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    expect(capture).toEqual(
      expect.objectContaining({
        success: true,
      }),
    );

    const snapshotResponse = await helper.evaluate(
      ({ slug, timestamp }) =>
        chrome.runtime.sendMessage({
          action: 'getSnapshotHtml',
          slug,
          timestamp,
        }),
      {
        slug: getSlugForUrl(pageUrl),
        timestamp: capture.timestamp,
      },
    );
    expect(snapshotResponse.success).toBe(true);
    expect(snapshotResponse.html).toContain(
      '<template data-savepage-shadowroot="">',
    );
    expect(snapshotResponse.html).toContain('Captured shadow content');
    expect(snapshotResponse.html).not.toContain('id="savepage-shadowloader"');

    viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(getSlugForUrl(pageUrl))}&ts=${capture.timestamp}`,
    );
    const frame = viewer.frameLocator('iframe');
    const card = frame.locator('#snapshot-card');
    await expect
      .poll(() =>
        card.evaluate((element) => ({
          text:
            element.shadowRoot?.querySelector('#shadow-copy')?.textContent ??
            null,
          templateCount: element.querySelectorAll(
            ':scope > template[data-savepage-shadowroot]',
          ).length,
        })),
      )
      .toEqual({
        text: 'Captured shadow content',
        templateCount: 0,
      });
    await expect(card.locator('#shadow-copy')).toHaveCSS(
      'color',
      'rgb(35, 87, 133)',
    );
  } finally {
    await Promise.all([
      helper?.close().catch(() => {}),
      page?.close().catch(() => {}),
      viewer?.close().catch(() => {}),
    ]);
  }
});

test('capture embeds nested cross-origin CSS imports through the extension fallback', async ({
  extContext,
  extensionId,
  setupDir,
}) => {
  void setupDir;
  test.setTimeout(30_000);

  const stylesheetOrigin = await startServer((request, response) => {
    if (request.url === '/page.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end(`
        @import url("/palette.css");
        #snapshot-content { display: block !important; }
      `);
      return;
    }
    if (request.url === '/palette.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end('body { background: rgb(241, 232, 214); }');
      return;
    }
    response.writeHead(404).end();
  });
  const pageOrigin = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html>
      <title>Cross-origin stylesheet snapshot</title>
      <style>@import url("http://127.0.0.1:${stylesheetOrigin.port}/page.css");</style>
      <main id="snapshot-content" style="display: none">
        Cross-origin capture remained visible
      </main>`);
  });

  let helper;
  let page;
  let viewer;
  try {
    page = await extContext.newPage();
    const pageUrl = `http://127.0.0.1:${pageOrigin.port}/`;
    await page.goto(pageUrl);
    await expect(page.locator('#snapshot-content')).toBeVisible();

    helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    await expect
      .poll(() =>
        helper.evaluate(async () => {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) return null;
          try {
            return await chrome.tabs.sendMessage(tab.id, {
              action: 'isPdfPage',
            });
          } catch {
            return null;
          }
        }),
      )
      .toEqual({ isPdf: false });

    const capture = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    expect(capture).toEqual(
      expect.objectContaining({
        success: true,
        warnings: [],
      }),
    );

    const snapshotResponse = await helper.evaluate(
      ({ slug, timestamp }) =>
        chrome.runtime.sendMessage({
          action: 'getSnapshotHtml',
          slug,
          timestamp,
        }),
      {
        slug: getSlugForUrl(pageUrl),
        timestamp: capture.timestamp,
      },
    );
    expect(snapshotResponse.success).toBe(true);
    expect(snapshotResponse.html).toContain('/*savepage-import-url=http://');
    expect(snapshotResponse.html).toContain(
      '#snapshot-content { display: block !important; }',
    );
    expect(snapshotResponse.html).toContain(
      'body { background: rgb(241, 232, 214); }',
    );
    expect(snapshotResponse.html).not.toContain(
      'data-browser-recall-unavailable-href=',
    );

    viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(getSlugForUrl(pageUrl))}&ts=${capture.timestamp}`,
    );
    const frame = viewer.frameLocator('iframe');
    await expect(frame.locator('#snapshot-content')).toBeVisible();
    await expect(frame.locator('body')).toHaveCSS(
      'background-color',
      'rgb(241, 232, 214)',
    );
  } finally {
    await Promise.all([
      helper?.close().catch(() => {}),
      page?.close().catch(() => {}),
      viewer?.close().catch(() => {}),
    ]);
    await Promise.all([pageOrigin.close(), stylesheetOrigin.close()]);
  }
});

test('capture skips resource bodies that exceed the resource time limit', async ({
  extContext,
  extensionId,
  setupDir,
}) => {
  void setupDir;
  test.setTimeout(40_000);

  const resourceRequests = {
    crossOrigin: 0,
    crossOriginDetails: [],
    sameOrigin: 0,
    sameOriginStylesheet: 0,
  };
  const crossOrigin = await startServer((request, response) => {
    resourceRequests.crossOrigin++;
    resourceRequests.crossOriginDetails.push({
      destination: request.headers['sec-fetch-dest'] || null,
      origin: request.headers.origin || null,
    });
    if (request.headers['sec-fetch-dest'] === 'image') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (request.headers.origin?.startsWith('http://127.0.0.1:')) {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    stallImageResponse(response);
  });
  const pageOrigin = await startServer((request, response) => {
    if (request.url === '/same-origin.css') {
      resourceRequests.sameOriginStylesheet++;
      stallStylesheetResponse(response);
      return;
    }
    if (request.url === '/same-origin.png') {
      resourceRequests.sameOrigin++;
      stallImageResponse(response);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html>
      <title>Stalled snapshot resources</title>
      <link rel="stylesheet" href="/same-origin.css">
      <img src="/same-origin.png">
      <img src="http://127.0.0.1:${crossOrigin.port}/cross-origin.png">`);
  });

  let helper;
  let page;
  try {
    page = await extContext.newPage();
    await page.goto(`http://127.0.0.1:${pageOrigin.port}/`, {
      waitUntil: 'domcontentloaded',
    });

    helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    await expect
      .poll(() =>
        helper.evaluate(async () => {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab) return null;
          try {
            return await chrome.tabs.sendMessage(tab.id, {
              action: 'isPdfPage',
            });
          } catch {
            return null;
          }
        }),
      )
      .toEqual({ isPdf: false });

    const capture = helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    let timeout;
    const result = await Promise.race([
      capture.then((response) => ({ response })),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), 25_000);
      }),
    ]);
    clearTimeout(timeout);

    expect(result).toEqual({
      response: expect.objectContaining({
        success: true,
        warning: expect.stringContaining('3'),
        warnings: expect.arrayContaining([
          expect.objectContaining({
            location: expect.stringContaining('/same-origin.css'),
            reason: 'maxtime',
          }),
          expect.objectContaining({
            location: expect.stringContaining('/same-origin.png'),
            reason: 'maxtime',
          }),
          expect.objectContaining({
            location: expect.stringContaining('/cross-origin.png'),
            reason: 'maxtime',
          }),
        ]),
      }),
    });
    const snapshotResponse = await helper.evaluate(
      ({ slug, timestamp }) =>
        chrome.runtime.sendMessage({
          action: 'getSnapshotHtml',
          slug,
          timestamp,
        }),
      {
        slug: getSlugForUrl(`http://127.0.0.1:${pageOrigin.port}/`),
        timestamp: result.response.timestamp,
      },
    );
    expect(snapshotResponse.success).toBe(true);
    const stalledStylesheetTag = snapshotResponse.html
      .match(/<link\b[^>]*>/gi)
      ?.find((tag) => tag.includes('same-origin.css'));
    expect(stalledStylesheetTag).toContain(
      'data-browser-recall-unavailable-href="/same-origin.css"',
    );
    expect(stalledStylesheetTag).not.toMatch(/\shref\s*=/i);
    expect(resourceRequests.sameOrigin).toBeGreaterThanOrEqual(2);
    expect(resourceRequests.sameOriginStylesheet).toBeGreaterThanOrEqual(2);
    expect(resourceRequests.crossOrigin).toBeGreaterThanOrEqual(2);
    expect(resourceRequests.crossOriginDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ destination: 'image', origin: null }),
        expect.objectContaining({
          destination: 'empty',
          origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
        }),
      ]),
    );
  } finally {
    await Promise.all([
      helper?.close().catch(() => {}),
      page?.close().catch(() => {}),
    ]);
    await Promise.all([pageOrigin.close(), crossOrigin.close()]);
  }
});
