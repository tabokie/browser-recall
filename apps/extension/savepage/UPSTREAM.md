# Save Page WE — Upstream Source

## Provenance
- **Extension**: Save Page WE v33.9
- **Author**: DW-dev
- **License**: GNU General Public License v2
- **Chrome Web Store**: https://chromewebstore.google.com/detail/save-page-we/dhhpefjklgkmgeafimnjhojgjamoafof
- **Source mirror**: https://github.com/nicholasdwebb/nicholasdwebb.github.io (may be stale)
- **Browser Recall baseline commit**: `65ed733` (the v33.9 import; use
  `git diff 65ed733 -- apps/extension/savepage/` for the complete maintained
  patch)

## How to get latest source
The authoritative source is the Chrome Web Store .crx file:
1. Get extension ID from store page: `dhhpefjklgkmgeafimnjhojgjamoafof`
2. Download .crx:
   curl -L "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0&acceptformat=crx2,crx3&x=id%3Ddhhpefjklgkmgeafimnjhojgjamoafof%26uc" -o save-page-we.crx
3. Extract (CRX3 = 12-byte header + protobuf header + zip):
   python3 -c "
   with open('save-page-we.crx','rb') as f:
     f.read(4); f.read(4); hl=int.from_bytes(f.read(4),'little'); f.seek(12+hl)
     open('save-page-we.zip','wb').write(f.read())
   "
   unzip save-page-we.zip -d save-page-we-src/
4. Diff against `apps/extension/savepage/` to see our modifications.

## Our modifications (vs upstream)
- Initialization: hardcoded options instead of chrome.storage.local
- Output: sends HTML via chrome.runtime.sendMessage instead of downloading
- UI panels: all stripped (message, lazyload, comments, pageinfo, unsaved, download-iframe)
- Firefox code paths: kept intact (guarded by `isFirefox` flag — zero runtime cost on Chrome, preserves future Firefox portability)
- content-fontface.js: updated chrome.runtime.getURL path for savepage/ subdirectory
- content-frame.js: serializes live shadow roots before cross-origin frame HTML
  crosses the extension message boundary
- content.js: requires Browser Recall's generated streamed-reader and
  capture-budget runtimes, schedules bounded resource loads, and escapes the
  original `srcdoc` value before retaining it as diagnostic metadata

## Intentional Browser Recall divergences

These behaviors are product policy, not upstream drift. Preserve them when
updating the fork unless the policy itself is being changed:

- **Remove hidden elements.** Browser Recall sets `removeElements = true`,
  whereas Save Page WE defaults it to false. This preserves Browser Recall's
  pre-fork visual-archive policy from commit `31a3c49`: omit DOM that was not
  displayed at capture time to reduce snapshot size and avoid invisible page,
  editor, blocker, and advertising elements affecting replay layout. The
  vendored Save Page WE implementation retains its safeguards for essential
  elements and SVG.
- **Do not trigger full lazy-content loading.** `loadLazyContent = false`
  matches Save Page WE's default and avoids scrolling or shrinking the live
  page, capture delays, page mutation, and potentially large amounts of
  additional content. `loadLazyImages = true` remains enabled so lazy image
  URLs already present in the captured DOM are still materialized.
- **Skip video unless explicitly enabled.** Commit `6cb9d5b` added the
  desktop-owned `captureSnapshotVideo` setting after inline video accounted
  for about 130 MB of existing snapshot data. The default is false. A video
  rejected by this policy is an intentional omission, not an unavailable
  resource, and must not increase the user-facing resource-failure count.
- **Retain most unsaved resource URLs.** Browser Recall sets
  `removeUnsavedURLs = false`, preserving its pre-fork behavior of making a
  failed resource URL absolute so it can recover when a snapshot is viewed
  online. Snapshot preparation deliberately makes a narrower exception for
  external stylesheets that remained uncaptured: those links are deactivated
  because a failed stylesheet can block or leave replay blank, while its
  original URL is retained as diagnostic metadata.
- **Report unexpected resource failures, not policy skips.** Capture
  diagnostics retain every HTTP(S) omission with a typed category
  (`network`, `budget`, `security`, `unsupported`, `policy`, or
  `unavailable`) and an `intentional` flag. The user-facing unavailable count
  excludes intentional policy skips such as disabled video; callers can still
  inspect those skips in the structured capture result.

The empty shadow loader and the previously removed upstream aggregate-size
check are not intentional divergences. Browser Recall handles those integration
gaps with explicit maintained boundaries:

- The serializer emits declarative `shadowrootmode="open"` templates.
  `content-frame.js` preserves live shadow trees in retained cross-origin
  frames, and `snapshot-viewer.js` recursively prepares nested `srcdoc`
  documents before replay. Trusted viewer code remains as a fallback while
  snapshot preparation removes the fork's nonfunctional inline loader.
- `packages/core/bounded-response.js` enforces the 50 MB per-resource limit
  against bytes actually read, including chunked responses with no trustworthy
  `Content-Length`, in both the page and host-permission fallback fetch paths.
- Connector protocol v2 advertises the daemon's exact WebSocket message limit.
  `packages/core/snapshot-capture-budget.js` derives the available
  JSON-encoded HTML budget from the complete message envelope. After retained
  frames reply, capture performs a resource-free serializer pass so nested
  frame documents, shadow roots, and their attribute escaping are included in
  the structural reservation. It then keeps mutation overhead, accounts for
  base64/percent expansion and repeated references, shares the remaining
  budget across at most six in-flight resources, and skips later resources
  with a typed `budget` diagnostic. The exact transport preflight remains the
  final guard.
- Snapshot reads reapply the idempotent preparation boundary, so legacy stored
  HTML gets unavailable-stylesheet deactivation, loader removal, identity
  metadata, and declarative shadow attributes without an extension-side
  persistent migration.
