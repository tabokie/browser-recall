// File System Storage using File System Access API
// Manages writing interactions to a user-selected directory
import { generateSlugFromUrl } from './utils.js';

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

  // Write interaction metadata to JSONL and content to pages/
  async writeInteraction(interaction, markdown, html) {
    try {
      if (!(await this.verifyPermission())) {
        throw new Error('No permission to write to directory');
      }

      // Write metadata to JSONL (without content field)
      const metadata = { ...interaction };
      delete metadata.content;

      const date = new Date(metadata.timestamp);
      const filename = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.jsonl`;

      const fileHandle = await this.resolveFile('history/' + filename, { create: true });

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
      console.error('Error writing to filesystem:', error);
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

  // List all .jsonl filenames sorted newest-first
  async listInteractionFiles() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const historyDir = await this.resolveDir('history');
    const files = [];
    for await (const entry of historyDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl'))
        files.push(entry.name);
    }
    files.sort().reverse(); // YYYY-MM-DD sorts chronologically; reverse = newest first
    return files;
  }

  // Load interactions from JSONL files within a date range (inclusive).
  // fromDate/toDate are YYYY-MM-DD strings.
  // Returns { entries, files } — entries in chronological order, files sorted oldest-first.
  async loadInteractionFileRange(fromDate, toDate) {
    const allFiles = await this.listInteractionFiles(); // newest-first
    const filtered = allFiles.filter(f => {
      const dateStr = f.replace('.jsonl', '');
      return dateStr >= fromDate && dateStr <= toDate;
    });
    filtered.sort(); // oldest-first for chronological reading
    const entries = await this.loadInteractionFiles(filtered);
    return { entries, files: filtered };
  }

  // Read and parse specific .jsonl files, return raw interactions
  async loadInteractionFiles(filenames) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const interactions = [];
    for (const name of filenames) {
      try {
        const fh = await this.resolveFile('history/' + name);
        const file = await fh.getFile();
        const text = await file.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { interactions.push(JSON.parse(line)); } catch {}
        }
      } catch (error) { if (!isNotFound(error)) throw error; }
    }
    return interactions;
  }

  // Load all interactions from filesystem (metadata only, deduplicated)
  async loadAllInteractions() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const interactionsByUrl = new Map();

    // Read all .jsonl files from history/
    const historyDir = await this.resolveDir('history');
    for await (const entry of historyDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
        const file = await entry.getFile();
        const text = await file.text();

        // Parse JSONL (one JSON object per line)
        const lines = text.split('\n').filter(line => line.trim());
        for (const line of lines) {
          try {
            const interaction = JSON.parse(line);
            // Deduplicate by URL — last write wins
            interactionsByUrl.set(interaction.url, interaction);
          } catch (error) {
            console.error(`Error parsing line in ${entry.name}:`, error);
          }
        }
      }
    }

    // Convert to array and sort by timestamp
    const interactions = Array.from(interactionsByUrl.values());
    interactions.sort((a, b) => a.timestamp - b.timestamp);

    return interactions;
  }

  // Load all markdown content from pages/ directory (latest snapshot per slug)
  // Load gateway origins from lists/system/gateways.json
  async loadGateways() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    try {
      const fileHandle = await this.resolveFile('lists/system/gateways.json');
      return this.readJson(fileHandle);
    } catch (error) {
      if (isNotFound(error)) return { timestamp: 0, origins: [] };
      throw error;
    }
  }

  // Load shallow page index from lists/system/shallow-page.json
  async loadShallowPageIndex() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    try {
      const fileHandle = await this.resolveFile('lists/system/shallow-page.json');
      return this.readJson(fileHandle);
    } catch (error) {
      if (isNotFound(error)) return { timestamp: 0, index: {} };
      throw error;
    }
  }

  // Load all notes from notes/ directory
  async loadAllNotes() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const notesMap = {}; // pageSlug → [noteEntity, ...]

    try {
      const notesDir = await this.resolveDir('notes');
      for await (const entry of notesDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const file = await entry.getFile();
          const note = JSON.parse(await file.text());
          // Group by parent page slug
          for (const parentKey of (note.parentIds || [])) {
            if (parentKey.startsWith('page:')) {
              const pageSlug = parentKey.slice(5);
              if (!notesMap[pageSlug]) notesMap[pageSlug] = [];
              notesMap[pageSlug].push(note);
            }
          }
        }
      }
    } catch (error) { if (!isNotFound(error)) throw error; }

    return notesMap;
  }

  // Capture a versioned snapshot: pages/{slug}/{timestamp}.md and .html
  async captureSnapshot(slug, timestamp, markdown, html) {
    const slugDir = await this.resolveDir('pages/' + slug);

    if (markdown) {
      const mdHandle = await slugDir.getFileHandle(`${timestamp}.md`, { create: true });
      const mdWritable = await mdHandle.createWritable();
      await mdWritable.write(markdown);
      await mdWritable.close();
    }

    if (html) {
      const htmlHandle = await slugDir.getFileHandle(`${timestamp}.html`, { create: true });
      const htmlWritable = await htmlHandle.createWritable();
      await htmlWritable.write(html);
      await htmlWritable.close();
    }
  }

  // List all snapshots for a slug
  async listSnapshots(slug) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const snapshots = [];

    try {
      const pagesDir = await this.resolveDir('pages');
      const slugDir = await pagesDir.getDirectoryHandle(slug);
      const tsSet = new Map();

      for await (const entry of slugDir.values()) {
        if (entry.kind !== 'file') continue;

        const match = entry.name.match(/^(\d+)\.(md|html)$/);
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
    const pagesDir = await this.resolveDir('pages');
    const slugDir = await pagesDir.getDirectoryHandle(slug);
    for (const ext of ['html', 'md']) {
      try {
        const handle = await slugDir.getFileHandle(`${timestamp}.${ext}`);
        const file = await handle.getFile();
        return URL.createObjectURL(file);
      } catch (e) { if (!isNotFound(e)) throw e; }
    }
    return null;
  }

  // Delete a specific snapshot by slug and timestamp
  async deleteSnapshot(slug, timestamp) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to delete');
    }

    const pagesDir = await this.resolveDir('pages');
    const slugDir = await pagesDir.getDirectoryHandle(slug);
    try { await this.softDelete(slugDir, `${timestamp}.md`); } catch (e) { if (!isNotFound(e)) throw e; }
    try { await this.softDelete(slugDir, `${timestamp}.html`); } catch (e) { if (!isNotFound(e)) throw e; }
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

    const historyDir = await this.resolveDir('history');
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

  // Load note metadata from notes/{slug}.json
  async loadNote(slug) {
    try {
      const fileHandle = await this.resolveFile(`notes/${slug}.json`);
      return this.readJson(fileHandle);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // Save note metadata to notes/{slug}.json
  async saveNote(slug, data) {
    const fileHandle = await this.resolveFile(`notes/${slug}.json`, { create: true });
    await this.writeJson(fileHandle, data);
  }

  // Load a single interaction metadata by URL from JSONL files
  async loadInteractionByUrl(url) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    let match = null;

    const historyDir = await this.resolveDir('history');
    for await (const entry of historyDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
        const file = await entry.getFile();
        const text = await file.text();
        const lines = text.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const interaction = JSON.parse(line);
            if (interaction.url === url) {
              // Last write wins (same dedup logic as loadAllInteractions)
              match = interaction;
            }
          } catch (error) {}
        }
      }
    }

    return match;
  }

  // Resolve the file path for a list ID.
  // Filename is always the list ID itself (slug).
  #resolveListPath(listId) {
    if (listId === 'explore') {
      return 'lists/system/explore.json';
    }
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
  // Returns { timestamp, id, name, qbTrees, pins: [...] }
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

    // Load explore.json from lists/system/
    try {
      const fh = await this.resolveFile('lists/system/explore.json');
      const data = await this.readJson(fh);
      allPins['explore'] = data.pins;
    } catch (error) { if (!isNotFound(error)) throw error; }

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
    // Read existing entity to preserve metadata (name, query, qbTree)
    let existing = {};
    try {
      const fh = await this.resolveFile(path);
      const data = await this.readJson(fh);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        existing = data;
      }
    } catch (error) { if (!isNotFound(error)) throw error; }
    const fileHandle = await this.resolveFile(path, { create: true });
    await this.writeJson(fileHandle, { ...existing, timestamp, pins });
  }

  // Save list metadata (name, qbTrees) without touching pins.
  // Read-merge-write to preserve existing pins.
  // If name changes, the file is renamed (old deleted, new created).
  async saveListMeta(listId, meta, timestamp = 0) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }
    const path = this.#resolveListPath(listId);
    // Read-merge-write: preserve existing pins
    let existing = { timestamp: 0, pins: [] };
    try {
      const fh = await this.resolveFile(path);
      const data = await this.readJson(fh);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        existing = data;
      }
    } catch (error) { if (!isNotFound(error)) throw error; }
    const fileHandle = await this.resolveFile(path, { create: true });
    await this.writeJson(fileHandle, { ...existing, ...meta, timestamp });
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
  // Returns [{ slug, name, qbTrees, pins }] — skips explore, system/, and index/ files.
  // Filenames are always the list slug.
  async loadAllListMetadata() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const result = [];
    try {
      const listsDir = await this.resolveDir('lists');
      for await (const entry of listsDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const slug = entry.name.replace('.json', '');
          // Skip system and special files
          if (slug === 'gateways' || slug.startsWith('system') || slug.startsWith('index')) continue;
          const file = await entry.getFile();
          const data = JSON.parse(await file.text());
          result.push({
            slug,
            name: data.name || slug,
            qbTrees: data.qbTrees || [],
            pins: data.pins || [],
          });
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
      if (!id.startsWith('system') && !id.startsWith('index') && id !== 'explore') {
        activeFilenames.add(id);
      }

      let existing = {};
      try {
        const fh = await this.resolveFile(path);
        const data = await this.readJson(fh);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          existing = data;
        }
      } catch (error) { if (!isNotFound(error)) throw error; }
      const fileHandle = await this.resolveFile(path, { create: true });
      await this.writeJson(fileHandle, { ...existing, timestamp: 0, pins: pinsArray });
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

  // Load recycle bin from lists/system/recycle-bin.json
  // Returns the items array.
  async loadRecycleBin() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    try {
      const fh = await this.resolveFile('lists/system/recycle-bin.json');
      const data = await this.readJson(fh);
      return data.items;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  // Load the full recycle-bin entity (includes timestamp).
  async loadRecycleBinEntity() {
    try {
      const fh = await this.resolveFile('lists/system/recycle-bin.json');
      return await this.readJson(fh);
    } catch (error) {
      if (isNotFound(error)) return { timestamp: 0, items: [] };
      throw error;
    }
  }

  // Save recycle bin to lists/system/recycle-bin.json
  async saveRecycleBin(items, timestamp = 0) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }
    const fh = await this.resolveFile('lists/system/recycle-bin.json', { create: true });
    await this.writeJson(fh, { timestamp, items });
  }

  // Load permanent deletes from lists/system/permanent-deletes.json
  // Returns the keys array (unwraps { timestamp, keys } wrapper).
  async loadPermanentDeletes() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    try {
      const fileHandle = await this.resolveFile('lists/system/permanent-deletes.json');
      const data = await this.readJson(fileHandle);
      return data.keys;
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  // Load the raw wrapped entity for permanent deletes (includes timestamp).
  async loadPermanentDeletesEntity() {
    try {
      const fileHandle = await this.resolveFile('lists/system/permanent-deletes.json');
      return await this.readJson(fileHandle);
    } catch (error) {
      if (isNotFound(error)) return { timestamp: 0, keys: [] };
      throw error;
    }
  }

  // Save permanent deletes to lists/system/permanent-deletes.json (wrapped format)
  async savePermanentDeletes(keys, timestamp = 0) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write directory');
    }
    const fileHandle = await this.resolveFile('lists/system/permanent-deletes.json', { create: true });
    await this.writeJson(fileHandle, { timestamp, keys });
  }

  // Load settings.json — returns {} if missing or unreadable
  async loadSettings() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const fileHandle = await this.resolveFile('settings.json');
      return this.readJson(fileHandle);
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
  }

  // Save settings.json
  async saveSettings(data) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write directory');
    }

    const fileHandle = await this.resolveFile('settings.json', { create: true });
    await this.writeJson(fileHandle, data);
  }

}

export { FileSystemStorage };
