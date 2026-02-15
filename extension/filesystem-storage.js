// File System Storage using File System Access API
// Manages writing interactions to a user-selected directory
import { generateSlugFromUrl } from './utils.js';

class FileSystemStorage {
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
    if (!this.directoryHandle) {
      await this.loadDirectoryHandle();
    }

    if (!this.directoryHandle) {
      return false;
    }

    const options = { mode: 'readwrite' };

    // Check if permission was already granted
    if ((await this.directoryHandle.queryPermission(options)) === 'granted') {
      return true;
    }

    // Request permission
    if ((await this.directoryHandle.requestPermission(options)) === 'granted') {
      return true;
    }

    return false;
  }

  // Get or create the atoms/ subdirectory (snapshots + per-page metadata)
  async getAtomsDir() {
    return this.directoryHandle.getDirectoryHandle('atoms', { create: true });
  }

  // Get or create the lists/ subdirectory
  async getListsDir() {
    return this.directoryHandle.getDirectoryHandle('lists', { create: true });
  }

  // Get or create the history/ subdirectory for JSONL interaction logs
  async getHistoryDir() {
    return this.directoryHandle.getDirectoryHandle('history', { create: true });
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
      try { await parentDir.removeEntry(name, opts); } catch {}
    }
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

      const historyDir = await this.getHistoryDir();
      const fileHandle = await historyDir.getFileHandle(filename, { create: true });

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

  // Write all interactions at once (for migration)
  async writeAllInteractions(interactions, contentMap) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write to directory');
    }

    contentMap = contentMap || {};
    const atomsDir = await this.getAtomsDir();

    // Group interactions by date
    const byDate = {};
    interactions.forEach(interaction => {
      const date = new Date(interaction.timestamp);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

      if (!byDate[key]) {
        byDate[key] = [];
      }

      const metadata = { ...interaction };
      delete metadata.content;
      byDate[key].push(metadata);
    });

    // Write each date's interactions
    const historyDir = await this.getHistoryDir();
    for (const [date, dayInteractions] of Object.entries(byDate)) {
      const filename = `${date}.jsonl`;
      const fileHandle = await historyDir.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();

      for (const interaction of dayInteractions) {
        const line = JSON.stringify(interaction) + '\n';
        await writable.write(line);
      }

      await writable.close();
    }

    // Write content files using versioned snapshot structure
    for (const [slug, markdownText] of Object.entries(contentMap)) {
      if (markdownText) {
        // Use a fixed migration timestamp for migrated content
        await this.captureSnapshot(slug, Date.now(), markdownText, '');
      }
    }

    // Also write a master index file
    await this.writeIndexFile(interactions);

    return { success: true, fileCount: Object.keys(byDate).length };
  }

  // Write an index/summary file in human-readable format
  async writeIndexFile(interactions) {
    const fileHandle = await this.directoryHandle.getFileHandle('README.md', { create: true });
    const writable = await fileHandle.createWritable();

    let content = '# Portal Interaction History\n\n';
    content += `Last updated: ${new Date().toISOString()}\n`;
    content += `Total interactions: ${interactions.length}\n\n`;
    content += '## Files\n\n';
    content += '- `YYYY-MM-DD.jsonl` - Daily interaction logs in JSON Lines format (metadata only)\n';
    content += '- `pages/{slug}/{timestamp}.md` - Markdown extract of page content (versioned)\n';
    content += '- `pages/{slug}/{timestamp}.html` - HTML snapshot of page content (versioned)\n';
    content += '- `pages/{slug}/highlights.json` - User highlights and notes\n\n';
    content += '## Metadata Format\n\n';
    content += '```json\n';
    content += JSON.stringify({
      id: 'timestamp-url',
      timestamp: 1234567890,
      url: 'https://example.com',
      title: 'Page Title',
      intent: 'Search query or user intent',
      attention: 'JSON string of engagement metrics',
      slug: '1234567890-page-title'
    }, null, 2);
    content += '\n```\n';

    await writable.write(content);
    await writable.close();
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
    const historyDir = await this.getHistoryDir();
    const files = [];
    for await (const entry of historyDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl'))
        files.push(entry.name);
    }
    files.sort().reverse(); // YYYY-MM-DD sorts chronologically; reverse = newest first
    return files;
  }

  // Read and parse specific .jsonl files, return raw interactions
  async loadInteractionFiles(filenames) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    const historyDir = await this.getHistoryDir();
    const interactions = [];
    for (const name of filenames) {
      try {
        const fh = await historyDir.getFileHandle(name);
        const file = await fh.getFile();
        const text = await file.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { interactions.push(JSON.parse(line)); } catch {}
        }
      } catch {}
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
    const historyDir = await this.getHistoryDir();
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
  async loadAllContent() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const contentMap = {};

    try {
      const atomsDir = await this.getAtomsDir();

      for await (const entry of atomsDir.values()) {
        if (entry.kind === 'directory') {
          const slug = entry.name;
          let latestTs = 0;
          for await (const subEntry of entry.values()) {
            if (subEntry.kind === 'file' && subEntry.name.endsWith('.md')) {
              const ts = parseInt(subEntry.name.replace('.md', ''), 10);
              if (ts > latestTs) {
                latestTs = ts;
                const file = await subEntry.getFile();
                contentMap[slug] = await file.text();
              }
            }
          }
        }
      }
    } catch (error) {
      // atoms/ directory may not exist yet
      console.log('No atoms directory found:', error.message);
    }

    return contentMap;
  }

  // Load gateway domains from lists/gateways.json
  async loadGateways() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    try {
      const listsDir = await this.getListsDir();
      const fileHandle = await listsDir.getFileHandle('gateways.json');
      const file = await fileHandle.getFile();
      return JSON.parse(await file.text());
    } catch {
      return { watermark: 0, domains: {} };
    }
  }

  // Save gateway domains to lists/gateways.json
  async saveGateways(data) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write directory');
    }
    const listsDir = await this.getListsDir();
    const fileHandle = await listsDir.getFileHandle('gateways.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  // Process gateway domains incrementally from JSONL files after a watermark timestamp
  async processGatewaysAfterWatermark(watermark, existingDomains) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const domains = { ...existingDomains };
    let newWatermark = watermark;

    const historyDir = await this.getHistoryDir();
    for await (const entry of historyDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
        // Skip files whose date is entirely before the watermark
        if (watermark > 0) {
          const dateMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
          if (dateMatch) {
            const fileEndOfDay = new Date(dateMatch[1] + 'T23:59:59.999Z').getTime();
            if (fileEndOfDay < watermark) continue;
          }
        }

        const file = await entry.getFile();
        const text = await file.text();
        const lines = text.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const interaction = JSON.parse(line);
            if (!interaction.url || !interaction.timestamp) continue;
            if (interaction.timestamp <= watermark) continue;

            if (interaction.timestamp > newWatermark) {
              newWatermark = interaction.timestamp;
            }

            const parsed = new URL(interaction.url);
            const origin = parsed.origin;
            const isRoot = parsed.pathname === '/' || parsed.pathname === '' ||
              parsed.pathname === '/index.html' || parsed.pathname === '/index.htm';
            const isSearchQuery = parsed.searchParams.has('q') ||
              parsed.searchParams.has('query') || parsed.searchParams.has('search');

            if (!domains[origin]) {
              domains[origin] = { rootUrl: null, childCount: 0, fetched: false };
            }

            const domainEntry = domains[origin];

            if (isSearchQuery) {
              domainEntry.childCount++;
            } else if (isRoot) {
              domainEntry.rootUrl = interaction.url;
            } else {
              domainEntry.childCount++;
            }
          } catch {
            // Skip invalid lines
          }
        }
      }
    }

    return { domains, newWatermark };
  }

  // Load all highlights from atoms/{slug}.json for every slug
  async loadAllHighlights() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const highlightsMap = {};

    try {
      const atomsDir = await this.getAtomsDir();
      for await (const entry of atomsDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          try {
            const file = await entry.getFile();
            const atom = JSON.parse(await file.text());
            if (atom.highlights && atom.highlights.length > 0) {
              const slug = entry.name.replace('.json', '');
              highlightsMap[slug] = atom.highlights;
            }
          } catch { /* skip malformed atom files */ }
        }
      }
    } catch { /* no atoms dir */ }

    return highlightsMap;
  }

  // Capture a versioned snapshot: atoms/{slug}/{timestamp}.md and .html
  async captureSnapshot(slug, timestamp, markdown, html) {
    const atomsDir = await this.getAtomsDir();
    const slugDir = await atomsDir.getDirectoryHandle(slug, { create: true });

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
      const atomsDir = await this.getAtomsDir();
      const slugDir = await atomsDir.getDirectoryHandle(slug);
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
      // atoms/ directory or slug directory may not exist
    }

    snapshots.sort((a, b) => b.timestamp - a.timestamp);
    return snapshots;
  }

  // Delete a specific snapshot by slug and timestamp
  async deleteSnapshot(slug, timestamp) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to delete');
    }

    const atomsDir = await this.getAtomsDir();
    const slugDir = await atomsDir.getDirectoryHandle(slug);
    try { await this.softDelete(slugDir, `${timestamp}.md`); } catch (e) {}
    try { await this.softDelete(slugDir, `${timestamp}.html`); } catch (e) {}
  }

  // Load highlights for a slug from atoms/{slug}.json
  async loadHighlights(slug) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const atom = await this.loadAtom(slug);
      return atom ? (atom.highlights || []) : [];
    } catch (error) {
      return [];
    }
  }

  // Save highlights for a slug to atoms/{slug}.json (read-modify-write)
  async saveHighlights(slug, highlights) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }

    const atom = (await this.loadAtom(slug)) || {};
    atom.highlights = highlights;
    await this.saveAtom(slug, atom);
  }

  // Load atom metadata from atoms/{slug}.json
  async loadAtom(slug) {
    try {
      const atomsDir = await this.getAtomsDir();
      const fileHandle = await atomsDir.getFileHandle(`${slug}.json`);
      const file = await fileHandle.getFile();
      return JSON.parse(await file.text());
    } catch {
      return null;
    }
  }

  // Load multiple atoms in one call
  async loadAtomBatch(slugs) {
    const atomsDir = await this.getAtomsDir();
    const result = {};
    for (const slug of slugs) {
      try {
        const fh = await atomsDir.getFileHandle(`${slug}.json`);
        const file = await fh.getFile();
        result[slug] = JSON.parse(await file.text());
      } catch { /* atom doesn't exist */ }
    }
    return result;
  }

  // Save atom metadata to atoms/{slug}.json
  async saveAtom(slug, data) {
    const atomsDir = await this.getAtomsDir();
    const fileHandle = await atomsDir.getFileHandle(`${slug}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  // Load page detail: merge atom with history entries after watermark
  // Returns { atom, interaction } where interaction has the freshest metadata
  async loadPageDetail(slug, url) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const atom = (await this.loadAtom(slug)) || { highlights: [], watermark: 0 };
    const watermark = atom.watermark || 0;

    // Scan JSONL files after watermark for this URL
    let freshInteraction = null;
    const historyDir = await this.getHistoryDir();
    for await (const entry of historyDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
        if (watermark > 0) {
          const dateMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
          if (dateMatch) {
            const fileEndOfDay = new Date(dateMatch[1] + 'T23:59:59.999Z').getTime();
            if (fileEndOfDay < watermark) continue;
          }
        }

        const file = await entry.getFile();
        const text = await file.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const interaction = JSON.parse(line);
            if (interaction.url === url && interaction.timestamp > watermark) {
              freshInteraction = interaction;
            }
          } catch {}
        }
      }
    }

    // Merge: use atom's cached metadata, overlay with fresher JSONL if available
    let interaction;
    if (freshInteraction) {
      interaction = freshInteraction;
      // Update atom with fresh metadata and advance watermark
      atom.url = interaction.url;
      atom.title = interaction.title;
      atom.attention = interaction.attention || '';
      atom.watermark = interaction.timestamp;
      await this.saveAtom(slug, atom);
    } else if (atom.url) {
      interaction = { url: atom.url, title: atom.title, attention: atom.attention || '', timestamp: atom.watermark, slug };
    } else {
      interaction = null;
    }

    return { atom, interaction };
  }

  // Load a single interaction metadata by URL from JSONL files
  async loadInteractionByUrl(url) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    let match = null;

    const historyDir = await this.getHistoryDir();
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

  // Load pins for a single collection from lists/user/{id}.json
  async loadCollectionPinsById(collectionId) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    try {
      const listsDir = await this.getListsDir();
      const userDir = await listsDir.getDirectoryHandle('user');
      const fh = await userDir.getFileHandle(`${collectionId}.json`);
      const file = await fh.getFile();
      return JSON.parse(await file.text());
    } catch {
      return [];
    }
  }

  // Load all collection pins from lists/user/{id}.json files
  async loadCollectionPins() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const allPins = {};
    try {
      const listsDir = await this.getListsDir();
      const userDir = await listsDir.getDirectoryHandle('user');
      for await (const entry of userDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          try {
            const file = await entry.getFile();
            const id = entry.name.replace('.json', '');
            allPins[id] = JSON.parse(await file.text());
          } catch { /* skip malformed files */ }
        }
      }
    } catch { /* user dir doesn't exist yet */ }
    return allPins;
  }

  // Save pins for a single collection to lists/user/{id}.json
  async saveCollectionPinsById(collectionId, pins) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }
    const listsDir = await this.getListsDir();
    const userDir = await listsDir.getDirectoryHandle('user', { create: true });
    const fileHandle = await userDir.getFileHandle(`${collectionId}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(pins, null, 2));
    await writable.close();
  }

  // Save collection pins to lists/user/{id}.json files
  async saveCollectionPins(allPins) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }

    const listsDir = await this.getListsDir();
    const userDir = await listsDir.getDirectoryHandle('user', { create: true });

    // Write each collection as a separate file
    const activeIds = new Set();
    for (const [id, pins] of Object.entries(allPins)) {
      activeIds.add(id);
      const fileHandle = await userDir.getFileHandle(`${id}.json`, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(pins, null, 2));
      await writable.close();
    }

    // Soft-delete orphaned files not in allPins
    for await (const entry of userDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.json')) {
        const id = entry.name.replace('.json', '');
        if (!activeIds.has(id)) {
          await this.softDelete(userDir, entry.name);
        }
      }
    }
  }

  // Load permanent deletes from lists/permanent-deletes.json
  async loadPermanentDeletes() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    try {
      const listsDir = await this.getListsDir();
      const fileHandle = await listsDir.getFileHandle('permanent-deletes.json');
      const file = await fileHandle.getFile();
      return JSON.parse(await file.text());
    } catch {
      return [];
    }
  }

  // Save permanent deletes to lists/permanent-deletes.json
  async savePermanentDeletes(urls) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write directory');
    }
    const listsDir = await this.getListsDir();
    const fileHandle = await listsDir.getFileHandle('permanent-deletes.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(urls, null, 2));
    await writable.close();
  }

  // Load settings.json — returns {} if missing or unreadable
  async loadSettings() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const fileHandle = await this.directoryHandle.getFileHandle('settings.json');
      const file = await fileHandle.getFile();
      return JSON.parse(await file.text());
    } catch (error) {
      return {};
    }
  }

  // Save settings.json
  async saveSettings(data) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write directory');
    }

    const fileHandle = await this.directoryHandle.getFileHandle('settings.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

}

export { FileSystemStorage };
