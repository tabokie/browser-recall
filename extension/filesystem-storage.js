// File System Storage using File System Access API
// Manages writing interactions to a user-selected directory

function generateSlug(timestamp, title) {
  const sanitized = (title || 'untitled')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const slug = `${timestamp}-${sanitized || 'untitled'}`;
  return slug.substring(0, 80);
}

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

      // Write content files if slug and content are provided
      if (metadata.slug && (markdown || html)) {
        const pagesDir = await this.getOrCreatePagesDirectory();

        if (markdown) {
          const mdHandle = await pagesDir.getFileHandle(`${metadata.slug}.md`, { create: true });
          const mdWritable = await mdHandle.createWritable();
          await mdWritable.write(markdown);
          await mdWritable.close();
        }

        if (html) {
          const htmlHandle = await pagesDir.getFileHandle(`${metadata.slug}.html`, { create: true });
          const htmlWritable = await htmlHandle.createWritable();
          await htmlWritable.write(html);
          await htmlWritable.close();
        }
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

      // Convert old-format interactions: generate slug, extract inline content
      const metadata = { ...interaction };
      if (!metadata.slug) {
        metadata.slug = generateSlug(metadata.timestamp, metadata.title);
      }

      // If interaction has inline content but no entry in contentMap, migrate it
      if (metadata.content && !contentMap[metadata.slug]) {
        contentMap[metadata.slug] = metadata.content;
      }
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

    // Write content files from contentMap
    for (const [slug, markdownText] of Object.entries(contentMap)) {
      if (markdownText) {
        const mdHandle = await pagesDir.getFileHandle(`${slug}.md`, { create: true });
        const mdWritable = await mdHandle.createWritable();
        await mdWritable.write(markdownText);
        await mdWritable.close();
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
    content += '- `pages/{slug}.md` - Markdown extract of page content\n';
    content += '- `pages/{slug}.html` - HTML snapshot of page content\n\n';
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

    const interactionsById = new Map();

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
            // Deduplicate by ID — last write wins
            interactionsById.set(interaction.id, interaction);
          } catch (error) {
            console.error(`Error parsing line in ${entry.name}:`, error);
          }
        }
      }
    }

    // Convert to array and sort by timestamp
    const interactions = Array.from(interactionsById.values());
    interactions.sort((a, b) => a.timestamp - b.timestamp);

    return interactions;
  }

  // Load markdown content for a single interaction by slug
  async loadContentForInteraction(slug) {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    try {
      const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');
      const fileHandle = await pagesDir.getFileHandle(`${slug}.md`);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (error) {
      return '';
    }
  }

  // Load all markdown content from pages/ directory
  async loadAllContent() {
    if (!(await this.verifyPermission())) {
      throw new Error('No permission to read directory');
    }

    const contentMap = {};

    try {
      const pagesDir = await this.directoryHandle.getDirectoryHandle('pages');

      for await (const entry of pagesDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.md')) {
          const slug = entry.name.replace(/\.md$/, '');
          const file = await entry.getFile();
          contentMap[slug] = await file.text();
        }
      }
    } catch (error) {
      // pages/ directory may not exist yet
      console.log('No pages directory found:', error.message);
    }

    return contentMap;
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

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FileSystemStorage, generateSlug };
}
