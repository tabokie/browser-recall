// GitHub API helpers for browser-recall.
// Loaded by options.html via <script>.

// Fetch the authenticated user's login name.
export async function fetchGitHubUser(token) {
  const resp = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GitHub API error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return { login: data.login };
}
