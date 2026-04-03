// File System Storage using File System Access API
// Manages writing history entries to a user-selected directory
import { generateSlugFromUrl } from './utils.js';
import { logError } from './logger.js';

function isNotFound(error) {
  return error?.name === 'NotFoundError';
}

class FileSystemStorage {
  #permissionGranted = false;
  #dirCache = new Map();
  #fileCache = new Map();

  constructor() {
    this.directoryHandle = null;
    this.dbName = 'PortalFS';
    this.storeName = 'handles';
  }

  // Initialize IndexedDB for storing directory handle
  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
    });
  }

  // Request user to select directory
  async selectDirectory() {
    try {
      // Request directory access
      this.directoryHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents'
      });

      this.clearCache();

      // Store handle in IndexedDB
      await this.saveDirectoryHandle();

      return {
        success: true,
        name: this.directoryHandle.name
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        return { success: false, error: 'User cancelled' };
      }
      throw error;
    }
  }

  // Save directory handle to IndexedDB
  async saveDirectoryHandle() {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(this.directoryHandle, 'directory');

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Load directory handle from IndexedDB
  async loadDirectoryHandle() {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get('directory');

      request.onsuccess = () => {
        this.directoryHandle = request.result;
        resolve(this.directoryHandle);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // Verify we still have permission to the directory
  async verifyPermission() {
    if (this.#permissionGranted) return true;

    if (!this.directoryHandle) {
      await this.loadDirectoryHandle();
    }

    if (!this.directoryHandle) {
      return false;
    }

    const options = { mode: 'readwrite' };

    // Check if permission was already granted
    if ((await this.directoryHandle.queryPermission(options)) === 'granted') {
      this.#permissionGranted = true;
      return true;
    }

    // Request permission
    if ((await this.directoryHandle.requestPermission(options)) === 'granted') {
      this.#permissionGranted = true;
      return true;
    }

    return false;
  }

  // Resolve a directory path, creating segments as needed. Results are cached.
  async resolveDir(path) {
    const cached = this.#dirCache.get(path);
    if (cached) return cached;

    const segments = path.split('/');
    let current = this.directoryHandle;
    let builtPath = '';

    for (const segment of segments) {
      builtPath = builtPath ? builtPath + '/' + segment : segment;
      const cachedSeg = this.#dirCache.get(builtPath);
      if (cachedSeg) {
        current = cachedSeg;
        continue;
      }
      current = await current.getDirectoryHandle(segment, { create: true });
      this.#dirCache.set(builtPath, current);
    }

    return current;
  }

  // Resolve a file handle by path. Results are cached; evicts on error.
  async resolveFile(path, { create = false } = {}) {
    const cached = this.#fileCache.get(path);
    if (cached) return cached;

    const lastSlash = path.lastIndexOf('/');
    let dirHandle, fileName;
    if (lastSlash === -1) {
      dirHandle = this.directoryHandle;
      fileName = path;
    } else {
      dirHandle = await this.resolveDir(path.substring(0, lastSlash));
      fileName = path.substring(lastSlash + 1);
    }

    try {
      const opts = create ? { create: true } : undefined;
      const fileHandle = await dirHandle.getFileHandle(fileName, opts);
      this.#fileCache.set(path, fileHandle);
      return fileHandle;
    } catch (e) {
      this.#fileCache.delete(path);
      throw e;
    }
  }

  // Read and parse JSON from a file handle
  async readJson(handle) {
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  }

  // Write JSON to a file handle (overwrites)
  async writeJson(handle, data) {
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  // Grant permission unconditionally (for OPFS-backed test directories
  // where queryPermission/requestPermission are not available).
  grantPermission() {
    this.#permissionGranted = true;
  }

  // Clear all cached handles and permission state
  clearCache() {
    this.#permissionGranted = false;
    this.#dirCache.clear();
    this.#fileCache.clear();
  }

  // Move a file to deleted/{subpath}/ instead of deleting it.
  // For directories, uses { recursive: true } on the copy target.
  async softDelete(parentDir, name, opts) {
    const deletedDir = await this.directoryHandle.getDirectoryHandle('deleted', { create: true });
    try {
      if (opts && opts.recursive) {
        // Directory: copy recursively into deleted/{name}/, then remove original
        const srcDir = await parentDir.getDirectoryHandle(name);
        const destDir = await deletedDir.getDirectoryHandle(name, { create: true });
        for await (const entry of srcDir.values()) {
          if (entry.kind === 'file') {
            const file = await entry.getFile();
            const fh = await destDir.getFileHandle(entry.name, { create: true });
            const w = await fh.createWritable();
            await w.write(await file.text());
            await w.close();
          }
        }
        await parentDir.removeEntry(name, { recursive: true });
      } else {
        // File: read content, write to deleted/, then remove original
        const fh = await parentDir.getFileHandle(name);
        const file = await fh.getFile();
        const content = await file.text();
        const destFh = await deletedDir.getFileHandle(name, { create: true });
        const w = await destFh.createWritable();
        await w.write(content);
        await w.close();
        await parentDir.removeEntry(name);
      }
    } catch (e) {
      // If move fails, fall through to hard delete as last resort
      try { await parentDir.removeEntry(name, opts); } catch (e2) { if (!isNotFound(e2)) throw e2; }
    }
    this.clearCache();
  }

  // Write history entry metadata to JSONL and content to pages/
  async writeHistoryEntry(entry, markdown, html) {
    try {
      if (!(await this.verifyPermission())) {
        throw new Error('No permission to write to directory');
      }

      // Write metadata to JSONL (without content field)
      const metadata = { ...entry };
      delete metadata.content;

      const date = new Date(metadata.timestamp);
      const filename = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.jsonl`;

      const fileHandle = await this.resolveFile('data/logs/' + filename, { create: true });

      const writable = await fileHandle.createWritable({ keepExistingData: true });
      const file = await fileHandle.getFile();
      await writable.seek(file.size);

      const line = JSON.stringify(metadata) + '\n';
      await writable.write(line);
      await writable.close();

      // Write content files using versioned snapshot directory structure
      if (metadata.slug && (markdown || html)) {
        await this.captureSnapshot(metadata.slug, metadata.timestamp, markdown, html);
      }

      return { success: true };
    } catch (error) {
      logError('Error writing to filesystem:', error);
      return { success: false, error: error.message };
    }
  }

  // Get directory info
  async getDirectoryInfo() {
    if (!this.directoryHandle) {
      await this.loadDirectoryHandle();
    }

    if (!this.directoryHandle) {
      return null;
    }

    const hasPermission = await this.verifyPermission();

    return {
      name: this.directoryHandle.name,
      hasPermission
    };
  }

  // Scan data/logs/<device>/ subdirectories for .jsonl files.
  // Returns [{ device, name }] — internal format used by loadHistoryFileRange.
  async _scanLogFiles({ includeSizes = false } = {}) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const logsDir = await this.resolveDir('data/logs');
    const files = [];
    for await (const entry of logsDir.values()) {
      if (entry.kind === 'directory') {
        const subDir = await logsDir.getDirectoryHandle(entry.name);
        for await (const f of subDir.values()) {
          if (f.kind === 'file' && f.name.endsWith('.jsonl')) {
            const item = { device: entry.name, name: f.name };
            if (includeSizes) {
              const file = await f.getFile();
              item.size = file.size;
            }
            files.push(item);
          }
        }
      }
    }
    return files;
  }

  // List all .jsonl filenames sorted newest-first (deduplicated across devices).
  // Returns flat string array ['YYYY-MM-DD.jsonl', ...] deduplicated across devices.
  async listHistoryFiles() {
    const all = await this._scanLogFiles();
    const unique = [...new Set(all.map(f => f.name))];
    unique.sort().reverse(); // newest-first
    return unique;
  }

  // Return { filename: totalSize } for all JSONL files, summed across devices.
  async listHistoryFileSizes() {
    const all = await this._scanLogFiles({ includeSizes: true });
    const sizes = {};
    for (const f of all) {
      sizes[f.name] = (sizes[f.name] || 0) + f.size;
    }
    return sizes;
  }

  // Load history entries from JSONL files within a date range (inclusive).
  // fromDate/toDate are YYYY-MM-DD strings.
  // Returns { entries, files } — entries in chronological order, files sorted oldest-first.
  async loadHistoryFileRange(fromDate, toDate) {
    const allFiles = await this._scanLogFiles();
    const filtered = allFiles.filter(f => {
      const dateStr = f.name.replace('.jsonl', '');
      return dateStr >= fromDate && dateStr <= toDate;
    });
    filtered.sort((a, b) => a.name.localeCompare(b.name)); // oldest-first for chronological reading
    const entries = await this._loadFromDeviceFiles(filtered);
    // Deduplicated file names for the caller
    const fileNames = [...new Set(filtered.map(f => f.name))];
    return { entries, files: fileNames };
  }

  // Read and parse .jsonl files from device-aware file list
  async _loadFromDeviceFiles(fileList) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const results = await Promise.all(fileList.map(async ({ device, name }) => {
      try {
        const path = `data/logs/${device}/${name}`;
        const fh = await this.resolveFile(path);
        const file = await fh.getFile();
        const text = await file.text();
        const fileEntries = [];
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { fileEntries.push(JSON.parse(line)); } catch {}
        }
        return fileEntries;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        return [];
      }
    }));
    return results.flat();
  }

  // Read and parse specific .jsonl files by flat name (searches all device dirs + root)
  async loadHistoryFiles(filenames) {
    const nameSet = new Set(filenames);
    const allFiles = await this._scanLogFiles();
    const matching = allFiles.filter(f => nameSet.has(f.name));
    return this._loadFromDeviceFiles(matching);
  }

  // Load all notes from notes/ directory
  async loadAllNotes() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const notesMap = {}; // pageSlug → [noteEntity, ...]

    try {
      const notesDir = await this.resolveDir('data/notes');
      for await (const entry of notesDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const file = await entry.getFile();
          const note = JSON.parse(await file.text());
          // Group by parent page slug derived from note.url
          if (note.url) {
            const pageSlug = generateSlugFromUrl(note.url);
            if (!notesMap[pageSlug]) notesMap[pageSlug] = [];
            notesMap[pageSlug].push(note);
          }
        }
      }
    } catch (error) { if (!isNotFound(error)) throw error; }

    return notesMap;
  }

  // Capture a versioned snapshot: data/snapshots/<slug>-<timestamp>.md and .html (flat files)
  async captureSnapshot(slug, timestamp, markdown, html) {
    const snapshotsDir = await this.resolveDir('data/snapshots');

    if (markdown) {
      const mdHandle = await snapshotsDir.getFileHandle(`${slug}-${timestamp}.md`, { create: true });
      const mdWritable = await mdHandle.createWritable();
      await mdWritable.write(markdown);
      await mdWritable.close();
    }

    if (html) {
      // Strip portal highlight marks — viewer reapplies from notes
      const strippedHtml = html.replace(/<mark\b[^>]*class="[^"]*portal-highlight[^"]*"[^>]*>([\s\S]*?)<\/mark>/gi, '$1');
      // Embed slug identity so viewer page can load the original page's notes
      const metaTag = `<meta name="x-portal-slug" content="${slug}">`;
      const taggedHtml = strippedHtml.replace(/<head([^>]*)>/i, `<head$1>${metaTag}`);
      const htmlHandle = await snapshotsDir.getFileHandle(`${slug}-${timestamp}.html`, { create: true });
      const htmlWritable = await htmlHandle.createWritable();
      await htmlWritable.write(taggedHtml === strippedHtml ? metaTag + strippedHtml : taggedHtml);
      await htmlWritable.close();
    }
  }

  // List all snapshots for a slug (flat files in data/snapshots/)
  async listSnapshots(slug) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const snapshots = [];

    try {
      const snapshotsDir = await this.resolveDir('data/snapshots');
      const tsSet = new Map();
      const prefix = slug + '-';

      for await (const entry of snapshotsDir.values()) {
        if (entry.kind !== 'file') continue;
        if (!entry.name.startsWith(prefix)) continue;

        const match = entry.name.slice(prefix.length).match(/^(\d+)\.(md|html)$/);
        if (!match) continue;

        const ts = parseInt(match[1], 10);
        const ext = match[2];

        if (!tsSet.has(ts)) {
          tsSet.set(ts, { timestamp: ts, hasMd: false, hasHtml: false });
        }
        tsSet.get(ts)[ext === 'md' ? 'hasMd' : 'hasHtml'] = true;
      }

      for (const snap of tsSet.values()) {
        snapshots.push(snap);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    snapshots.sort((a, b) => b.timestamp - a.timestamp);
    return snapshots;
  }

  // Get a blob URL for a snapshot file (html preferred, falls back to md)
  async getSnapshotBlobUrl(slug, timestamp) {
    const snapshotsDir = await this.resolveDir('data/snapshots');
    for (const ext of ['html', 'md']) {
      try {
        const handle = await snapshotsDir.getFileHandle(`${slug}-${timestamp}.${ext}`);
        const file = await handle.getFile();
        return URL.createObjectURL(file);
      } catch (e) { if (!isNotFound(e)) throw e; }
    }
    return null;
  }

  // Read snapshot HTML content as text
  async getSnapshotHtml(slug, timestamp) {
    const snapshotsDir = await this.resolveDir('data/snapshots');
    try {
      const handle = await snapshotsDir.getFileHandle(`${slug}-${timestamp}.html`);
      const file = await handle.getFile();
      return await file.text();
    } catch (e) { if (!isNotFound(e)) throw e; }
    return null;
  }

  // Delete a specific snapshot by slug and timestamp
  async deleteSnapshot(slug, timestamp) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to delete');
    }

    const snapshotsDir = await this.resolveDir('data/snapshots');
    try { await this.softDelete(snapshotsDir, `${slug}-${timestamp}.md`); } catch (e) { if (!isNotFound(e)) throw e; }
    try { await this.softDelete(snapshotsDir, `${slug}-${timestamp}.html`); } catch (e) { if (!isNotFound(e)) throw e; }
  }

  // Delete a page entity file from pages/{slug}.json
  async deletePage(slug) {
    const pagesDir = await this.resolveDir('pages');
    try {
      await this.softDelete(pagesDir, `${slug}.json`);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  // Load notes for a page slug from page entity's children + notes/ directory
  async loadPageNotes(slug) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const page = await this.loadPage(slug);
      if (!page || !page.childIds) return [];

      const notes = [];
      for (const childKey of page.childIds) {
        if (childKey.startsWith('note:')) {
          const noteSlug = childKey.slice(5);
          const note = await this.loadNote(noteSlug);
          if (note) notes.push(note);
        }
      }
      return notes;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  // Check if a page file exists on disk
  async pageExists(slug) {
    try {
      await this.resolveFile('pages/' + slug + '.json');
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  // Scan recent JSONL files to find slugs visited on 2+ distinct days.
  // Returns Set of slug strings.
  async checkMultiDayVisits(slugs, days) {
    const slugSet = new Set(slugs);
    const visitDays = new Map(); // slug → Set<YYYY-MM-DD>

    const historyDir = await this.resolveDir('data/logs');
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

    for await (const entry of historyDir.values()) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue;
      const dateStr = entry.name.replace('.jsonl', '');
      if (dateStr < cutoffStr) continue;

      const file = await entry.getFile();
      const text = await file.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (!item.slug || item.action) continue; // only visit entries
          if (!slugSet.has(item.slug)) continue;
          if (!visitDays.has(item.slug)) visitDays.set(item.slug, new Set());
          visitDays.get(item.slug).add(dateStr);
        } catch { /* skip malformed */ }
      }
    }

    const result = new Set();
    for (const [slug, days] of visitDays) {
      if (days.size >= 2) result.add(slug);
    }
    return result;
  }

  // Load page metadata from pages/{slug}.json
  async loadPage(slug) {
    try {
      const fileHandle = await this.resolveFile(`pages/${slug}.json`);
      return this.readJson(fileHandle);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // Load multiple pages in one call
  async loadPageBatch(slugs) {
    const result = {};
    for (const slug of slugs) {
      try {
        const fh = await this.resolveFile(`pages/${slug}.json`);
        result[slug] = await this.readJson(fh);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return result;
  }

  // Save page metadata to pages/{slug}.json
  async savePage(slug, data) {
    const fileHandle = await this.resolveFile(`pages/${slug}.json`, { create: true });
    await this.writeJson(fileHandle, data);
  }

  // Load note metadata from data/notes/{slug}.json
  async loadNote(slug) {
    try {
      const fileHandle = await this.resolveFile(`data/notes/${slug}.json`);
      return this.readJson(fileHandle);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // Save note metadata to data/notes/{slug}.json
  async saveNote(slug, data) {
    const fileHandle = await this.resolveFile(`data/notes/${slug}.json`, { create: true });
    await this.writeJson(fileHandle, data);
  }

  // Delete note by moving to deleted/ directory
  async deleteNote(slug) {
    const notesDir = await this.resolveDir('data/notes');
    await this.softDelete(notesDir, `${slug}.json`);
  }

  // Read-merge-write a list entity file: reads existing JSON, shallow-merges updates, writes back.
  async #readMergeWriteList(path, updates) {
    let existing = {};
    try {
      const fh = await this.resolveFile(path);
      const data = await this.readJson(fh);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        existing = data;
      }
    } catch (error) { if (!isNotFound(error)) throw error; }
    const fileHandle = await this.resolveFile(path, { create: true });
    await this.writeJson(fileHandle, { ...existing, ...updates });
  }

  // Resolve the file path for a list ID.
  // Filename is always the list ID itself (slug).
  #resolveListPath(listId) {
    if (listId.startsWith('system/') || listId.startsWith('index/')) {
      return `lists/${listId}.json`;
    }
    return `lists/${listId}.json`;
  }

  // Load pins for a single list.
  // Returns the pins array (unwraps self-describing entity).
  async loadListPinsById(listId) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const path = this.#resolveListPath(listId);
    try {
      const fh = await this.resolveFile(path);
      const data = await this.readJson(fh);
      return data.pins;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  // Load the full self-describing entity for a single list.
  // Returns { timestamp, id, name, pins: [...] }
  async loadListPinsEntity(listId) {
    const path = this.#resolveListPath(listId);
    try {
      const fh = await this.resolveFile(path);
      return await this.readJson(fh);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // Load all list pins from lists/{id}.json files (excluding system/ and index/)
  // Returns { listId: pinsArray } keyed by internal ID (not filename).
  async loadListPins() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const allPins = {};

    // Load user lists from lists/ — filename is the list slug
    try {
      const listsDir = await this.resolveDir('lists');
      for await (const entry of listsDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const id = entry.name.replace('.json', '');
          // Skip system, index, and special files
          if (id.startsWith('system') || id.startsWith('index')) continue;
          const file = await entry.getFile();
          const data = JSON.parse(await file.text());
          allPins[id] = data.pins;
        }
      }
    } catch (error) { if (!isNotFound(error)) throw error; }
    return allPins;
  }

  // Save pins for a single list.
  // Preserves existing metadata fields via read-merge-write.
  async saveListPinsById(listId, pins, timestamp = 0) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }
    const path = this.#resolveListPath(listId);
    await this.#readMergeWriteList(path, { timestamp, pins });
  }

  // Save list metadata (name) without touching pins.
  // Read-merge-write to preserve existing pins.
  // If name changes, the file is renamed (old deleted, new created).
  async saveListMeta(listId, meta) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }
    const path = this.#resolveListPath(listId);
    await this.#readMergeWriteList(path, meta);
  }

  // Delete a list file (from lists/{id}.json)
  async deleteListFile(listId) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }
    const path = this.#resolveListPath(listId);
    try {
      const listsDir = await this.resolveDir('lists');
      await this.softDelete(listsDir, `${listId}.json`);
      this.#fileCache.delete(path);
    } catch (error) { if (!isNotFound(error)) throw error; }
  }

  // Load metadata for all lists from lists/ files.
  // Returns [{ slug, name, pins }] — skips system/ and index/ files.
  // Filenames are always the list slug.
  async loadAllListMetadata() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const result = [];
    const parseListEntry = (slug, data) => {
      const listEntry = {
        slug,
        name: data.name || slug,
        pins: data.pins || [],
        rules: data.rules || [],
      };
      if (data.owner) listEntry.owner = data.owner;
      if (data.deleted) listEntry.deleted = true;
      if (data.timestamps) listEntry.timestamps = data.timestamps;
      return listEntry;
    };
    try {
      const listsDir = await this.resolveDir('lists');
      for await (const entry of listsDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const slug = entry.name.replace('.json', '');
          // Skip system and special files
          if (slug.startsWith('system') || slug.startsWith('index')) continue;
          const file = await entry.getFile();
          const data = JSON.parse(await file.text());
          result.push(parseListEntry(slug, data));
        }
      }
    } catch (error) { if (!isNotFound(error)) throw error; }
    return result;
  }

  // Save list pins to lists/{id}.json files
  // Preserves existing metadata in each file.
  async saveListPins(allPins) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }

    const listsDir = await this.resolveDir('lists');

    // Write each list, preserving metadata
    const activeFilenames = new Set();
    for (const [id, pins] of Object.entries(allPins)) {
      const pinsArray = Array.isArray(pins) ? pins : (pins.pins || []);
      const path = this.#resolveListPath(id);

      // Track active IDs for cleanup (only for user lists)
      if (!id.startsWith('system') && !id.startsWith('index')) {
        activeFilenames.add(id);
      }

      await this.#readMergeWriteList(path, { timestamp: 0, pins: pinsArray });
    }

    // Soft-delete orphaned files in lists/ (skip system and special files)
    for await (const entry of listsDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.json')) {
        const filename = entry.name.replace('.json', '');
        if (!filename.startsWith('system') && !filename.startsWith('index') && !activeFilenames.has(filename)) {
          await this.softDelete(listsDir, entry.name);
        }
      }
    }
  }

  // Load manifest/settings.json — returns {} if missing or unreadable
  async loadSettings() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const fileHandle = await this.resolveFile('manifest/settings.json');
      return this.readJson(fileHandle);
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
  }

  // Save manifest/settings.json
  async saveSettings(data) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write directory');
    }

    const fileHandle = await this.resolveFile('manifest/settings.json', { create: true });
    await this.writeJson(fileHandle, data);
  }

  // ─── Sync helpers ─────────────────────────────────────────────────────

  // Collect local files for sync push: device's logs (within retention) + all notes.
  // Returns [{ path, content }].
  async collectSyncFiles(deviceId, retentionDays = 7) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const files = [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

    // Logs: data/logs/<deviceId>/YYYY-MM-DD.jsonl within retention
    try {
      const deviceDir = await this.resolveDir(`data/logs/${deviceId}`);
      for await (const entry of deviceDir.values()) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue;
        const dateStr = entry.name.replace('.jsonl', '');
        if (dateStr < cutoffStr) continue;
        const file = await entry.getFile();
        files.push({ path: `data/logs/${deviceId}/${entry.name}`, content: await file.text() });
      }
    } catch (e) { if (!isNotFound(e)) throw e; }

    // Notes: data/notes/*.json (all)
    try {
      const notesDir = await this.resolveDir('data/notes');
      for await (const entry of notesDir.values()) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;
        const file = await entry.getFile();
        files.push({ path: `data/notes/${entry.name}`, content: await file.text() });
      }
    } catch (e) { if (!isNotFound(e)) throw e; }

    return files;
  }

  // Write remote files to disk (logs and notes from peers).
  // files: [{ path, content }]. Creates directories as needed.
  async writeSyncFiles(files) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write directory');
    }
    for (const { path, content } of files) {
      const fh = await this.resolveFile(path, { create: true });
      const writable = await fh.createWritable();
      await writable.write(content);
      await writable.close();
    }
  }

  // Load all log entries from remote device directories.
  // Returns [{ deviceId, entries }] — one per remote device, entries in chronological order.
  async loadRemoteLogEntries(localDeviceId) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const allFiles = await this._scanLogFiles();
    // Group by device, exclude local
    const byDevice = new Map();
    for (const { device, name } of allFiles) {
      if (device === localDeviceId) continue;
      if (!byDevice.has(device)) byDevice.set(device, []);
      byDevice.get(device).push({ device, name });
    }
    const result = [];
    for (const [deviceId, files] of byDevice) {
      files.sort((a, b) => a.name.localeCompare(b.name)); // oldest-first
      const entries = await this._loadFromDeviceFiles(files);
      if (entries.length > 0) result.push({ deviceId, entries });
    }
    return result;
  }

  // --- Sync directory methods (separate directory for cloud-synced folder) ---

  async selectSyncDirectory() {
    try {
      this.syncDirectoryHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents'
      });
      const db = await this.initDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([this.storeName], 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.put(this.syncDirectoryHandle, 'syncDirectory');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      return { success: true, name: this.syncDirectoryHandle.name };
    } catch (error) {
      if (error.name === 'AbortError') return { success: false, error: 'User cancelled' };
      throw error;
    }
  }

  async _getSyncDir() {
    if (!this.syncDirectoryHandle) {
      const db = await this.initDB();
      this.syncDirectoryHandle = await new Promise((resolve, reject) => {
        const tx = db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get('syncDirectory');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    if (!this.syncDirectoryHandle) throw new Error('No sync directory configured');
    const opts = { mode: 'readwrite' };
    if ((await this.syncDirectoryHandle.queryPermission(opts)) !== 'granted') {
      if ((await this.syncDirectoryHandle.requestPermission(opts)) !== 'granted') {
        throw new Error('Sync directory permission denied');
      }
    }
    return this.syncDirectoryHandle;
  }

  async syncFsListDeviceDirs() {
    const root = await this._getSyncDir();
    const dirs = [];
    for await (const entry of root.values()) {
      if (entry.kind === 'directory') dirs.push(entry.name);
    }
    return dirs;
  }

  async syncFsListFiles(deviceDir) {
    const root = await this._getSyncDir();
    let dir;
    try { dir = await root.getDirectoryHandle(deviceDir); } catch { return []; }
    const results = [];
    await this._syncWalkDir(dir, '', results);
    return results;
  }

  async _syncWalkDir(dirHandle, prefix, results) {
    for await (const entry of dirHandle.values()) {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'file') {
        const file = await entry.getFile();
        results.push({ path: entryPath, content: await file.text(), size: file.size });
      } else if (entry.kind === 'directory') {
        await this._syncWalkDir(entry, entryPath, results);
      }
    }
  }

  async syncFsReadFile(path) {
    const root = await this._getSyncDir();
    const segments = path.split('/');
    let current = root;
    for (let i = 0; i < segments.length - 1; i++) {
      current = await current.getDirectoryHandle(segments[i]);
    }
    const fh = await current.getFileHandle(segments[segments.length - 1]);
    const file = await fh.getFile();
    return await file.text();
  }

  async syncFsWriteFile(path, content) {
    const root = await this._getSyncDir();
    const segments = path.split('/');
    let current = root;
    for (let i = 0; i < segments.length - 1; i++) {
      current = await current.getDirectoryHandle(segments[i], { create: true });
    }
    const fh = await current.getFileHandle(segments[segments.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  }

  async syncFsEnsureDir(path) {
    const root = await this._getSyncDir();
    let current = root;
    for (const seg of path.split('/')) {
      current = await current.getDirectoryHandle(seg, { create: true });
    }
  }

  async syncFsRemoveFile(path) {
    const root = await this._getSyncDir();
    const segments = path.split('/');
    let current = root;
    for (let i = 0; i < segments.length - 1; i++) {
      current = await current.getDirectoryHandle(segments[i]);
    }
    await current.removeEntry(segments[segments.length - 1]);
  }

  // Load CURRENT file (immutable device identity, plaintext device ID)
  async loadCurrent() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const fileHandle = await this.resolveFile('CURRENT');
      const file = await fileHandle.getFile();
      const text = (await file.text()).trim();
      return text || null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // Write CURRENT file + create device log directory (first install only)
  async initDevice(deviceId) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write directory');
    }

    const fileHandle = await this.resolveFile('CURRENT', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(deviceId);
    await writable.close();
    // Pre-create log directory for this device
    await this.resolveDir(`data/logs/${deviceId}`);
  }

}

export { FileSystemStorage };
