# 17 — Dark Mode

## Context

Independent of plans 10-16. The extension needs a three-way theme toggle (Light/Dark/System) for Chrome Web Store release. Stored in `chrome.storage.session` — defaults to "System" on each browser session.

The CSS architecture already uses CSS custom properties extensively (`:root` in options.html). Dark mode = override these variables under a selector.

## Design

### Theme storage

Key: `theme` in `chrome.storage.session`. Values: `'light'`, `'dark'`, `'system'` (default on fresh session).

### CSS approach

Add a `[data-theme="dark"]` attribute selector on `<html>` that overrides the `:root` custom properties. The warm palette inverts to a dark warm palette:

```css
html[data-theme="dark"] {
  --bg-base: #1a1412;
  --bg-ambient: radial-gradient(ellipse at 20% 20%, rgba(140, 80, 40, 0.15) 0%, transparent 50%),
                radial-gradient(ellipse at 80% 60%, rgba(100, 80, 140, 0.08) 0%, transparent 50%),
                linear-gradient(160deg, #1e1814 0%, #1a1410 40%, #16120e 100%);
  --bg-surface: rgba(40, 32, 28, 0.6);
  --bg-surface-solid: rgba(40, 32, 28, 0.85);
  --bg-surface-hover: rgba(50, 40, 34, 0.7);
  --bg-surface-active: rgba(60, 48, 38, 0.8);
  --bg-sidebar: rgba(30, 26, 22, 0.7);
  --border-glass: rgba(80, 68, 58, 0.4);
  --border-glass-strong: rgba(90, 76, 64, 0.5);
  --border-subtle: rgba(100, 85, 70, 0.2);
  --text-primary: #e8ddd0;
  --text-secondary: #b8a898;
  --text-muted: #887868;
  --accent-primary: #e08040;
  /* ... remaining overrides ... */
  --shadow-float: 0 1px 2px rgba(0,0,0,0.2), 0 4px 8px rgba(0,0,0,0.15);
  /* ... etc ... */
}
```

### Theme application

Create `extension/theme.js` (shared by options.js, popup.js, snapshot-viewer.js):

```js
export async function applyTheme() {
  const { theme } = await chrome.storage.session.get(['theme']);
  const effective = theme || 'system';
  if (effective === 'system') {
    // Remove data-theme, let prefers-color-scheme handle it
    // But we need CSS for prefers-color-scheme too
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', effective);
  }
}
```

For "system" mode, add a `@media (prefers-color-scheme: dark)` block that applies the same dark overrides as `[data-theme="dark"]`. To avoid duplication, use a shared selector:

```css
@media (prefers-color-scheme: dark) {
  html:not([data-theme="light"]) {
    /* dark variables */
  }
}
html[data-theme="dark"] {
  /* same dark variables */
}
```

This way:
- `data-theme="dark"` → always dark
- `data-theme="light"` → always light (blocks media query)
- No attribute → follows system (media query applies)

### Settings toggle

Add a three-way select/radio in the settings modal: Light / Dark / System. On change, write to `chrome.storage.session.set({ theme })` and call `applyTheme()`.

### Flash prevention

Call `applyTheme()` as early as possible — ideally a synchronous inline script in `<head>`. But extension CSP blocks inline scripts. Alternative: add `<script src="theme-init.js"></script>` (non-module, synchronous) in `<head>` before any `<style>`. This script reads `chrome.storage.session.get` and sets `data-theme` before first paint.

Problem: `chrome.storage.session.get` is async. Workaround: accept a brief flash on fresh load (session storage is fast, ~1-5ms). Apply theme in the `<script type="module">` entry point before rendering anything visible.

### Pages that need theming

| Page | CSS location | Module entry |
|------|-------------|-------------|
| `options.html` | Inline `<style>` | `options.js` |
| `popup.html` | Inline `<style>` | `popup.js` |
| `snapshot-viewer.html` | Inline `<style>` | `snapshot-viewer.js` |

### Files to modify/create

| File | Action |
|------|--------|
| `extension/theme.js` | **New** — `applyTheme()`, theme constants |
| `extension/options.html` | Add dark mode CSS variables, add theme toggle to settings modal |
| `extension/popup.html` | Add dark mode CSS variables |
| `extension/snapshot-viewer.html` | Add dark mode CSS variables |
| `extension/options.js` | Import theme.js, call `applyTheme()` early in init, add toggle handler |
| `extension/popup.js` | Import theme.js, call `applyTheme()` early |
| `extension/snapshot-viewer.js` | Import theme.js, call `applyTheme()` early |

### Verification

1. E2E test: set theme to "dark", verify `data-theme="dark"` attribute on `<html>`.
2. E2E test: set theme to "light", verify no dark styles applied even with OS dark mode.
3. E2E test: set theme to "system" (default), verify it follows `prefers-color-scheme`.
4. Visual review: check all pages (options, popup, snapshot viewer) in both themes.
5. Full test suite: `npm test && npx playwright test`.
