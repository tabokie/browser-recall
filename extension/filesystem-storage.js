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

  // Get or create the pages/ subdirectory
  async getOrCreatePagesDirectory() {
    return await this.directoryHandle.getDirectoryHandle('pages', { create: true });
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

      const fileHandle = await this.directoryHandle.getFileHandle(filename, { create: true });

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
    const pagesDir = await this.getOrCreatePagesDirectory();

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
    for (const [date, dayInteractions] of Object.entries(byDate)) {
      const filename = `${date}.jsonl`;
      const fileHandle = await this.directoryHandle.getFileHandle(filename, { create: true });
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

  // Load all interactions from filesystem (metadata only, deduplicated)
  async loadAllInteractions() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const interactionsByUrl = new Map();

    // Read all .jsonl files
    for await (const entry of this.directoryHandle.values()) {
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

  // Load markdown content for a single interaction by slug (latest snapshot)
  async loadContentForInteraction(slug) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');
      const slugDir = await pagesDir.getDirectoryHandle(slug);
      let latestTs = 0;
      let latestContent = '';
      for await (const entry of slugDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.md')) {
          const ts = parseInt(entry.name.replace('.md', ''), 10);
          if (ts > latestTs) {
            latestTs = ts;
            const file = await entry.getFile();
            latestContent = await file.text();
          }
        }
      }
      return latestContent;
    } catch (error) {
      return '';
    }
  }

  // Load all markdown content from pages/ directory (latest snapshot per slug)
  async loadAllContent() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const contentMap = {};

    try {
      const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');

      for await (const entry of pagesDir.values()) {
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
      // pages/ directory may not exist yet
      console.log('No pages directory found:', error.message);
    }

    return contentMap;
  }

  // Load markdown content for a batch of slugs (latest snapshot per slug)
  async loadContentBatch(slugs) {
    const contentMap = {};
    try {
      const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');
      for (const slug of slugs) {
        try {
          const slugDir = await pagesDir.getDirectoryHandle(slug);
          let latestTs = 0;
          for await (const entry of slugDir.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.md')) {
              const ts = parseInt(entry.name.replace('.md', ''), 10);
              if (ts > latestTs) {
                latestTs = ts;
                const file = await entry.getFile();
                contentMap[slug] = await file.text();
              }
            }
          }
        } catch { /* slug directory doesn't exist */ }
      }
    } catch { /* pages directory doesn't exist */ }
    return contentMap;
  }

  // Load gateway domains from gateways.json
  async loadGateways() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }
    try {
      const fileHandle = await this.directoryHandle.getFileHandle('gateways.json');
      const file = await fileHandle.getFile();
      return JSON.parse(await file.text());
    } catch {
      return { watermark: 0, domains: {} };
    }
  }

  // Save gateway domains to gateways.json
  async saveGateways(data) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write directory');
    }
    const fileHandle = await this.directoryHandle.getFileHandle('gateways.json', { create: true });
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

    for await (const entry of this.directoryHandle.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
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

  // Load all highlights from pages/{slug}/highlights.json for every slug
  async loadAllHighlights() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const highlightsMap = {};

    try {
      const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');
      for await (const entry of pagesDir.values()) {
        if (entry.kind === 'directory') {
          try {
            const fh = await entry.getFileHandle('highlights.json');
            const file = await fh.getFile();
            highlightsMap[entry.name] = JSON.parse(await file.text());
          } catch { /* no highlights.json for this slug */ }
        }
      }
    } catch { /* no pages dir */ }

    return highlightsMap;
  }

  // Capture a versioned snapshot: pages/{slug}/{timestamp}.md and .html
  async captureSnapshot(slug, timestamp, markdown, html) {
    const pagesDir = await this.getOrCreatePagesDirectory();
    const slugDir = await pagesDir.getDirectoryHandle(slug, { create: true });

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
      const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');
      const slugDir = await pagesDir.getDirectoryHandle(slug);
      const tsSet = new Map();

      for await (const entry of slugDir.values()) {
        if (entry.kind !== 'file') continue;
        if (entry.name === 'highlights.json') continue;

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
      // pages/ directory or slug directory may not exist
    }

    snapshots.sort((a, b) => b.timestamp - a.timestamp);
    return snapshots;
  }

  // Delete a specific snapshot by slug and timestamp
  async deleteSnapshot(slug, timestamp) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to delete');
    }

    const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');
    const slugDir = await pagesDir.getDirectoryHandle(slug);
    try { await slugDir.removeEntry(`${timestamp}.md`); } catch (e) {}
    try { await slugDir.removeEntry(`${timestamp}.html`); } catch (e) {}
  }

  // Load highlights for a slug from pages/{slug}/highlights.json
  async loadHighlights(slug) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');
      const slugDir = await pagesDir.getDirectoryHandle(slug);
      const fileHandle = await slugDir.getFileHandle('highlights.json');
      const file = await fileHandle.getFile();
      return JSON.parse(await file.text());
    } catch (error) {
      return [];
    }
  }

  // Save highlights for a slug to pages/{slug}/highlights.json
  async saveHighlights(slug, highlights) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }

    const pagesDir = await this.getOrCreatePagesDirectory();
    const slugDir = await pagesDir.getDirectoryHandle(slug, { create: true });
    const fileHandle = await slugDir.getFileHandle('highlights.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(highlights, null, 2));
    await writable.close();
  }

  // Load a single interaction metadata by URL from JSONL files
  async loadInteractionByUrl(url) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    let match = null;

    for await (const entry of this.directoryHandle.values()) {
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

  // Load all collection pins from collections.json
  async loadCollectionPins() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const fileHandle = await this.directoryHandle.getFileHandle('collections.json');
      const file = await fileHandle.getFile();
      return JSON.parse(await file.text());
    } catch (error) {
      return {};
    }
  }

  // Save collection pins to collections.json
  async saveCollectionPins(allPins) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to write');
    }

    const fileHandle = await this.directoryHandle.getFileHandle('collections.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(allPins, null, 2));
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

  // Delete old interactions (for data retention policy)
  async deleteOldFiles(daysToKeep = 90) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to delete files');
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffTimestamp = cutoffDate.getTime();

    let deletedCount = 0;

    // Delete old JSONL files
    for await (const entry of this.directoryHandle.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.name.match(/^\d{4}-\d{2}-\d{2}\.jsonl$/)) {
        const dateStr = entry.name.replace('.jsonl', '');
        const fileDate = new Date(dateStr);

        if (fileDate < cutoffDate) {
          await this.directoryHandle.removeEntry(entry.name);
          deletedCount++;
        }
      }
    }

    // Delete old page content files (based on timestamp prefix in slug)
    try {
      const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');

      for await (const entry of pagesDir.values()) {
        if (entry.kind === 'file') {
          const match = entry.name.match(/^(\d+)-/);
          if (match) {
            const fileTimestamp = parseInt(match[1], 10);
            if (fileTimestamp < cutoffTimestamp) {
              await pagesDir.removeEntry(entry.name);
              deletedCount++;
            }
          }
        }
      }
    } catch (error) {
      // pages/ directory may not exist
    }

    return { success: true, deletedCount };
  }
}

export { FileSystemStorage };
