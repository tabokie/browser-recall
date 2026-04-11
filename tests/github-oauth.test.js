import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let fetchGitHubUser;

beforeEach(async () => {
  globalThis.fetch = vi.fn();
  const mod = await import('../extension/github-oauth.js');
  fetchGitHubUser = mod.fetchGitHubUser;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('github-oauth', () => {
  describe('fetchGitHubUser', () => {
    it('returns login from /user endpoint', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ login: 'octocat', id: 1 }),
      });

      const result = await fetchGitHubUser('gho_token');
      expect(result).toEqual({ login: 'octocat' });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token gho_token',
          }),
        }),
      );
    });

    it('throws on auth failure', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(fetchGitHubUser('bad_token')).rejects.toThrow();
    });
  });
});
