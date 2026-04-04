import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubTransport, parseRepoUrl } from '../extension/sync-transport-github.js';

describe('parseRepoUrl', () => {
  it('parses standard GitHub URL', () => {
    expect(parseRepoUrl('https://github.com/user/repo')).toEqual({ owner: 'user', repo: 'repo' });
  });

  it('parses URL with .git suffix', () => {
    expect(parseRepoUrl('https://github.com/user/repo.git')).toEqual({ owner: 'user', repo: 'repo' });
  });

  it('parses URL with trailing slash', () => {
    expect(parseRepoUrl('https://github.com/user/repo/')).toEqual({ owner: 'user', repo: 'repo' });
  });

  it('throws on invalid URL', () => {
    expect(() => parseRepoUrl('not-a-url')).toThrow();
  });

  it('throws on non-GitHub URL with too few path segments', () => {
    expect(() => parseRepoUrl('https://github.com/user')).toThrow();
  });
});

describe('GitHubTransport', () => {
  let transport;
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    transport = new GitHubTransport({ owner: 'testuser', repo: 'testrepo', token: 'ghp_testtoken' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: new Headers(),
    };
  }

  describe('listBranches', () => {
    it('calls correct endpoint and returns mapped branches', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse([
        { name: 'device-a', commit: { sha: 'abc123' } },
        { name: 'device-b', commit: { sha: 'def456' } },
      ]));

      const branches = await transport.listBranches();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/testuser/testrepo/branches',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'token ghp_testtoken',
          }),
        }),
      );
      expect(branches).toEqual([
        { name: 'device-a', sha: 'abc123' },
        { name: 'device-b', sha: 'def456' },
      ]);
    });
  });

  describe('getTree', () => {
    it('calls recursive tree endpoint and returns file entries', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        sha: 'tree123',
        tree: [
          { path: 'data/logs/dev1/2026-03-20.jsonl', sha: 'blob1', type: 'blob' },
          { path: 'data/notes/note1.json', sha: 'blob2', type: 'blob' },
          { path: 'data/logs', sha: 'tree1', type: 'tree' },
        ],
      }));

      const tree = await transport.getTree('tree123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/testuser/testrepo/git/trees/tree123?recursive=1',
        expect.any(Object),
      );
      // Only blobs, not tree entries
      expect(tree).toEqual([
        { path: 'data/logs/dev1/2026-03-20.jsonl', sha: 'blob1' },
        { path: 'data/notes/note1.json', sha: 'blob2' },
      ]);
    });
  });

  describe('getBlob', () => {
    it('fetches blob and decodes base64 content', async () => {
      const content = '{"slug":"test","excerpt":"hello"}';
      const encoded = btoa(content);
      mockFetch.mockResolvedValueOnce(mockResponse({
        sha: 'blob1',
        content: encoded,
        encoding: 'base64',
      }));

      const result = await transport.getBlob('blob1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/testuser/testrepo/git/blobs/blob1',
        expect.any(Object),
      );
      expect(result).toBe(content);
    });
  });

  describe('createBranch', () => {
    it('creates a ref for the new branch', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        ref: 'refs/heads/new-device',
        object: { sha: 'abc123' },
      }, 201));

      await transport.createBranch('new-device', 'abc123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/testuser/testrepo/git/refs',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ref: 'refs/heads/new-device', sha: 'abc123' }),
        }),
      );
    });
  });

  describe('pushTree', () => {
    it('creates blobs, tree, orphan commit, and updates ref', async () => {
      const files = [
        { path: 'data/logs/dev1/2026-03-20.jsonl', content: '{"action":"visit_page"}\n' },
        { path: 'data/notes/note1.json', content: '{"slug":"note1"}' },
      ];

      // Mock blob creation (one per file)
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 'blob-sha-1' }, 201));
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 'blob-sha-2' }, 201));
      // Mock tree creation
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 'tree-sha' }, 201));
      // Mock orphan commit creation
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 'commit-sha' }, 201));
      // Mock ref update
      mockFetch.mockResolvedValueOnce(mockResponse({ object: { sha: 'commit-sha' } }));

      const result = await transport.pushTree('dev1', files);

      // Verify blob creation calls
      expect(mockFetch).toHaveBeenNthCalledWith(1,
        'https://api.github.com/repos/testuser/testrepo/git/blobs',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"encoding":"base64"'),
        }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(2,
        'https://api.github.com/repos/testuser/testrepo/git/blobs',
        expect.any(Object),
      );

      // Verify tree creation
      const treeCall = mockFetch.mock.calls[2];
      expect(treeCall[0]).toBe('https://api.github.com/repos/testuser/testrepo/git/trees');
      const treeBody = JSON.parse(treeCall[1].body);
      expect(treeBody.tree).toEqual([
        { path: 'data/logs/dev1/2026-03-20.jsonl', mode: '100644', type: 'blob', sha: 'blob-sha-1' },
        { path: 'data/notes/note1.json', mode: '100644', type: 'blob', sha: 'blob-sha-2' },
      ]);

      // Verify orphan commit (no parents)
      const commitCall = mockFetch.mock.calls[3];
      expect(commitCall[0]).toBe('https://api.github.com/repos/testuser/testrepo/git/commits');
      const commitBody = JSON.parse(commitCall[1].body);
      expect(commitBody.parents).toEqual([]);
      expect(commitBody.tree).toBe('tree-sha');

      // Verify ref update (force)
      const refCall = mockFetch.mock.calls[4];
      expect(refCall[0]).toBe('https://api.github.com/repos/testuser/testrepo/git/refs/heads/dev1');
      const refBody = JSON.parse(refCall[1].body);
      expect(refBody.sha).toBe('commit-sha');
      expect(refBody.force).toBe(true);

      expect(result).toEqual({ sha: 'commit-sha' });
    });

    it('creates ref if branch does not exist (PATCH returns 422)', async () => {
      const files = [{ path: 'data/notes/n.json', content: '{}' }];

      // blob
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 'b1' }, 201));
      // tree
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 't1' }, 201));
      // commit
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 'c1' }, 201));
      // ref update fails (branch doesn't exist)
      mockFetch.mockResolvedValueOnce(mockResponse({ message: 'Reference does not exist' }, 422));
      // create ref fallback
      mockFetch.mockResolvedValueOnce(mockResponse({ ref: 'refs/heads/dev1', object: { sha: 'c1' } }, 201));

      const result = await transport.pushTree('dev1', files);
      expect(result).toEqual({ sha: 'c1' });

      // Last call should be POST to create ref
      const lastCall = mockFetch.mock.calls[4];
      expect(lastCall[0]).toBe('https://api.github.com/repos/testuser/testrepo/git/refs');
      expect(lastCall[1].method).toBe('POST');
    });
  });

  describe('empty repo initialization', () => {
    it('initializes repo via Contents API when blob creation returns 409', async () => {
      const files = [{ path: 'data/notes/n.json', content: '{}' }];

      // First blob creation fails with 409 (empty repo)
      mockFetch.mockResolvedValueOnce(mockResponse(
        { message: 'Git Repository is empty.', status: '409' }, 409,
      ));
      // _initializeEmptyRepo: PUT contents/.gitkeep
      mockFetch.mockResolvedValueOnce(mockResponse({ content: { sha: 'init-sha' } }, 201));
      // Retry blob creation succeeds
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 'b1' }, 201));
      // tree
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 't1' }, 201));
      // commit
      mockFetch.mockResolvedValueOnce(mockResponse({ sha: 'c1' }, 201));
      // ref update (branch doesn't exist yet on fresh repo)
      mockFetch.mockResolvedValueOnce(mockResponse({ message: 'Reference does not exist' }, 422));
      // create ref fallback
      mockFetch.mockResolvedValueOnce(mockResponse({ ref: 'refs/heads/dev1', object: { sha: 'c1' } }, 201));

      const result = await transport.pushTree('dev1', files);
      expect(result).toEqual({ sha: 'c1' });

      // Verify the init call: PUT /repos/.../contents/.gitkeep
      const initCall = mockFetch.mock.calls[1];
      expect(initCall[0]).toBe('https://api.github.com/repos/testuser/testrepo/contents/.gitkeep');
      expect(initCall[1].method).toBe('PUT');
      const initBody = JSON.parse(initCall[1].body);
      expect(initBody.message).toMatch(/init/i);
      expect(initBody.branch).toBe('dev1');
    });
  });

  describe('deleteBranch', () => {
    it('deletes the branch ref via DELETE', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse(null, 204));
      await transport.deleteBranch('dev1');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/testuser/testrepo/git/refs/heads/dev1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('error handling', () => {
    it('throws on 401 unauthorized', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ message: 'Bad credentials' }, 401));
      await expect(transport.listBranches()).rejects.toThrow(/401/);
    });

    it('throws on 404 not found', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ message: 'Not Found' }, 404));
      await expect(transport.getTree('abc')).rejects.toThrow(/404/);
    });

    it('throws on rate limit (403 with rate limit header)', async () => {
      const resp = mockResponse({ message: 'API rate limit exceeded' }, 403);
      resp.headers = new Headers({ 'X-RateLimit-Remaining': '0' });
      mockFetch.mockResolvedValueOnce(resp);
      await expect(transport.listBranches()).rejects.toThrow(/rate limit/i);
    });

    it('attaches rateLimitReset from X-RateLimit-Reset header', async () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const resp = mockResponse({ message: 'API rate limit exceeded' }, 403);
      resp.headers = new Headers({
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(resetEpoch),
      });
      mockFetch.mockResolvedValueOnce(resp);
      try {
        await transport.listBranches();
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e.message).toMatch(/rate limit/i);
        expect(e.rateLimitReset).toBe(resetEpoch);
      }
    });

    it('sets rateLimitReset to null when X-RateLimit-Reset header is missing', async () => {
      const resp = mockResponse({ message: 'API rate limit exceeded' }, 403);
      resp.headers = new Headers({ 'X-RateLimit-Remaining': '0' });
      mockFetch.mockResolvedValueOnce(resp);
      try {
        await transport.listBranches();
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e.message).toMatch(/rate limit/i);
        expect(e.rateLimitReset).toBeNull();
      }
    });

    it('throws on network error after retries', async () => {
      mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(transport.listBranches()).rejects.toThrow('Failed to fetch');
      expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('retry logic', () => {
    it('retries on 500 server error then succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ message: 'Internal Server Error' }, 500))
        .mockResolvedValueOnce(mockResponse([{ name: 'dev1', commit: { sha: 'abc' } }]));

      const branches = await transport.listBranches();
      expect(branches).toEqual([{ name: 'dev1', sha: 'abc' }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on network error then succeeds', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(mockResponse([{ name: 'dev1', commit: { sha: 'abc' } }]));

      const branches = await transport.listBranches();
      expect(branches).toEqual([{ name: 'dev1', sha: 'abc' }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry on 401 auth error', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ message: 'Bad credentials' }, 401));
      await expect(transport.listBranches()).rejects.toThrow(/401/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ message: 'Not Found' }, 404));
      await expect(transport.getTree('abc')).rejects.toThrow(/404/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('gives up after max retries on persistent 500', async () => {
      mockFetch
        .mockResolvedValue(mockResponse({ message: 'Internal Server Error' }, 500));

      await expect(transport.listBranches()).rejects.toThrow(/500/);
      expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });
});
