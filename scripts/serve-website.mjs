import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/website/', import.meta.url));
const base = '/browser-recall/';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, 'http://localhost').pathname,
    );
    if (pathname === '/' || pathname === '/browser-recall') {
      response.writeHead(302, { Location: base }).end();
      return;
    }
    const file = path.resolve(
      root,
      pathname.slice(base.length) || 'index.html',
    );
    if (!pathname.startsWith(base) || !file.startsWith(root)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const content = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response
      .writeHead(error.code === 'ENOENT' ? 404 : 400)
      .end('File unavailable');
  }
}).listen(4173, '127.0.0.1', () => {
  console.log(`Browser Recall website: http://127.0.0.1:4173${base}`);
});
