// Theme management — shared by the desktop UI and connector popup
// Values: 'light', 'dark', 'system' (default)

function getDarkQuery() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return getDarkQuery()?.matches ? 'dark' : 'light';
}

export async function applyTheme() {
  const { theme, colorScheme } = await chrome.storage.session.get([
    'theme',
    'colorScheme',
  ]);
  const effective = theme || 'system';
  document.documentElement.setAttribute('data-theme', resolveTheme(effective));
  if (colorScheme && colorScheme !== 'amber') {
    document.documentElement.setAttribute('data-color-scheme', colorScheme);
  } else {
    document.documentElement.removeAttribute('data-color-scheme');
  }
  return effective;
}

// Re-apply when OS preference changes (only matters for 'system' mode)
getDarkQuery()?.addEventListener('change', () => applyTheme());
