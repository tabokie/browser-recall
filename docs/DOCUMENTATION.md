# Documentation maintenance

Follow the [documentation quality rules](../AGENTS.md#documentation-quality) before
committing Markdown. The procedures below cover screenshot capture and verification.

## Capture screenshots

Documentation capture requires macOS, Xcode Command Line Tools, an active desktop,
Accessibility and Screen Recording permissions, and pinned Playwright Chromium.
Run desktop and browser captures separately; leave capture windows alone.

```bash
npm run docs:screenshots
npm run docs:screenshots:browser
```

Desktop capture uses the Cargo feature `no-tray`. The shared launcher verifies
`BrowserRecallNoTray` bundle metadata and runs `--check-no-tray` before initializing
native application services. No disposable-account flag is needed for verified
no-tray builds. Never bypass the tray-session guard for a regular build.

Capture uses fictional data, a real daemon, separate profiles and bundle identifiers,
and no personal browsing data. Documentation bundles declare no URL schemes in
either the retained build or temporary copy. Native routing checks target the test
app explicitly and verify that the production handler's identity is preserved.

| Capture                            | Window size      | PNG size           |
| ---------------------------------- | ---------------- | ------------------ |
| Timeline, Amber and Mono           | 960 × 620 points | 2080 × 1400 pixels |
| Book, Amber                        | 960 × 620 points | 2080 × 1400 pixels |
| Browser popup and highlight editor | 800 × 434 points | 1760 × 1028 pixels |

Images place native window pixels and shadows over a fixed light Sonoma wallpaper
with 40 points of margin. The asset is
`scripts/assets/documentation-sonoma-light.png`, exported at 2560 × 2560 from
Apple's `Sonoma.heic`. Capture manifests record the asset hash and crop; the current
desktop and other applications are excluded.

Use a high-density Mac and inspect source images at full size: fixed output
dimensions do not guarantee 2× source detail on a 1× display. Before each Timeline
capture, the script verifies the fixed fixture's month in the chart viewport.
Failure evidence remains under `test-results/documentation/`.

The same commands generate three looping GIFs and still images at 720 × 440
pixels under `docs/images/details/`. Desktop capture demonstrates choosing
bookmark folders and importing nested lists. The page-copy sequence selects
three pages with separate clicks, pastes readable titles and URLs into a temporary
TextEdit document, and pastes the text back into a Browser Recall list. TextEdit
runs in a separate process; capture closes only that process and temporary document.
Browser capture demonstrates pausing and resuming through real mouse clicks in the
extension popup, including the native toolbar icon.

Each animation starts with window context and ends with a smooth zoom out. Native
window pixels supply every application state. The compositor draws an arrow
cursor and click rings at the observed control positions, animates pointer movement,
and labels keyboard shortcuts. Only the camera and pointer are interpolated.

The README and website reuse the GIFs. The website selects still images when
reduced motion is preferred. Capture manifests in the detail directory record
source fingerprints, dimensions, animation timing, and hashes. Commit the GIFs,
still images, and manifests together.

While iterating on desktop capture automation, use
`node scripts/capture-documentation.mjs --reuse-build` after the first build.
The command verifies the retained no-tray bundle, executable hash, and compiled
source fingerprints before reusing the build. Application changes require a
capture without `--reuse-build`.

## Verify and export

Commit captured images with `docs/images/capture.json` and
`docs/images/browser-capture.json`. Never update fingerprints without a successful
capture.

```bash
node scripts/compose-documentation-hero.mjs
node scripts/export-chrome-web-store-screenshots.mjs
npm run ci:check-docs
npm run ci:check-docs -- --images-only
```

The composer requires matching source/input hashes. Changing the composer requires
new desktop captures. Chrome Web Store exports crop wallpaper only, scale uniformly,
and produce opaque 1280 × 800 RGB PNGs under `docs/images/chrome-web-store/`.
Commit both exports and their `capture.json`. Staging uses the destination volume
so a failed conversion preserves previous output.

The checker validates image dimensions, hashes, capture inputs, GIF frames and
infinite looping, README image links, and store-export freshness/format.
`--images-only` skips source fingerprints but
still checks export provenance. Linux CI checks image integrity; local CI also
checks capture-source freshness.

Desktop fingerprints include native shell source, capabilities, build scripts,
Cargo dependencies, and toolchains. Package fingerprints include versions,
dependencies, runtime exports, and toolchains, excluding descriptive metadata and
package commands. Top-level guides, `docs/` prose, package commands, and daemon
sources do not require recapture. Files inside captured source directories remain
fingerprinted. See [Codebase Map](CODEBASE_MAP.md#builds-and-scripts) for capture and
verification implementations.
