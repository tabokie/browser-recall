import http from 'node:http';
import { test, expect } from './fixtures.js';
import { openHelperPage } from './helpers.js';

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

test('capture skips resource bodies that exceed the resource time limit', async ({
  extContext,
  extensionId,
  setupDir,
}) => {
  void setupDir;
  test.setTimeout(25_000);

  const resourceRequests = {
    crossOrigin: 0,
    crossOriginDetails: [],
    sameOrigin: 0,
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
    if (request.url === '/same-origin.png') {
      resourceRequests.sameOrigin++;
      stallImageResponse(response);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html>
      <title>Stalled snapshot resources</title>
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
        timeout = setTimeout(() => resolve({ timedOut: true }), 12_000);
      }),
    ]);
    clearTimeout(timeout);

    expect(result).toEqual({
      response: expect.objectContaining({
        success: true,
        warning: expect.stringContaining('2'),
        warnings: expect.arrayContaining([
          expect.objectContaining({
            location: expect.stringContaining('/same-origin.png'),
            reason: 'maxtime',
          }),
          expect.objectContaining({
            location: expect.stringContaining('/cross-origin.png'),
            reason: 'fetcherr',
          }),
        ]),
      }),
    });
    expect(resourceRequests.sameOrigin).toBeGreaterThanOrEqual(2);
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
