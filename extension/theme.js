// Theme management — shared by options.js, popup.js
// Values: 'light', 'dark', 'system' (default)

export async function applyTheme() {
  const { theme } = await chrome.storage.session.get(['theme']);
  const effective = theme || 'system';
  if (effective === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', effective);
  }
  return effective;
}
