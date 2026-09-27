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

  const crossOrigin = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body>
      <cross-snapshot-card id="cross-snapshot-card"></cross-snapshot-card>
      <script>
        customElements.define('cross-snapshot-card', class extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = '<p id="cross-shadow-copy">Cross-origin captured shadow content</p>';
          }
        });
      </script>
    </body></html>`);
  });
  localServer.addPage('/shadow-dom-snapshot', {
    title: 'Shadow DOM snapshot',
    body: `
      <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">
      <snapshot-card id="snapshot-card"></snapshot-card>
      <closed-snapshot-card id="closed-snapshot-card"></closed-snapshot-card>
      <iframe id="nested-shadow-frame" srcdoc="<!doctype html><html><body>
        <nested-snapshot-card id='nested-snapshot-card'></nested-snapshot-card>
        <script>
          customElements.define('nested-snapshot-card', class extends HTMLElement {
            constructor() {
              super();
              const root = this.attachShadow({ mode: 'open' });
              root.innerHTML = '<p id=&quot;nested-shadow-copy&quot;>Nested captured shadow content</p>';
            }
          });
        <\/script>
      </body></html>"></iframe>
      <iframe id="cross-origin-shadow-frame" src="http://127.0.0.1:${crossOrigin.port}/"></iframe>
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
        customElements.define('closed-snapshot-card', class extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: 'closed' });
            root.innerHTML =
              '<p id="closed-shadow-copy">Captured closed shadow content</p>';
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
      '<template data-savepage-shadowroot="" shadowrootmode="open">',
    );
    expect(snapshotResponse.html).toContain('Captured shadow content');
    expect(snapshotResponse.html).toContain('Captured closed shadow content');
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
    const closedCard = frame.locator('#closed-snapshot-card');
    await expect
      .poll(() =>
        closedCard.evaluate(
          (element) =>
            element.shadowRoot?.querySelector('#closed-shadow-copy')
              ?.textContent ?? null,
        ),
      )
      .toBe('Captured closed shadow content');
    const nestedCard = frame
      .frameLocator('#nested-shadow-frame')
      .locator('#nested-snapshot-card');
    await expect
      .poll(() =>
        nestedCard.evaluate((element) => ({
          shadowText:
            element.shadowRoot?.querySelector('#nested-shadow-copy')
              ?.textContent ?? null,
          templateCount: element.querySelectorAll(
            ':scope > template[data-savepage-shadowroot]',
          ).length,
        })),
      )
      .toEqual({
        shadowText: 'Nested captured shadow content',
        templateCount: 0,
      });
    const crossOriginCard = frame
      .frameLocator('#cross-origin-shadow-frame')
      .locator('#cross-snapshot-card');
    await expect
      .poll(() =>
        crossOriginCard.evaluate((element) => ({
          shadowText:
            element.shadowRoot?.querySelector('#cross-shadow-copy')
              ?.textContent ?? null,
          templateCount: element.querySelectorAll(
            ':scope > template[data-savepage-shadowroot]',
          ).length,
        })),
      )
      .toEqual({
        shadowText: 'Cross-origin captured shadow content',
        templateCount: 0,
      });
  } finally {
    await Promise.all([
      helper?.close().catch(() => {}),
      page?.close().catch(() => {}),
      viewer?.close().catch(() => {}),
    ]);
    await crossOrigin.close();
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

test('capture preserves referrers for cross-origin stylesheets and images', async ({
  extContext,
  extensionId,
  setupDir,
}, testInfo) => {
  void setupDir;
  let pageOrigin;
  const requests = [];
  const resourceOrigin = await startServer((request, response) => {
    requests.push({ path: request.url, referrer: request.headers.referer });
    // Like Douban's image host, allow the live page but reject requests
    // without its origin. Deliberately omit CORS response headers.
    if (
      ![pageOrigin.port, resourceOrigin.port].some((port) =>
        request.headers.referer?.startsWith(`http://127.0.0.1:${port}/`),
      )
    ) {
      response.writeHead(418).end();
      return;
    }
    if (request.url === '/base.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end(
        '@import url("/layout.css"); body { color: rgb(20, 40, 60); }',
      );
    } else if (request.url === '/layout.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end(
        `#album { display: grid; grid-template-columns: 120px 1fr; gap: 24px; }
         #logo { width: 120px; height: 40px;
           background-image: url('/tile.png');
           background-image: -webkit-image-set(url('/tile.png') 1x, url('/tile.png') 2x);
           background-image: -moz-image-set(url('/tile.png') 1x, url('/tile.png') 2x);
           background-image: -o-image-set(url('/tile.png') 1x, url('/tile.png') 2x);
         }`,
      );
    } else if (request.url === '/tile.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          'base64',
        ),
      );
    } else if (request.url === '/cover.svg') {
      response.writeHead(302, { Location: '/cover-final.svg' });
      response.end();
    } else if (request.url === '/cover-final.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#237a68"/></svg>',
      );
    } else {
      response.writeHead(404).end();
    }
  });
  pageOrigin = await startServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><title>Referrer-protected album</title>
      <link rel="icon" href="data:,">
      <link rel="stylesheet" href="http://127.0.0.1:${resourceOrigin.port}/base.css">
      <div id="logo"></div>
      <main id="album"><img id="cover" src="http://127.0.0.1:${resourceOrigin.port}/cover.svg"><h1>Captured album</h1></main>`);
  });
  let helper;
  let page;
  let viewer;
  try {
    const pageUrl = `http://127.0.0.1:${pageOrigin.port}/album`;
    page = await extContext.newPage();
    await page.goto(pageUrl);
    await expect(page.locator('#album')).toHaveCSS('display', 'grid');
    await expect(page.locator('#logo')).not.toHaveCSS(
      'background-image',
      'none',
    );
    helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    await expect
      .poll(() =>
        helper.evaluate(async () => {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
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
    requests.length = 0;
    const capture = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    expect(capture).toEqual(
      expect.objectContaining({ success: true, warnings: [] }),
    );
    expect(requests).toEqual(
      expect.arrayContaining([
        { path: '/base.css', referrer: `http://127.0.0.1:${pageOrigin.port}/` },
        {
          path: '/layout.css',
          referrer: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//),
        },
        {
          path: '/cover.svg',
          referrer: `http://127.0.0.1:${pageOrigin.port}/`,
        },
        {
          path: '/cover-final.svg',
          referrer: `http://127.0.0.1:${pageOrigin.port}/`,
        },
      ]),
    );
    viewer = await extContext.newPage();
    await viewer.route(`http://127.0.0.1:${resourceOrigin.port}/**`, (route) =>
      route.abort(),
    );
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(getSlugForUrl(pageUrl))}&ts=${capture.timestamp}`,
    );
    const frame = viewer.frameLocator('iframe');
    await expect(frame.locator('#album')).toHaveCSS('display', 'grid');
    await expect(frame.locator('body')).toHaveCSS('color', 'rgb(20, 40, 60)');
    await expect(frame.locator('#logo')).not.toHaveCSS(
      'background-image',
      'none',
    );
    await expect
      .poll(() => frame.locator('#cover').evaluate((img) => img.naturalWidth))
      .toBe(120);
    await testInfo.attach('referrer-protected-snapshot', {
      body: await viewer.screenshot(),
      contentType: 'image/png',
    });
  } finally {
    await Promise.all([helper?.close(), page?.close(), viewer?.close()]);
    await Promise.all([pageOrigin.close(), resourceOrigin.close()]);
  }
});

test('snapshot resource requests isolate referrers and clean up temporary rules', async ({
  extContext,
  extensionId,
}) => {
  const server = await startServer((request, response) => {
    if (request.url === '/stall') return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ referrer: request.headers.referer || '' }));
  });
  const helper = await openHelperPage(extContext, extensionId);
  try {
    const result = await helper.evaluate(async (port) => {
      const { fetchSnapshotResource } =
        await import('./snapshot-resource-fetch.js');
      const url = `http://127.0.0.1:${port}/echo`;
      const sources = [
        'https://first.example/album?private=1#track',
        'https://second.example/album',
      ];
      const concurrent = await Promise.all(
        sources.map(async (referrer) => {
          const response = await fetchSnapshotResource(url, {
            referrer,
            referrerPolicy: 'origin',
          });
          return response.json();
        }),
      );
      const downgrade = await fetchSnapshotResource(url, {
        referrer: sources[0],
        referrerPolicy: 'strict-origin-when-cross-origin',
      }).then((response) => response.json());
      const noReferrer = await fetchSnapshotResource(url, {
        referrer: `http://127.0.0.1:${port}/private`,
        referrerPolicy: 'no-referrer',
      }).then((response) => response.json());
      let aborted;
      try {
        await fetchSnapshotResource(`http://127.0.0.1:${port}/stall`, {
          referrer: sources[0],
          referrerPolicy: 'origin',
          signal: AbortSignal.timeout(100),
        });
      } catch (error) {
        aborted = error.name;
      }
      return {
        concurrent,
        downgrade,
        noReferrer,
        aborted,
        ordinary: await fetch(url).then((response) => response.json()),
        remainingRules: await chrome.declarativeNetRequest.getSessionRules(),
      };
    }, server.port);
    expect(result).toEqual({
      concurrent: [
        { referrer: 'https://first.example/' },
        { referrer: 'https://second.example/' },
      ],
      downgrade: { referrer: '' },
      noReferrer: { referrer: '' },
      aborted: 'TimeoutError',
      ordinary: { referrer: '' },
      remainingRules: [],
    });
  } finally {
    await helper.close();
    await server.close();
  }
});

test('snapshot redirects preserve referrers without undoing stricter redirect policies', async ({
  extContext,
  extensionId,
}) => {
  const destination = await startServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ referrer: request.headers.referer || '' }));
  });
  const origin = await startServer((request, response) => {
    if (request.url === '/same') {
      response.writeHead(302, { Location: '/protected' });
    } else if (request.url === '/cross') {
      response.writeHead(307, {
        Location: `http://127.0.0.1:${destination.port}/echo`,
      });
    } else if (request.url === '/private') {
      response.writeHead(302, {
        Location: '/cross',
        'Referrer-Policy': 'no-referrer',
      });
    } else if (request.url === '/loop') {
      response.writeHead(302, { Location: '/loop' });
    } else {
      response.writeHead(request.headers.referer ? 200 : 418, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify({ referrer: request.headers.referer || '' }));
      return;
    }
    response.end();
  });
  const helper = await openHelperPage(extContext, extensionId);
  try {
    const result = await helper.evaluate(async (port) => {
      const { fetchSnapshotResource } =
        await import('./snapshot-resource-fetch.js');
      const base = `http://127.0.0.1:${port}`;
      const options = {
        referrer: `${base}/article?private=1`,
        referrerPolicy: 'strict-origin-when-cross-origin',
        signal: AbortSignal.timeout(5000),
      };
      const same = await fetchSnapshotResource(`${base}/same`, options);
      const cross = await fetchSnapshotResource(`${base}/cross`, options);
      const privateRedirect = await fetchSnapshotResource(
        `${base}/private`,
        options,
      );
      let loop;
      try {
        await fetchSnapshotResource(`${base}/loop`, options);
      } catch (error) {
        loop = error.message;
      }
      return {
        same: { status: same.status, ...(await same.json()) },
        cross: await cross.json(),
        privateRedirect: await privateRedirect.json(),
        loop,
        rules: await chrome.declarativeNetRequest.getSessionRules(),
      };
    }, origin.port);
    expect(result.same).toEqual({
      status: 200,
      referrer: `http://127.0.0.1:${origin.port}/article?private=1`,
    });
    expect(result.cross).toEqual({
      referrer: `http://127.0.0.1:${origin.port}/`,
    });
    expect(result.privateRedirect).toEqual({ referrer: '' });
    expect(result.loop).toMatch(/redirect/i);
    expect(result.rules).toEqual([]);
  } finally {
    await helper.close();
    await Promise.all([origin.close(), destination.close()]);
  }
});

test('capture bounds concurrent resource loads', async ({
  extContext,
  extensionId,
  setupDir,
}) => {
  void setupDir;
  const resourceCount = 12;
  let activeCaptureRequests = 0;
  let maxActiveCaptureRequests = 0;
  let completedCaptureRequests = 0;
  const pageOrigin = await startServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        ${Array.from(
          { length: resourceCount },
          (_, index) => `<img src="/bounded-${index}.png" alt="${index}">`,
        ).join('')}
      </body></html>`);
      return;
    }
    if (
      request.url?.startsWith('/bounded-') &&
      request.headers['sec-fetch-dest'] === 'empty'
    ) {
      activeCaptureRequests++;
      maxActiveCaptureRequests = Math.max(
        maxActiveCaptureRequests,
        activeCaptureRequests,
      );
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        activeCaptureRequests--;
        completedCaptureRequests++;
      }, 100);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  let helper;
  let page;
  try {
    page = await extContext.newPage();
    const pageUrl = `http://127.0.0.1:${pageOrigin.port}/`;
    await page.goto(pageUrl);
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
    expect(completedCaptureRequests).toBe(resourceCount);
    expect(maxActiveCaptureRequests).toBeGreaterThan(1);
    expect(maxActiveCaptureRequests).toBeLessThanOrEqual(6);
  } finally {
    await Promise.all([
      helper?.close().catch(() => {}),
      page?.close().catch(() => {}),
    ]);
    await pageOrigin.close();
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
            category: 'network',
            intentional: false,
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
