import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileSystemSyncStorage } from '../extension/filesystem-sync-storage.js';

describe('FileSystemSyncStorage', () => {
  let mainStorage;
  let syncStorage;

  beforeEach(() => {
    mainStorage = {
      collectSyncFiles: vi.fn().mockResolvedValue([{ path: 'data/logs/dev/2026-01-01.jsonl', content: '{}' }]),
      writeSyncFiles: vi.fn().mockResolvedValue(undefined),
      loadRemoteLogEntries: vi.fn().mockResolvedValue([{ deviceId: 'remote', entries: [] }]),
      initDB: vi.fn().mockResolvedValue({
        transaction: vi.fn().mockReturnValue({
          objectStore: vi.fn().mockReturnValue({
            put: (() => { const r = { onsuccess: null, onerror: null }; return r; })(),
          }),
        }),
      }),
    };
    syncStorage = new FileSystemSyncStorage(mainStorage);
  });

  // --- Construction ---

  it('stores mainStorage reference', () => {
    expect(syncStorage.mainStorage).toBe(mainStorage);
  });

  it('starts with null syncDirectoryHandle', () => {
    expect(syncStorage.syncDirectoryHandle).toBeNull();
  });

  // --- Delegating methods ---

  describe('collectSyncFiles', () => {
    it('delegates to mainStorage', async () => {
      const result = await syncStorage.collectSyncFiles('dev1', 7);
      expect(mainStorage.collectSyncFiles).toHaveBeenCalledWith('dev1', 7);
      expect(result).toEqual([{ path: 'data/logs/dev/2026-01-01.jsonl', content: '{}' }]);
    });
  });

  describe('writeSyncFiles', () => {
    it('delegates to mainStorage', async () => {
      const files = [{ path: 'x', content: 'y' }];
      await syncStorage.writeSyncFiles(files);
      expect(mainStorage.writeSyncFiles).toHaveBeenCalledWith(files);
    });
  });

  describe('loadRemoteLogEntries', () => {
    it('delegates to mainStorage', async () => {
      const result = await syncStorage.loadRemoteLogEntries('local-dev');
      expect(mainStorage.loadRemoteLogEntries).toHaveBeenCalledWith('local-dev');
      expect(result).toEqual([{ deviceId: 'remote', entries: [] }]);
    });
  });

  // --- Sync-handle methods ---

  describe('_getSyncDir', () => {
    it('throws when no sync directory configured and DB returns null', async () => {
      // Mock initDB to return a DB that yields null for syncDirectory
      mainStorage.initDB.mockResolvedValue({
        transaction: () => ({
          objectStore: () => ({
            get: vi.fn(() => {
              const r = { onsuccess: null, onerror: null };
              // result is undefined (no stored handle)
              Object.defineProperty(r, 'result', { get: () => undefined });
              setTimeout(() => r.onsuccess?.(), 0);
              return r;
            }),
          }),
        }),
      });
      await expect(syncStorage._getSyncDir()).rejects.toThrow('No sync directory configured');
    });

    it('returns cached handle on second call', async () => {
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn(),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      const result = await syncStorage._getSyncDir();
      expect(result).toBe(mockHandle);
      expect(mockHandle.queryPermission).toHaveBeenCalled();
    });

    it('requests permission if not granted', async () => {
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('prompt'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      const result = await syncStorage._getSyncDir();
      expect(result).toBe(mockHandle);
      expect(mockHandle.requestPermission).toHaveBeenCalled();
    });

    it('throws if permission denied', async () => {
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('prompt'),
        requestPermission: vi.fn().mockResolvedValue('denied'),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      await expect(syncStorage._getSyncDir()).rejects.toThrow('Sync directory permission denied');
    });
  });

  describe('syncFsListDeviceDirs', () => {
    it('lists directory entries from sync root', async () => {
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('granted'),
        values: vi.fn().mockReturnValue([
          { kind: 'directory', name: 'deviceA' },
          { kind: 'directory', name: 'deviceB' },
          { kind: 'file', name: 'readme.txt' },
        ][Symbol.iterator]()),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      const dirs = await syncStorage.syncFsListDeviceDirs();
      expect(dirs).toEqual(['deviceA', 'deviceB']);
    });
  });

  describe('syncFsListFiles', () => {
    it('returns empty array when device dir not found', async () => {
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('granted'),
        getDirectoryHandle: vi.fn().mockRejectedValue(new DOMException('Not found', 'NotFoundError')),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      const files = await syncStorage.syncFsListFiles('nonexistent');
      expect(files).toEqual([]);
    });

    it('walks directory tree recursively', async () => {
      const innerFile = { kind: 'file', name: 'log.jsonl', getFile: () => ({ text: () => 'content', size: 7 }) };
      const subDir = {
        kind: 'directory',
        name: 'data',
        values: () => [innerFile][Symbol.iterator](),
      };
      const deviceDir = {
        values: () => [subDir][Symbol.iterator](),
      };
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('granted'),
        getDirectoryHandle: vi.fn().mockResolvedValue(deviceDir),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      const files = await syncStorage.syncFsListFiles('deviceA');
      expect(files).toEqual([{ path: 'data/log.jsonl', content: 'content', size: 7 }]);
    });
  });

  describe('syncFsReadFile', () => {
    it('reads a file at a nested path', async () => {
      const mockFileHandle = { getFile: () => ({ text: () => 'file-content' }) };
      const subDir = { getFileHandle: vi.fn().mockResolvedValue(mockFileHandle) };
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('granted'),
        getDirectoryHandle: vi.fn().mockResolvedValue(subDir),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      const content = await syncStorage.syncFsReadFile('data/log.jsonl');
      expect(content).toBe('file-content');
      expect(mockHandle.getDirectoryHandle).toHaveBeenCalledWith('data');
      expect(subDir.getFileHandle).toHaveBeenCalledWith('log.jsonl');
    });
  });

  describe('syncFsWriteFile', () => {
    it('creates dirs and writes content', async () => {
      const mockWritable = { write: vi.fn(), close: vi.fn() };
      const mockFileHandle = { createWritable: vi.fn().mockResolvedValue(mockWritable) };
      const subDir = { getFileHandle: vi.fn().mockResolvedValue(mockFileHandle) };
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('granted'),
        getDirectoryHandle: vi.fn().mockResolvedValue(subDir),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      await syncStorage.syncFsWriteFile('data/log.jsonl', 'hello');
      expect(mockHandle.getDirectoryHandle).toHaveBeenCalledWith('data', { create: true });
      expect(subDir.getFileHandle).toHaveBeenCalledWith('log.jsonl', { create: true });
      expect(mockWritable.write).toHaveBeenCalledWith('hello');
      expect(mockWritable.close).toHaveBeenCalled();
    });
  });

  describe('syncFsEnsureDir', () => {
    it('creates nested directories', async () => {
      const innerDir = { getDirectoryHandle: vi.fn().mockResolvedValue({}) };
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('granted'),
        getDirectoryHandle: vi.fn().mockResolvedValue(innerDir),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      await syncStorage.syncFsEnsureDir('data/logs');
      expect(mockHandle.getDirectoryHandle).toHaveBeenCalledWith('data', { create: true });
      expect(innerDir.getDirectoryHandle).toHaveBeenCalledWith('logs', { create: true });
    });
  });

  describe('syncFsRemoveFile', () => {
    it('removes a file at a nested path', async () => {
      const subDir = { removeEntry: vi.fn() };
      const mockHandle = {
        queryPermission: vi.fn().mockResolvedValue('granted'),
        getDirectoryHandle: vi.fn().mockResolvedValue(subDir),
      };
      syncStorage.syncDirectoryHandle = mockHandle;
      await syncStorage.syncFsRemoveFile('data/log.jsonl');
      expect(subDir.removeEntry).toHaveBeenCalledWith('log.jsonl');
    });
  });
});
