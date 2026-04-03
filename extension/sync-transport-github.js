// GitHub REST API adapter for sync transport.
// Pure fetch-based — runs in background service worker.

const API_BASE = 'https://api.github.com';
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

// Transient errors worth retrying: server errors and network failures.
function isTransient(status) {
  return status >= 500;
}

export function parseRepoUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid repo URL: ${url}`); }
  const parts = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid repo URL (need owner/repo): ${url}`);
  const repo = parts[1].replace(/\.git$/, '');
  return { owner: parts[0], repo };
}

export class GitHubTransport {
  constructor({ owner, repo, token }) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
  }

  async _request(method, path, body) {
    const url = `${API_BASE}${path}`;
    const opts = {
      method,
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github+json',
      },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, opts);
        if (resp.ok) return resp.json();
        if (resp.status === 403 && resp.headers.get('X-RateLimit-Remaining') === '0') {
          const resetHeader = resp.headers.get('X-RateLimit-Reset');
          const resetEpoch = resetHeader ? parseInt(resetHeader, 10) : null;
          const err = new Error(`GitHub API rate limit exceeded (403)`);
          err.rateLimitReset = (resetEpoch && !isNaN(resetEpoch)) ? resetEpoch : null;
          throw err;
        }
        const text = await resp.text().catch(() => '');
        lastError = new Error(`GitHub API error ${resp.status}: ${text}`);
        // Only retry on transient (5xx) errors
        if (!isTransient(resp.status)) throw lastError;
      } catch (e) {
        lastError = e;
        // Don't retry non-transient GitHub API errors
        if (e.message.startsWith('GitHub API error') && !e.message.includes(' 5')) throw e;
        if (e.message.includes('rate limit')) throw e;
      }
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
      }
    }
    throw lastError;
  }

  get _repoPath() {
    return `/repos/${this.owner}/${this.repo}`;
  }

  // List all branches. Returns [{ name, sha }].
  async listBranches() {
    const data = await this._request('GET', `${this._repoPath}/branches`);
    return data.map(b => ({ name: b.name, sha: b.commit.sha }));
  }

  // Get recursive tree for a commit/tree SHA. Returns [{ path, sha }] (blobs only).
  async getTree(sha) {
    const data = await this._request('GET', `${this._repoPath}/git/trees/${sha}?recursive=1`);
    return data.tree
      .filter(entry => entry.type === 'blob')
      .map(entry => ({ path: entry.path, sha: entry.sha }));
  }

  // Get blob content (base64-decoded to string).
  async getBlob(sha) {
    const data = await this._request('GET', `${this._repoPath}/git/blobs/${sha}`);
    return atob(data.content);
  }

  // Create a new branch ref pointing at the given SHA.
  async createBranch(name, sha) {
    await this._request('POST', `${this._repoPath}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha,
    });
  }

  // Push files as a single orphan commit on the given branch.
  // files: [{ path, content }]. Returns { sha: commitSha }.
  async pushTree(branch, files) {
    // 1. Create blobs
    const blobShas = [];
    for (const file of files) {
      const blob = await this._request('POST', `${this._repoPath}/git/blobs`, {
        content: btoa(file.content),
        encoding: 'base64',
      });
      blobShas.push(blob.sha);
    }

    // 2. Create tree
    const treeEntries = files.map((file, i) => ({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blobShas[i],
    }));
    const tree = await this._request('POST', `${this._repoPath}/git/trees`, {
      tree: treeEntries,
    });

    // 3. Create orphan commit (no parents)
    const commit = await this._request('POST', `${this._repoPath}/git/commits`, {
      message: 'sync',
      tree: tree.sha,
      parents: [],
    });

    // 4. Update branch ref (force). If branch doesn't exist, create it.
    try {
      await this._request('PATCH', `${this._repoPath}/git/refs/heads/${branch}`, {
        sha: commit.sha,
        force: true,
      });
    } catch (e) {
      if (e.message.includes('422')) {
        await this.createBranch(branch, commit.sha);
      } else {
        throw e;
      }
    }

    return { sha: commit.sha };
  }
}
