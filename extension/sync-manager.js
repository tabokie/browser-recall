// Sync orchestration: push local files to GitHub, pull remote files from peers.
// Pure logic — all I/O injected via constructor deps.

// Simple string hash for change detection (not cryptographic).
function hashContent(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export class SyncManager {
  constructor({ transport, collectLocalFiles, writeRemoteFiles, loadCursors, saveCursors, loadPushState, savePushState }) {
    this.transport = transport;
    this.collectLocalFiles = collectLocalFiles;
    this.writeRemoteFiles = writeRemoteFiles;
    this.loadCursors = loadCursors;
    this.saveCursors = saveCursors;
    this.loadPushState = loadPushState;
    this.savePushState = savePushState;
  }

  // Push local files to the device's own branch.
  // Returns { pushed: boolean, fileCount: number }.
  async push(deviceId, { retentionDays = 7 } = {}) {
    const files = await this.collectLocalFiles(deviceId, retentionDays);
    if (files.length === 0) return { pushed: false, fileCount: 0 };

    // Hash each file and compare against last push state
    const newHashes = {};
    for (const f of files) {
      newHashes[f.path] = hashContent(f.content);
    }

    const pushState = await this.loadPushState();
    const oldHashes = pushState.files || {};

    // Check if anything changed (new files, changed content, or removed files)
    const changed = Object.keys(newHashes).length !== Object.keys(oldHashes).length
      || Object.entries(newHashes).some(([p, h]) => oldHashes[p] !== h);

    if (!changed) return { pushed: false, fileCount: files.length };

    // Push all files (GitHub tree is a full snapshot)
    await this.transport.pushTree(deviceId, files);
    await this.savePushState({ files: newHashes });

    return { pushed: true, fileCount: files.length };
  }

  // Pull remote files from peer branches.
  // Returns { remoteEntries: [{ deviceId, entries }] } for caller to replay.
  async pull(deviceId) {
    const branches = await this.transport.listBranches();
    const peers = branches.filter(b => b.name !== deviceId);

    if (peers.length === 0) return { remoteEntries: [] };

    const cursorData = await this.loadCursors();
    const cursors = cursorData.cursors || {};
    const remoteEntries = [];

    for (const peer of peers) {
      const cursor = cursors[peer.name] || { treeSha: null, files: {} };

      // Skip if branch hasn't changed
      if (cursor.treeSha === peer.sha) continue;

      const tree = await this.transport.getTree(peer.sha);
      const oldFiles = cursor.files || {};

      // Find new/changed blobs
      const changedBlobs = tree.filter(f => oldFiles[f.path] !== f.sha);

      // Download changed blobs
      const downloaded = [];
      for (const blob of changedBlobs) {
        const content = await this.transport.getBlob(blob.sha);
        downloaded.push({ path: blob.path, content, sha: blob.sha });
      }

      // Separate logs from notes
      const logFiles = downloaded.filter(f => f.path.startsWith('data/logs/'));
      const noteFiles = downloaded.filter(f => f.path.startsWith('data/notes/'));

      // Write note files to disk
      if (noteFiles.length > 0) {
        await this.writeRemoteFiles(noteFiles.map(f => ({ path: f.path, content: f.content })));
      }

      // Write remote log files to disk (for hydration on restart)
      if (logFiles.length > 0) {
        await this.writeRemoteFiles(logFiles.map(f => ({ path: f.path, content: f.content })));
      }

      // Parse log entries for replay
      const entries = [];
      for (const logFile of logFiles) {
        const lines = logFile.content.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
        }
      }

      if (entries.length > 0) {
        remoteEntries.push({ deviceId: peer.name, entries });
      }

      // Update cursor for this peer
      const newFiles = {};
      for (const f of tree) newFiles[f.path] = f.sha;
      cursors[peer.name] = { treeSha: peer.sha, files: newFiles };
    }

    await this.saveCursors({ cursors });
    return { remoteEntries };
  }
}
