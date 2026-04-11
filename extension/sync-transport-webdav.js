// WebDAV sync transport — stores device data on a WebDAV server.
// Each device writes to {serverUrl}/{deviceName}/data/logs/... and data/notes/...
// Uses PROPFIND, GET, PUT, MKCOL. Runs in background service worker (fetch-based).

import { hashContent } from './sync-manager.js';

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

export class WebDAVTransport {
  constructor({ url, username, password }) {
    // Ensure trailing slash on base URL.
    this._url = url.replace(/\/+$/, '') + '/';
    this._auth = 'Basic ' + btoa(`${username}:${password}`);
    // Caches populated during listBranches, consumed by getTree/getBlob.
    this._shaToDevice = new Map();
    this._treeCache = new Map();
    this._etagToPath = new Map();
  }

  async _request(method, path, { body, headers = {}, depth } = {}) {
    const url = new URL(path, this._url).href;
    const opts = {
      method,
      headers: { Authorization: this._auth, ...headers },
    };
    if (depth !== undefined) opts.headers['Depth'] = String(depth);
    if (body !== undefined) {
      if (typeof body === 'string') {
        opts.headers['Content-Type'] = 'application/xml; charset=utf-8';
      }
      opts.body = body;
    }
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, opts);
        if (resp.ok || resp.status === 207) return resp;
        const text = await resp.text().catch(() => '');
        lastError = new Error(`WebDAV ${resp.status}: ${text}`);
        if (resp.status < 500) throw lastError;
      } catch (e) {
        lastError = e;
        if (e.message.startsWith('WebDAV ') && !e.message.includes(' 5'))
          throw e;
      }
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
      }
    }
    throw lastError;
  }

  // Parse PROPFIND multistatus XML response.
  _parsePropfind(xml, basePath) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    const results = [];
    // Handle both DAV: namespace and no-namespace variants.
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    for (const resp of responses) {
      const hrefEl = resp.getElementsByTagNameNS('DAV:', 'href')[0];
      if (!hrefEl) continue;
      let href = decodeURIComponent(hrefEl.textContent.trim());
      // Strip base URL prefix to get relative path.
      const baseUrl = new URL(basePath, this._url).pathname;
      if (href.startsWith(baseUrl)) href = href.slice(baseUrl.length);
      href = href.replace(/^\/+/, '').replace(/\/+$/, '');
      const collectionEl = resp.getElementsByTagNameNS('DAV:', 'collection');
      const isCollection = collectionEl.length > 0;
      const etagEl = resp.getElementsByTagNameNS('DAV:', 'getetag')[0];
      const etag = etagEl ? etagEl.textContent.trim().replace(/"/g, '') : '';
      if (href) results.push({ href, etag, isCollection });
    }
    return results;
  }

  async _propfind(path, depth) {
    const resp = await this._request('PROPFIND', path, {
      depth,
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    });
    const xml = await resp.text();
    return this._parsePropfind(xml, path);
  }

  async listBranches() {
    this._shaToDevice.clear();
    this._treeCache.clear();
    this._etagToPath.clear();
    const entries = await this._propfind('', 1);
    const dirs = entries.filter((e) => e.isCollection && e.href);
    const branches = [];
    for (const dir of dirs) {
      const deviceName = dir.href;
      let files;
      try {
        files = await this._propfind(deviceName + '/', 'infinity');
      } catch (e) {
        // Depth infinity not supported — fall back to skipping this peer.
        if (e.message.includes('403') || e.message.includes('501')) continue;
        throw e;
      }
      const blobs = files.filter((f) => !f.isCollection && f.href);
      const meta = blobs
        .map((f) => `${f.href}:${f.etag}`)
        .sort()
        .join('\n');
      const sha = hashContent(meta);
      this._shaToDevice.set(sha, { name: deviceName, files: blobs });
      branches.push({ name: deviceName, sha });
    }
    return branches;
  }

  async getTree(sha) {
    if (this._treeCache.has(sha)) return this._treeCache.get(sha);
    const entry = this._shaToDevice.get(sha);
    if (!entry) throw new Error(`Unknown tree sha: ${sha}`);
    const tree = entry.files.map((f) => {
      // Use etag as per-file sha (changes when content changes).
      this._etagToPath.set(f.etag, `${entry.name}/${f.href}`);
      return { path: f.href, sha: f.etag };
    });
    this._treeCache.set(sha, tree);
    return tree;
  }

  async getBlob(sha) {
    const fullPath = this._etagToPath.get(sha);
    if (!fullPath) throw new Error(`Unknown blob sha: ${sha}`);
    const resp = await this._request('GET', fullPath);
    return await resp.text();
  }

  async pushTree(branch, files) {
    // Ensure device directory exists.
    try {
      await this._request('MKCOL', branch + '/');
    } catch (e) {
      if (!e.message.includes('405')) throw e; // 405 = already exists
    }
    // Collect intermediate directories to create.
    const dirsToCreate = new Set();
    for (const file of files) {
      const parts = file.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirsToCreate.add(branch + '/' + parts.slice(0, i).join('/'));
      }
    }
    // Create directories in order (shortest first).
    for (const dir of [...dirsToCreate].sort()) {
      try {
        await this._request('MKCOL', dir + '/');
      } catch (e) {
        if (!e.message.includes('405')) throw e;
      }
    }
    // Write files.
    for (const file of files) {
      await this._request('PUT', `${branch}/${file.path}`, {
        body: file.content,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }
    const combined = files
      .map((f) => `${f.path}:${f.content.length}`)
      .sort()
      .join('\n');
    return { sha: hashContent(combined) };
  }

  async createBranch(name) {
    try {
      await this._request('MKCOL', name + '/');
    } catch (e) {
      if (!e.message.includes('405')) throw e;
    }
  }

  async deleteBranch(name) {
    await this._request('DELETE', name + '/');
  }
}
