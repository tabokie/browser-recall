# Extension Icons

The extension default icon uses the two-eye artwork from
`icons/browser-recall-default-transparent.svg`, enlarged and rendered on an
opaque background into Chrome's required icon sizes:

- `icon16.png` - 16x16 pixels
- `icon48.png` - 48x48 pixels
- `icon128.png` - 128x128 pixels

Runtime state icons are generated from the same root icon source folder:

- `icon*-stop-recording.png` from `icons/browser-recall-stop-recording-transparent.svg`
- `icon*-special-lists.png` from the default eye artwork on a list-color background
- `icon*-special-notes.png` from the default eye artwork on a snapshot-color background
- `icon*-special-mixed.png` from the default eye artwork on the mixed-state background

The desktop tray icon is generated from
`icons/browser-recall-default-transparent.svg` so it remains transparent for
macOS template rendering. The full-sized desktop app icon is generated
separately as `icons/icon.icns` and `icons/icon.png` from
`icons/browser-recall-default.svg`.

These icons represent your extension in:

- The browser toolbar (16px)
- The extensions management page (48px)
- The Chrome Web Store (128px)

Regenerate all desktop and extension PNG icons with:

```sh
node scripts/generate-icons.mjs
```
