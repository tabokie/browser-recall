import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Will import from extension/github-oauth.js once written
let requestDeviceCode, pollForToken, fetchGitHubUser, getGitHubRevokeUrl, GITHUB_CLIENT_ID;

beforeEach(async () => {
  globalThis.fetch = vi.fn();
  const mod = await import('../extension/github-oauth.js');
  requestDeviceCode = mod.requestDeviceCode;
  pollForToken = mod.pollForToken;
  fetchGitHubUser = mod.fetchGitHubUser;
  getGitHubRevokeUrl = mod.getGitHubRevokeUrl;
  GITHUB_CLIENT_ID = mod.GITHUB_CLIENT_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('github-oauth', () => {
  describe('GITHUB_CLIENT_ID', () => {
    it('exports a non-empty client ID', () => {
      expect(GITHUB_CLIENT_ID).toBeTruthy();
      expect(typeof GITHUB_CLIENT_ID).toBe('string');
    });
  });

  describe('requestDeviceCode', () => {
    it('POSTs to GitHub device/code endpoint and returns parsed response', async () => {
      const mockResponse = {
        device_code: 'abc123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900,
      };
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await requestDeviceCode();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://github.com/login/device/code',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Accept': 'application/json',
          }),
        }),
      );
      // Verify client_id and scope were sent in body
      const callBody = globalThis.fetch.mock.calls[0][1].body;
      const params = new URLSearchParams(callBody);
      expect(params.get('client_id')).toBe(GITHUB_CLIENT_ID);
      expect(params.get('scope')).toBe('repo');

      expect(result).toEqual(mockResponse);
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });
      await expect(requestDeviceCode()).rejects.toThrow('Failed to request device code');
    });
  });

  describe('pollForToken', () => {
    it('resolves with access_token on success', async () => {
      // First call: authorization_pending, second call: success
      globalThis.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ error: 'authorization_pending' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'gho_secrettoken', token_type: 'bearer' }),
        });

      const result = await pollForToken('device123', 0.01, 60);
      expect(result).toBe('gho_secrettoken');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('keeps polling on slow_down and increases interval', async () => {
      vi.useFakeTimers();
      globalThis.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ error: 'slow_down' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'gho_token' }),
        });

      const p = pollForToken('device123', 1, 60);
      // First poll returns slow_down → sleeps 1000+5000=6000ms
      await vi.advanceTimersByTimeAsync(6000);
      // Second poll returns token
      const result = await p;
      expect(result).toBe('gho_token');
      vi.useRealTimers();
    });

    it('rejects on expired_token', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: 'expired_token' }),
      });

      await expect(pollForToken('device123', 0.01, 0.02)).rejects.toThrow('expired');
    });

    it('rejects on access_denied', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: 'access_denied' }),
      });

      await expect(pollForToken('device123', 0.01, 60)).rejects.toThrow('denied');
    });

    it('supports cancellation via AbortSignal', async () => {
      const controller = new AbortController();
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: 'authorization_pending' }),
      });

      // Abort after first poll
      const pollPromise = pollForToken('device123', 0.01, 60, controller.signal);
      // Wait a tick for first poll to happen
      await new Promise(r => setTimeout(r, 15));
      controller.abort();

      await expect(pollPromise).rejects.toThrow(/cancel|abort/i);
    });
  });

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
            'Authorization': 'token gho_token',
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

  describe('getGitHubRevokeUrl', () => {
    it('returns URL containing the client ID', () => {
      const url = getGitHubRevokeUrl();
      expect(url).toContain('github.com/settings/connections/applications/');
      expect(url).toContain(GITHUB_CLIENT_ID);
    });
  });
});
