# 19 — Store Assets & Manifest Update

## Context

Final step before Chrome Web Store submission. Needs: updated manifest (name, version, description), privacy policy, store listing description, and icon/screenshot generation.

## Design

### manifest.json updates

```json
{
  "name": "browser-recall",
  "version": "1.0",
  "description": "Save your browsing history, notes, and highlights to a local folder you control."
}
```

### Privacy policy: `docs/PRIVACY.md`

Create in repo root. Cover:
- What data is collected (browsing history URLs, page titles, user-created notes, highlights, snapshots)
- Where data is stored (user-selected local directory, never uploaded unless sync enabled)
- Optional GitHub sync (user's own repo, user's own token)
- No analytics, no tracking, no third-party services
- No data collection by the extension developer
- Contact info

### Store listing

**Short description** (132 chars max):
"Save your browsing history, notes, and highlights to a local folder you control. Your data stays on your device."

**Detailed description**:
Draft covering: local-first storage, browsing history tracking, full-text search, notes & highlights, page snapshots, multi-device sync via GitHub, keyboard shortcuts, function rules.

### Icons

Current icons are already 16/48/128. They need to:
1. Be visually appropriate for "browser-recall" branding
2. Have the downtime variants (from plan 12)
3. Look good on Chrome Web Store (128x128 with transparent/white background)

Evaluate existing icons and determine if redesign is needed or if current ones suffice.

### Screenshots (1280x800)

Need 3-5 screenshots showing:
1. Options page — main history view with sidebar
2. Popup — quick view of current page
3. Content script — highlights and notes on a page
4. Settings — directory picker and configuration
5. Search — full-text search results

These should be captured from a real instance with sample data. Can be done manually or scripted via Playwright.

### Files to create/modify

| File | Action |
|------|--------|
| `extension/manifest.json` | Update name, version, description |
| `docs/PRIVACY.md` | **New** — privacy policy |
| `docs/STORE_LISTING.md` | **New** — store description drafts |
| `extension/icons/*` | Evaluate/update if needed |

### Verification

1. Load updated extension in Chrome — verify manifest changes work.
2. Review privacy policy for completeness.
3. Verify all required store listing fields are covered.
4. Full test suite: `npm test && npx playwright test`.
