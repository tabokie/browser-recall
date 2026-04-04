import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncManager } from '../extension/sync-manager.js';

function makeDeps(overrides = {}) {
  return {
    transport: {
      listBranches: vi.fn().mockResolvedValue([]),
      getTree: vi.fn().mockResolvedValue([]),
      getBlob: vi.fn().mockResolvedValue(''),
      pushTree: vi.fn().mockResolvedValue({ sha: 'commit-1' }),
      createBranch: vi.fn().mockResolvedValue(undefined),
    },
    collectLocalFiles: vi.fn().mockResolvedValue([]),
    writeRemoteFiles: vi.fn().mockResolvedValue(undefined),
    loadCursors: vi.fn().mockResolvedValue({ cursors: {} }),
    saveCursors: vi.fn().mockResolvedValue(undefined),
    loadPushState: vi.fn().mockResolvedValue({ files: {} }),
    savePushState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('SyncManager.push', () => {
  it('pushes all files on first sync (empty push state)', async () => {
    const deps = makeDeps({
      collectLocalFiles: vi.fn().mockResolvedValue([
        { path: 'data/logs/dev1/2026-03-25.jsonl', content: '{"action":"visit_page"}\n' },
        { path: 'data/notes/note1.json', content: '{"slug":"note1"}' },
      ]),
      loadPushState: vi.fn().mockResolvedValue({ files: {} }),
    });
    const mgr = new SyncManager(deps);

    await mgr.push('dev1', { retentionDays: 7 });

    expect(deps.collectLocalFiles).toHaveBeenCalledWith('dev1', 7);
    expect(deps.transport.pushTree).toHaveBeenCalledWith('dev1', [
      { path: 'data/logs/dev1/2026-03-25.jsonl', content: '{"action":"visit_page"}\n' },
      { path: 'data/notes/note1.json', content: '{"slug":"note1"}' },
    ]);
    // Push state saved with hashes
    expect(deps.savePushState).toHaveBeenCalledTimes(1);
    const savedState = deps.savePushState.mock.calls[0][0];
    expect(Object.keys(savedState.files)).toHaveLength(2);
  });

  it('skips push when no files changed', async () => {
    const content = '{"slug":"note1"}';
    const deps = makeDeps({
      collectLocalFiles: vi.fn().mockResolvedValue([
        { path: 'data/notes/note1.json', content },
      ]),
    });
    const mgr = new SyncManager(deps);

    // First push
    await mgr.push('dev1', { retentionDays: 7 });
    const firstState = deps.savePushState.mock.calls[0][0];

    // Second push with same content — load the saved state
    deps.loadPushState.mockResolvedValue(firstState);
    deps.transport.pushTree.mockClear();
    deps.savePushState.mockClear();
    await mgr.push('dev1', { retentionDays: 7 });

    expect(deps.transport.pushTree).not.toHaveBeenCalled();
    expect(deps.savePushState).not.toHaveBeenCalled();
  });

  it('pushes only changed files', async () => {
    const deps = makeDeps({
      collectLocalFiles: vi.fn().mockResolvedValue([
        { path: 'data/notes/note1.json', content: '{"v":1}' },
        { path: 'data/notes/note2.json', content: '{"v":2}' },
      ]),
    });
    const mgr = new SyncManager(deps);

    // First push
    await mgr.push('dev1', { retentionDays: 7 });
    const firstState = deps.savePushState.mock.calls[0][0];

    // Change note2, keep note1 same
    deps.collectLocalFiles.mockResolvedValue([
      { path: 'data/notes/note1.json', content: '{"v":1}' },
      { path: 'data/notes/note2.json', content: '{"v":2-updated}' },
    ]);
    deps.loadPushState.mockResolvedValue(firstState);
    deps.transport.pushTree.mockClear();
    await mgr.push('dev1', { retentionDays: 7 });

    // Still pushes ALL files (GitHub tree is a full snapshot), but push happened
    expect(deps.transport.pushTree).toHaveBeenCalledTimes(1);
    const pushedFiles = deps.transport.pushTree.mock.calls[0][1];
    expect(pushedFiles).toHaveLength(2);
  });

  it('does not push when collectLocalFiles returns empty', async () => {
    const deps = makeDeps({
      collectLocalFiles: vi.fn().mockResolvedValue([]),
    });
    const mgr = new SyncManager(deps);
    await mgr.push('dev1', { retentionDays: 7 });
    expect(deps.transport.pushTree).not.toHaveBeenCalled();
  });

  it('returns collision when deviceId matches existing branch on first push', async () => {
    const deps = makeDeps({
      collectLocalFiles: vi.fn().mockResolvedValue([
        { path: 'data/notes/note1.json', content: '{"slug":"note1"}' },
      ]),
      loadPushState: vi.fn().mockResolvedValue({}), // empty = first push
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev1', sha: 'abc' },
          { name: 'dev2', sha: 'def' },
        ]),
      },
    });
    const mgr = new SyncManager(deps);

    const result = await mgr.push('dev1', { retentionDays: 7 });

    expect(result).toEqual({ pushed: false, collision: true });
    expect(deps.transport.pushTree).not.toHaveBeenCalled();
  });

  it('does not check collision on subsequent pushes', async () => {
    const deps = makeDeps({
      collectLocalFiles: vi.fn().mockResolvedValue([
        { path: 'data/notes/note1.json', content: '{"slug":"note1"}' },
      ]),
      loadPushState: vi.fn().mockResolvedValue({ files: { 'data/notes/note1.json': 'oldhash' } }),
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev1', sha: 'abc' },
        ]),
      },
    });
    const mgr = new SyncManager(deps);

    await mgr.push('dev1', { retentionDays: 7 });

    // listBranches should NOT be called — not a first push
    expect(deps.transport.listBranches).not.toHaveBeenCalled();
    expect(deps.transport.pushTree).toHaveBeenCalled();
  });

  it('proceeds with push on first push when no collision', async () => {
    const deps = makeDeps({
      collectLocalFiles: vi.fn().mockResolvedValue([
        { path: 'data/notes/note1.json', content: '{"slug":"note1"}' },
      ]),
      loadPushState: vi.fn().mockResolvedValue({}), // empty = first push
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev2', sha: 'def' },
        ]),
      },
    });
    const mgr = new SyncManager(deps);

    const result = await mgr.push('dev1', { retentionDays: 7 });

    expect(result.pushed).toBe(true);
    expect(deps.transport.pushTree).toHaveBeenCalled();
  });
});

describe('SyncManager.pull', () => {
  it('skips own device branch', async () => {
    const deps = makeDeps({
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev1', sha: 'abc' },
          { name: 'dev2', sha: 'def' },
        ]),
        getTree: vi.fn().mockResolvedValue([]),
      },
    });
    const mgr = new SyncManager(deps);

    await mgr.pull('dev1');

    // Should only getTree for dev2, not dev1
    expect(deps.transport.getTree).toHaveBeenCalledTimes(1);
    expect(deps.transport.getTree).toHaveBeenCalledWith('def');
  });

  it('skips peer when treeSha unchanged', async () => {
    const deps = makeDeps({
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev2', sha: 'same-sha' },
        ]),
      },
      loadCursors: vi.fn().mockResolvedValue({
        cursors: { dev2: { treeSha: 'same-sha', files: {} } },
      }),
    });
    const mgr = new SyncManager(deps);

    const result = await mgr.pull('dev1');

    expect(deps.transport.getTree).not.toHaveBeenCalled();
    expect(result.remoteEntries).toEqual([]);
  });

  it('downloads new log and note files from peer', async () => {
    const logContent = '{"action":"visit_page","url":"http://a.com","timestamp":100}\n{"action":"leave_page","url":"http://a.com","timestamp":200}\n';
    const noteContent = '{"slug":"n1","excerpt":"hi","note":"hello","cssPath":"","url":"http://a.com"}';

    const deps = makeDeps({
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev2', sha: 'new-sha' },
        ]),
        getTree: vi.fn().mockResolvedValue([
          { path: 'data/logs/dev2/2026-03-25.jsonl', sha: 'log-blob' },
          { path: 'data/notes/n1.json', sha: 'note-blob' },
        ]),
        getBlob: vi.fn().mockImplementation(async (sha) => {
          if (sha === 'log-blob') return logContent;
          if (sha === 'note-blob') return noteContent;
          return '';
        }),
      },
      loadCursors: vi.fn().mockResolvedValue({ cursors: {} }),
    });
    const mgr = new SyncManager(deps);

    const result = await mgr.pull('dev1');

    // Note files written to disk
    expect(deps.writeRemoteFiles).toHaveBeenCalledWith([
      { path: 'data/notes/n1.json', content: noteContent },
    ]);

    // Log entries returned for replay
    expect(result.remoteEntries).toHaveLength(1);
    expect(result.remoteEntries[0].deviceId).toBe('dev2');
    expect(result.remoteEntries[0].entries).toHaveLength(2);
    expect(result.remoteEntries[0].entries[0].action).toBe('visit_page');

    // Remote log files also written to disk
    expect(deps.writeRemoteFiles).toHaveBeenCalledWith([
      { path: 'data/logs/dev2/2026-03-25.jsonl', content: logContent },
    ]);

    // Cursors saved
    expect(deps.saveCursors).toHaveBeenCalledTimes(1);
    const saved = deps.saveCursors.mock.calls[0][0];
    expect(saved.cursors.dev2.treeSha).toBe('new-sha');
  });

  it('only downloads changed blobs (skips matching SHAs)', async () => {
    const deps = makeDeps({
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev2', sha: 'new-sha' },
        ]),
        getTree: vi.fn().mockResolvedValue([
          { path: 'data/notes/old.json', sha: 'same-blob' },
          { path: 'data/notes/new.json', sha: 'new-blob' },
        ]),
        getBlob: vi.fn().mockResolvedValue('{"slug":"new"}'),
      },
      loadCursors: vi.fn().mockResolvedValue({
        cursors: { dev2: { treeSha: 'old-sha', files: { 'data/notes/old.json': 'same-blob' } } },
      }),
    });
    const mgr = new SyncManager(deps);

    await mgr.pull('dev1');

    // Only download the new blob, not the unchanged one
    expect(deps.transport.getBlob).toHaveBeenCalledTimes(1);
    expect(deps.transport.getBlob).toHaveBeenCalledWith('new-blob');
  });

  it('handles multiple peers', async () => {
    const deps = makeDeps({
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev1', sha: 'own' },
          { name: 'dev2', sha: 'sha2' },
          { name: 'dev3', sha: 'sha3' },
        ]),
        getTree: vi.fn().mockResolvedValue([
          { path: 'data/logs/peer/2026-03-25.jsonl', sha: 'blob1' },
        ]),
        getBlob: vi.fn().mockResolvedValue('{"action":"visit_page","url":"http://x.com","timestamp":1}\n'),
      },
      loadCursors: vi.fn().mockResolvedValue({ cursors: {} }),
    });
    const mgr = new SyncManager(deps);

    const result = await mgr.pull('dev1');

    expect(deps.transport.getTree).toHaveBeenCalledTimes(2);
    expect(result.remoteEntries).toHaveLength(2);
    expect(result.changedPeers).toEqual(['dev2', 'dev3']);
  });

  it('returns devices list from listBranches', async () => {
    const deps = makeDeps({
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev1', sha: 'own' },
          { name: 'dev2', sha: 'sha2' },
          { name: 'dev3', sha: 'sha3' },
        ]),
        getTree: vi.fn().mockResolvedValue([]),
      },
    });
    const mgr = new SyncManager(deps);

    const result = await mgr.pull('dev1');

    expect(result.devices).toEqual([
      { name: 'dev1', sha: 'own' },
      { name: 'dev2', sha: 'sha2' },
      { name: 'dev3', sha: 'sha3' },
    ]);
  });

  it('returns empty when no peers', async () => {
    const deps = makeDeps({
      transport: {
        ...makeDeps().transport,
        listBranches: vi.fn().mockResolvedValue([
          { name: 'dev1', sha: 'own' },
        ]),
      },
    });
    const mgr = new SyncManager(deps);

    const result = await mgr.pull('dev1');

    expect(result.remoteEntries).toEqual([]);
  });
});

describe('SyncManager.deleteDevice', () => {
  it('calls transport.deleteBranch and cleans up cursor', async () => {
    const deps = makeDeps({
      transport: {
        ...makeDeps().transport,
        deleteBranch: vi.fn().mockResolvedValue(undefined),
      },
      loadCursors: vi.fn().mockResolvedValue({
        cursors: { dev2: { treeSha: 'abc', files: {} }, dev3: { treeSha: 'def', files: {} } },
      }),
    });
    const mgr = new SyncManager(deps);

    await mgr.deleteDevice('dev2');

    expect(deps.transport.deleteBranch).toHaveBeenCalledWith('dev2');
    expect(deps.saveCursors).toHaveBeenCalledWith({
      cursors: { dev3: { treeSha: 'def', files: {} } },
    });
  });
});
