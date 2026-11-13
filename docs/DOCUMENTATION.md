# Documentation maintenance

Follow the [documentation quality rules](../AGENTS.md#documentation-quality) before
committing Markdown. The procedures below cover GIF editing, native capture, and verification.

## Edit one GIF

For framing, frame selection, or timing changes, regenerate only the named GIF:

```bash
npm run docs:gifs -- recording-pause
npm run docs:gifs -- bookmark-import
```

Edit the matching entry in `scripts/documentation-gifs.json`. `endFrame` is the
zero-based last frame to keep; `null` keeps every frame. `lastFrameSeconds` controls
the final hold, and `clicks` records the visible actions. Recording pause keeps the
first pause click and holds the closed-eye state before looping.

`frameSeconds` overrides individual frame holds. `clickRipples` optionally adds
white click rings with dark outlines over controls that hide the orange rings.
Each ripple specifies a saved frame, its cursor position in output pixels, and
its expansion phase from zero to one. Click overlays have a separate cache, so
adjusting ripple contrast leaves the saved camera composition intact.

`zoom` enlarges the composed scene around an output-pixel anchor (`x`, `y`).
The magnification eases from one to `scale` between `startFrame` and `endFrame`,
then holds. The window, wallpaper, pointer, and click rings scale together.

`marginPixels` sets the wallpaper border in the window overview.
`windowRadiusPixels` rounds the native window in scene coordinates. The window
and wallpaper share one camera: zooming into the interface moves the window edges
and wallpaper out of view. Close-ups fill the animation without an inset frame.

`scene` records native window dimensions, camera poses, and overview frames for
each application state. Camera poses use pixels relative to the window's top-left
corner; intermediate poses use the capture timeline's easing. Saved overview and
context frames fill surroundings omitted by a tight source crop. Update scene
coordinates when native capture geometry or action sequences change.

The generator reuses saved captures under `docs/images/details/sources/` and changes
only the selected GIF, its saved derivatives, and its detail manifest. Framing uses
macOS ImageIO and is cached separately. Frame selection and timing edits reuse the
framed source without recompressing pixels and work on every platform. Other GIFs,
still images, and screenshots remain unchanged. Each GIF records its own recipe
and editing-tool fingerprints, so changing one recipe does not stale another GIF.
The checker verifies source and framing hashes, then checks the output against
the saved frames and timing recipe.

Native capture commands below refresh the saved source and apply the recipe
automatically. Use native capture when application visuals or capture actions
change. Commit saved sources with the generated GIFs and manifests.

## Refresh the Finder sample

The website's Finder window explores fictional files under the production
`logs/`, `objects/`, and `views/` paths, alongside `AGENTS.md`. Generate the sample
with Rust installed:

```bash
npm run docs:finder
npm run build:website
```

The generator applies sample events through production replay, derives real page
slugs and shard directories, and includes HTML and Markdown snapshot payloads.
Note filenames use the production `YYMMDD-<excerpt>-<hash>.json` format, and the
sample device is `my-macbook`. Logs and the device folder start expanded.
Commit `website/demos/finder-data.json` with changes to the generator or storage
layout. Website builds only copy the generated data and need no Rust toolchain.

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

The same commands generate two looping GIFs and still images at 720 × 440
pixels under `docs/images/details/`. Desktop capture demonstrates choosing
bookmark folders and importing nested lists. Browser capture demonstrates pausing
and resuming through real mouse clicks in the extension popup, including the native
toolbar icon.

Each animation starts with window context, holds the focused result, and loops
directly to the first frame. Native window pixels supply every application state.
The compositor draws an arrow cursor and click rings at the observed control
positions and animates pointer movement. Only the camera and pointer are interpolated.

The README uses the GIFs. Capture manifests in the detail directory record
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

The checker validates image dimensions, hashes, capture inputs, GIF frames,
infinite looping, cursor and click coverage, the focused ending, README image
links, and store-export freshness/format. `--images-only` skips source fingerprints
but still checks export provenance. Linux CI checks image integrity; local CI also
checks capture-source freshness.

Desktop fingerprints include native shell source, capabilities, build scripts,
Cargo dependencies, and toolchains. Package fingerprints include versions,
dependencies, runtime exports, and toolchains, excluding descriptive metadata and
package commands. Top-level guides, `docs/` prose, package commands, and daemon
sources do not require recapture. Files inside captured source directories remain
fingerprinted. See [Codebase Map](CODEBASE_MAP.md#builds-and-scripts) for capture and
verification implementations.
