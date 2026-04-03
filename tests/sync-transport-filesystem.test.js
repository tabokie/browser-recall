import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilesystemTransport } from '../extension/sync-transport-filesystem.js';

describe('FilesystemTransport', () => {
  let io;
  let transport;

  beforeEach(() => {
    io = {
      listDeviceDirs: vi.fn().mockResolvedValue([]),
      listFiles: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockResolvedValue(''),
      writeFile: vi.fn().mockResolvedValue(undefined),
      ensureDir: vi.fn().mockResolvedValue(undefined),
      removeFile: vi.fn().mockResolvedValue(undefined),
    };
    transport = new FilesystemTransport(io);
  });

  describe('listBranches', () => {
    it('returns empty array when no device directories', async () => {
      const branches = await transport.listBranches();
      expect(branches).toEqual([]);
      expect(io.listDeviceDirs).toHaveBeenCalled();
    });

    it('returns one entry per device with metadata hash as sha', async () => {
      io.listDeviceDirs.mockResolvedValue(['deviceA', 'deviceB']);
      io.listFiles.mockImplementation(async (dir) => {
        if (dir === 'deviceA') return [{ path: 'data/logs/deviceA/2026-04-01.jsonl', content: '{"a":1}', size: 7 }];
        return [{ path: 'data/logs/deviceB/2026-04-01.jsonl', content: '{"b":2}', size: 7 }];
      });

      const branches = await transport.listBranches();
      expect(branches).toHaveLength(2);
      expect(branches[0].name).toBe('deviceA');
      expect(branches[1].name).toBe('deviceB');
      expect(branches[0].sha).toBeTruthy();
      expect(branches[1].sha).toBeTruthy();
      expect(branches[0].sha).not.toBe(branches[1].sha);
    });

    it('sha changes when file size changes', async () => {
      io.listDeviceDirs.mockResolvedValue(['dev1']);
      io.listFiles.mockResolvedValue([{ path: 'data/logs/dev1/day.jsonl', content: 'abc', size: 3 }]);
      const b1 = await transport.listBranches();

      io.listFiles.mockResolvedValue([{ path: 'data/logs/dev1/day.jsonl', content: 'abcdef', size: 6 }]);
      const b2 = await transport.listBranches();

      expect(b1[0].sha).not.toBe(b2[0].sha);
    });
  });

  describe('getTree', () => {
    it('returns file listing with content hashes after listBranches', async () => {
      io.listDeviceDirs.mockResolvedValue(['dev1']);
      io.listFiles.mockResolvedValue([
        { path: 'data/logs/dev1/day.jsonl', content: '{"x":1}\n', size: 8 },
        { path: 'data/notes/note1.json', content: '{"note":"hi"}', size: 13 },
      ]);

      const branches = await transport.listBranches();
      const tree = await transport.getTree(branches[0].sha);

      expect(tree).toHaveLength(2);
      expect(tree[0].path).toBe('data/logs/dev1/day.jsonl');
      expect(tree[1].path).toBe('data/notes/note1.json');
      expect(tree[0].sha).toBeTruthy();
      expect(tree[1].sha).toBeTruthy();
    });

    it('uses cached content from listFiles (content field)', async () => {
      io.listDeviceDirs.mockResolvedValue(['dev1']);
      io.listFiles.mockResolvedValue([
        { path: 'file.txt', content: 'hello', size: 5 },
      ]);

      const branches = await transport.listBranches();
      await transport.getTree(branches[0].sha);

      // readFile should NOT be called because content was in listFiles result
      expect(io.readFile).not.toHaveBeenCalled();
    });

    it('falls back to readFile when content not in listFiles', async () => {
      io.listDeviceDirs.mockResolvedValue(['dev1']);
      io.listFiles.mockResolvedValue([
        { path: 'file.txt', size: 5 }, // no content field
      ]);
      io.readFile.mockResolvedValue('hello');

      const branches = await transport.listBranches();
      const tree = await transport.getTree(branches[0].sha);

      expect(io.readFile).toHaveBeenCalledWith('dev1/file.txt');
      expect(tree).toHaveLength(1);
    });

    it('throws on unknown sha', async () => {
      await expect(transport.getTree('bogus')).rejects.toThrow('Unknown tree sha');
    });
  });

  describe('getBlob', () => {
    it('returns content from cache after getTree', async () => {
      io.listDeviceDirs.mockResolvedValue(['dev1']);
      io.listFiles.mockResolvedValue([{ path: 'f.txt', content: 'data here', size: 9 }]);

      const branches = await transport.listBranches();
      const tree = await transport.getTree(branches[0].sha);
      const content = await transport.getBlob(tree[0].sha);
      expect(content).toBe('data here');
    });

    it('throws on unknown sha', async () => {
      await expect(transport.getBlob('bogus')).rejects.toThrow('Unknown blob sha');
    });
  });

  describe('pushTree', () => {
    it('creates device directory and writes all files', async () => {
      io.listFiles.mockResolvedValue([]); // no existing files
      const files = [
        { path: 'data/logs/dev1/day.jsonl', content: '{"a":1}' },
        { path: 'data/notes/note.json', content: '{"n":1}' },
      ];

      const result = await transport.pushTree('dev1', files);

      expect(io.ensureDir).toHaveBeenCalledWith('dev1');
      expect(io.writeFile).toHaveBeenCalledWith('dev1/data/logs/dev1/day.jsonl', '{"a":1}');
      expect(io.writeFile).toHaveBeenCalledWith('dev1/data/notes/note.json', '{"n":1}');
      expect(result.sha).toBeTruthy();
    });

    it('removes stale files not in the new snapshot', async () => {
      io.listFiles.mockResolvedValue([
        { path: 'data/logs/dev1/old.jsonl', content: 'old', size: 3 },
        { path: 'data/logs/dev1/day.jsonl', content: 'x', size: 1 },
      ]);

      await transport.pushTree('dev1', [
        { path: 'data/logs/dev1/day.jsonl', content: 'updated' },
      ]);

      expect(io.removeFile).toHaveBeenCalledWith('dev1/data/logs/dev1/old.jsonl');
      // The kept file should not be removed
      expect(io.removeFile).not.toHaveBeenCalledWith('dev1/data/logs/dev1/day.jsonl');
    });

    it('ignores errors when removing stale files', async () => {
      io.listFiles.mockResolvedValue([{ path: 'gone.txt', content: '', size: 0 }]);
      io.removeFile.mockRejectedValue(new Error('not found'));

      // Should not throw
      await transport.pushTree('dev1', []);
      expect(io.removeFile).toHaveBeenCalled();
    });
  });

  describe('createBranch', () => {
    it('calls ensureDir', async () => {
      await transport.createBranch('new-device');
      expect(io.ensureDir).toHaveBeenCalledWith('new-device');
    });
  });

  describe('full push/pull cycle', () => {
    it('push then pull discovers files', async () => {
      io.listFiles.mockResolvedValue([]);
      await transport.pushTree('dev1', [
        { path: 'data/logs/dev1/day.jsonl', content: '{"action":"visit_page"}' },
      ]);

      // Now simulate listing: the pushed files appear as a device directory
      io.listDeviceDirs.mockResolvedValue(['dev1']);
      io.listFiles.mockResolvedValue([
        { path: 'data/logs/dev1/day.jsonl', content: '{"action":"visit_page"}', size: 23 },
      ]);

      const branches = await transport.listBranches();
      expect(branches).toHaveLength(1);

      const tree = await transport.getTree(branches[0].sha);
      expect(tree).toHaveLength(1);

      const content = await transport.getBlob(tree[0].sha);
      expect(content).toBe('{"action":"visit_page"}');
    });
  });
});
