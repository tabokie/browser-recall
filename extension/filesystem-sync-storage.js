// Sync directory storage — manages the separate cloud-synced folder handle.
// Delegates main-handle sync operations (collectSyncFiles, writeSyncFiles,
// loadRemoteLogEntries) to the main FileSystemStorage instance.

export class FileSystemSyncStorage {
  constructor(mainStorage) {
    this.mainStorage = mainStorage;
    this.syncDirectoryHandle = null;
    this.dbName = 'PortalFS';
    this.storeName = 'handles';
  }

  // --- Delegating methods (use main data directory) ---

  async collectSyncFiles(deviceId, retentionDays) {
    return this.mainStorage.collectSyncFiles(deviceId, retentionDays);
  }

  async writeSyncFiles(files) {
    return this.mainStorage.writeSyncFiles(files);
  }

  async loadRemoteLogEntries(localDeviceId) {
    return this.mainStorage.loadRemoteLogEntries(localDeviceId);
  }

  // --- Sync directory handle methods ---

  async selectSyncDirectory() {
    try {
      this.syncDirectoryHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents',
      });
      const db = await this.mainStorage.initDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([this.storeName], 'readwrite');
        const store = tx.objectStore(this.storeName);
        const req = store.put(this.syncDirectoryHandle, 'syncDirectory');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      return { success: true, name: this.syncDirectoryHandle.name };
    } catch (error) {
      if (error.name === 'AbortError')
        return { success: false, error: 'User cancelled' };
      throw error;
    }
  }

  async _getSyncDir() {
    if (!this.syncDirectoryHandle) {
      const db = await this.mainStorage.initDB();
      this.syncDirectoryHandle = await new Promise((resolve, reject) => {
        const tx = db.transaction([this.storeName], 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get('syncDirectory');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    if (!this.syncDirectoryHandle)
      throw new Error('No sync directory configured');
    const opts = { mode: 'readwrite' };
    if ((await this.syncDirectoryHandle.queryPermission(opts)) !== 'granted') {
      if (
        (await this.syncDirectoryHandle.requestPermission(opts)) !== 'granted'
      ) {
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
    try {
      dir = await root.getDirectoryHandle(deviceDir);
    } catch {
      return [];
    }
    const results = [];
    await this._syncWalkDir(dir, '', results);
    return results;
  }

  async _syncWalkDir(dirHandle, prefix, results) {
    for await (const entry of dirHandle.values()) {
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'file') {
        const file = await entry.getFile();
        results.push({
          path: entryPath,
          content: await file.text(),
          size: file.size,
        });
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
    const fh = await current.getFileHandle(segments[segments.length - 1], {
      create: true,
    });
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
}
