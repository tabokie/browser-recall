// Filesystem sync transport — stores device data in a shared cloud-synced folder.
// Each device writes to {syncDir}/{deviceName}/data/logs/... and data/notes/...
// All I/O goes through injected callbacks (wired to offscreen in background.js).

import { hashContent } from './sync-manager.js';

export class FilesystemTransport {
  constructor({ listDeviceDirs, listFiles, readFile, writeFile, ensureDir, removeFile }) {
    this._listDeviceDirs = listDeviceDirs;
    this._listFiles = listFiles;
    this._readFile = readFile;
    this._writeFile = writeFile;
    this._ensureDir = ensureDir;
    this._removeFile = removeFile;
    // Caches populated during listBranches/getTree, consumed by getTree/getBlob.
    this._shaToDevice = new Map();
    this._blobCache = new Map();
    this._treeCache = new Map();
  }

  // List device subdirectories. Compute a metadata hash per device as the change token.
  async listBranches() {
    this._shaToDevice.clear();
    this._treeCache.clear();
    this._blobCache.clear();
    const dirs = await this._listDeviceDirs();
    const branches = [];
    for (const name of dirs) {
      const files = await this._listFiles(name);
      // Hash sorted paths + sizes as a lightweight change token.
      const meta = files
        .map(f => `${f.path}:${f.size}`)
        .sort()
        .join('\n');
      const sha = hashContent(meta);
      this._shaToDevice.set(sha, { name, files });
      branches.push({ name, sha });
    }
    return branches;
  }

  // Return file listing with per-file content hashes.
  async getTree(sha) {
    if (this._treeCache.has(sha)) return this._treeCache.get(sha);
    const entry = this._shaToDevice.get(sha);
    if (!entry) throw new Error(`Unknown tree sha: ${sha}`);
    const tree = [];
    for (const f of entry.files) {
      const content = f.content ?? await this._readFile(`${entry.name}/${f.path}`);
      const fileSha = hashContent(content);
      this._blobCache.set(fileSha, content);
      tree.push({ path: f.path, sha: fileSha });
    }
    this._treeCache.set(sha, tree);
    return tree;
  }

  async getBlob(sha) {
    const content = this._blobCache.get(sha);
    if (content === undefined) throw new Error(`Unknown blob sha: ${sha}`);
    return content;
  }

  // Write full file snapshot to device subdirectory.
  async pushTree(branch, files) {
    await this._ensureDir(branch);
    const writtenPaths = new Set();
    for (const file of files) {
      await this._writeFile(`${branch}/${file.path}`, file.content);
      writtenPaths.add(file.path);
    }
    // Remove stale files not in the new snapshot.
    let existing;
    try {
      existing = await this._listFiles(branch);
    } catch {
      existing = [];
    }
    for (const f of existing) {
      if (!writtenPaths.has(f.path)) {
        try { await this._removeFile(`${branch}/${f.path}`); } catch { /* best-effort */ }
      }
    }
    const combined = files.map(f => `${f.path}:${f.content.length}`).sort().join('\n');
    return { sha: hashContent(combined) };
  }

  async createBranch(name) {
    await this._ensureDir(name);
  }

  async deleteBranch(name) {
    let files;
    try {
      files = await this._listFiles(name);
    } catch { return; }
    for (const f of files) {
      try { await this._removeFile(`${name}/${f.path}`); } catch { /* best-effort */ }
    }
  }
}
