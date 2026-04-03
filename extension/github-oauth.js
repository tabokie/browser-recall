// GitHub OAuth Device Flow helpers for Browser Recall.
// Loaded by options.html via <script>. No background involvement during auth.

export const GITHUB_CLIENT_ID = 'Ov23lig3RT4WT6xGzMWN';

// Request a device code to start the OAuth device flow.
export async function requestDeviceCode(scope = 'repo') {
  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Failed to request device code: ${resp.status} ${text}`);
  }
  return resp.json();
}

// Poll GitHub until the user authorizes (or the code expires / is denied).
// Returns the access_token string. Rejects on expiry, denial, or abort.
export async function pollForToken(deviceCode, intervalSec, expiresInSec, signal) {
  const deadline = Date.now() + expiresInSec * 1000;
  let interval = intervalSec * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Device flow cancelled');

    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await resp.json();

    if (data.access_token) return data.access_token;

    if (data.error === 'authorization_pending') {
      await sleep(interval, signal);
      continue;
    }
    if (data.error === 'slow_down') {
      interval += 5000;
      await sleep(interval, signal);
      continue;
    }
    if (data.error === 'expired_token') {
      throw new Error('Device code expired — please try again');
    }
    if (data.error === 'access_denied') {
      throw new Error('Authorization denied by user');
    }
    throw new Error(`Unexpected OAuth error: ${data.error}`);
  }

  throw new Error('Device code expired — please try again');
}

// Fetch the authenticated user's login name.
export async function fetchGitHubUser(token) {
  const resp = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GitHub API error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return { login: data.login };
}

// URL where the user can manually revoke the OAuth app's access.
export function getGitHubRevokeUrl() {
  return `https://github.com/settings/connections/applications/${GITHUB_CLIENT_ID}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Device flow cancelled'));
      }, { once: true });
    }
  });
}
