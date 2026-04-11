import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebDAVTransport } from '../extension/sync-transport-webdav.js';

// Minimal DOMParser polyfill for vitest (Node.js).
import { JSDOM } from 'jsdom';
if (typeof globalThis.DOMParser === 'undefined') {
  globalThis.DOMParser = new JSDOM().window.DOMParser;
}

describe('WebDAVTransport', () => {
  let transport;
  let mockFetch;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    transport = new WebDAVTransport({
      url: 'https://dav.example.com/sync/',
      username: 'user',
      password: 'pass',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function davResponse(body, status = 207) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      headers: new Headers(),
    };
  }

  function textResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      headers: new Headers(),
    };
  }

  const DEVICE_LIST_XML = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/sync/deviceA/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/sync/deviceB/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;

  function fileListXml(deviceName, files) {
    const entries = files
      .map(
        (f) => `
  <D:response>
    <D:href>/sync/${deviceName}/${f.path}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"${f.etag}"</D:getetag>
      </D:prop>
    </D:propstat>
  </D:response>`,
      )
      .join('');
    return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${entries}</D:multistatus>`;
  }

  describe('constructor', () => {
    it('normalizes URL with trailing slash', () => {
      const t = new WebDAVTransport({
        url: 'https://dav.example.com/sync',
        username: '',
        password: '',
      });
      // Internal URL should end with /
      expect(t._url).toBe('https://dav.example.com/sync/');
    });
  });

  describe('auth header', () => {
    it('sends correct Basic auth header', async () => {
      mockFetch.mockResolvedValueOnce(davResponse(DEVICE_LIST_XML));
      // The depth-infinity calls for each device — make them return empty
      mockFetch.mockResolvedValue(
        davResponse(
          '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>',
        ),
      );

      await transport.listBranches();

      const firstCall = mockFetch.mock.calls[0];
      const headers = firstCall[1].headers;
      expect(headers.Authorization).toBe('Basic ' + btoa('user:pass'));
    });
  });

  describe('listBranches', () => {
    it('sends PROPFIND with Depth 1 to root', async () => {
      mockFetch.mockResolvedValueOnce(davResponse(DEVICE_LIST_XML));
      // depth-infinity for deviceA and deviceB
      mockFetch.mockResolvedValueOnce(
        davResponse(
          fileListXml('deviceA', [
            { path: 'data/logs/deviceA/day.jsonl', etag: 'etag-a1' },
          ]),
        ),
      );
      mockFetch.mockResolvedValueOnce(
        davResponse(
          fileListXml('deviceB', [
            { path: 'data/logs/deviceB/day.jsonl', etag: 'etag-b1' },
          ]),
        ),
      );

      const branches = await transport.listBranches();

      expect(branches).toHaveLength(2);
      expect(branches[0].name).toBe('deviceA');
      expect(branches[1].name).toBe('deviceB');
      expect(branches[0].sha).toBeTruthy();
      expect(branches[1].sha).toBeTruthy();

      // First call should be PROPFIND with Depth 1
      expect(mockFetch.mock.calls[0][1].method).toBe('PROPFIND');
      expect(mockFetch.mock.calls[0][1].headers.Depth).toBe('1');
    });

    it('skips peers where depth infinity returns 403', async () => {
      mockFetch.mockResolvedValueOnce(davResponse(DEVICE_LIST_XML));
      // deviceA: depth infinity fails with 403
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Depth infinity not allowed',
        headers: new Headers(),
      });
      // deviceB: works
      mockFetch.mockResolvedValueOnce(
        davResponse(fileListXml('deviceB', [{ path: 'f.txt', etag: 'e1' }])),
      );

      const branches = await transport.listBranches();
      expect(branches).toHaveLength(1);
      expect(branches[0].name).toBe('deviceB');
    });
  });

  describe('getTree', () => {
    it('returns file listing with etags as shas', async () => {
      mockFetch.mockResolvedValueOnce(davResponse(DEVICE_LIST_XML));
      mockFetch.mockResolvedValueOnce(
        davResponse(
          fileListXml('deviceA', [
            { path: 'data/logs/deviceA/day.jsonl', etag: 'etag-111' },
            { path: 'data/notes/note.json', etag: 'etag-222' },
          ]),
        ),
      );
      mockFetch.mockResolvedValueOnce(davResponse(fileListXml('deviceB', [])));

      const branches = await transport.listBranches();
      const tree = await transport.getTree(branches[0].sha);

      expect(tree).toHaveLength(2);
      expect(tree[0].sha).toBe('etag-111');
      expect(tree[1].sha).toBe('etag-222');
    });

    it('throws on unknown sha', async () => {
      await expect(transport.getTree('bogus')).rejects.toThrow(
        'Unknown tree sha',
      );
    });
  });

  describe('getBlob', () => {
    it('fetches file content via GET using cached path', async () => {
      mockFetch.mockResolvedValueOnce(davResponse(DEVICE_LIST_XML));
      mockFetch.mockResolvedValueOnce(
        davResponse(
          fileListXml('deviceA', [
            { path: 'data/logs/deviceA/day.jsonl', etag: 'etag-abc' },
          ]),
        ),
      );
      mockFetch.mockResolvedValueOnce(davResponse(fileListXml('deviceB', [])));

      const branches = await transport.listBranches();
      await transport.getTree(branches[0].sha);

      // Now getBlob should issue a GET
      mockFetch.mockResolvedValueOnce(textResponse('{"action":"visit"}'));
      const content = await transport.getBlob('etag-abc');

      expect(content).toBe('{"action":"visit"}');
      // The GET call should be to the full path
      const getCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(getCall[1].method).toBe('GET');
      expect(getCall[0]).toContain('deviceA/data/logs/deviceA/day.jsonl');
    });

    it('throws on unknown etag', async () => {
      await expect(transport.getBlob('no-such-etag')).rejects.toThrow(
        'Unknown blob sha',
      );
    });
  });

  describe('pushTree', () => {
    it('creates device dir and writes files', async () => {
      // MKCOL for device dir — 201 Created
      mockFetch.mockResolvedValueOnce(textResponse('', 201));
      // MKCOL for intermediate dirs
      mockFetch.mockResolvedValueOnce(textResponse('', 201)); // data
      mockFetch.mockResolvedValueOnce(textResponse('', 201)); // data/logs
      mockFetch.mockResolvedValueOnce(textResponse('', 201)); // data/logs/dev1
      // PUT for the file
      mockFetch.mockResolvedValueOnce(textResponse('', 201));

      const result = await transport.pushTree('dev1', [
        { path: 'data/logs/dev1/day.jsonl', content: '{"a":1}' },
      ]);

      expect(result.sha).toBeTruthy();
      // Verify MKCOL was called for the device directory
      expect(mockFetch.mock.calls[0][1].method).toBe('MKCOL');
      // Verify PUT was called for the file
      const putCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(putCall[1].method).toBe('PUT');
      expect(putCall[1].body).toBe('{"a":1}');
    });

    it('ignores 405 on MKCOL (directory already exists)', async () => {
      // All MKCOLs return 405
      mockFetch.mockImplementation(async (url, opts) => {
        if (opts.method === 'MKCOL') {
          return {
            ok: false,
            status: 405,
            text: async () => 'Method Not Allowed',
            headers: new Headers(),
          };
        }
        return textResponse('', 201);
      });

      // Should not throw despite 405s
      await transport.pushTree('dev1', [
        { path: 'file.txt', content: 'hello' },
      ]);
    });
  });

  describe('createBranch', () => {
    it('sends MKCOL request', async () => {
      mockFetch.mockResolvedValueOnce(textResponse('', 201));
      await transport.createBranch('new-device');

      expect(mockFetch.mock.calls[0][1].method).toBe('MKCOL');
      expect(mockFetch.mock.calls[0][0]).toContain('new-device');
    });
  });

  describe('retry logic', () => {
    it('retries on 500 error', async () => {
      // First call: 500, second call: success
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
        headers: new Headers(),
      });
      mockFetch.mockResolvedValueOnce(textResponse('', 201));

      await transport.createBranch('dev1');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry on 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
        headers: new Headers(),
      });

      await expect(transport.createBranch('dev1')).rejects.toThrow('404');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
