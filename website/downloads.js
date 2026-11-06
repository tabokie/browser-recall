// GitHub release filenames include the version. Resolve the published installer
// independently of the website's version; the static link remains a fallback.
async function resolveWindowsInstaller() {
  const link = document.getElementById('windows-download');
  if (!link) return;
  try {
    const response = await fetch(
      'https://api.github.com/repos/tabokie/browser-recall/releases/latest',
      {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) return;
    const release = await response.json();
    if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name)) return;
    const filename = `browser-recall-${release.tag_name}-windows-x64-setup.exe`;
    const url = `https://github.com/tabokie/browser-recall/releases/download/${release.tag_name}/${filename}`;
    if (
      release.assets.some(
        (asset) =>
          asset.name === filename && asset.browser_download_url === url,
      )
    ) {
      link.href = url;
    }
  } catch {
    // Blocked, unavailable, or invalid API responses leave the latest-release
    // link usable, just as when JavaScript is disabled.
  }
}

resolveWindowsInstaller();
