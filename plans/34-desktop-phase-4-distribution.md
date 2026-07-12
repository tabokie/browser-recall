# 34 — Desktop Split, Phase 4: Distribution + Release

> Part of [29-desktop-split-master.md](./29-desktop-split-master.md). After [33-phase-3](./33-desktop-phase-3-ui-port.md).

## Goal

Sign and ship v1.0.0 of the desktop app for macOS and Windows. Publish the connector extension to the Chrome Web Store. Wire auto-update. Verify the original Brave bug is genuinely solved.

## Code signing

### macOS

- Enroll in Apple Developer Program ($99/year). Allow ~24h for approval.
- Generate **Developer ID Application** certificate (not Mac App Store cert).
- Configure `tauri.conf.json` for code signing + hardened runtime + entitlements.
- Set up notarization via `notarytool` with an app-specific password or API key.
- Stapling: `xcrun stapler staple` on the signed `.app` so notarization works offline.

### Windows

- Purchase OV authenticode cert ($150-250/year from SignPath, Certum, or SSL.com). Allow 1-2 weeks for identity verification.
- `signtool sign /a /tr http://timestamp.sectigo.com /td sha256 /fd sha256` against the MSI output from Tauri's bundler.
- Accept SmartScreen warnings for the first weeks of releases. Reputation accumulates with installs; warnings fade.
- (Defer EV cert purchase unless adoption complaints make it worth $300-700/year for the immediate-trust upgrade.)

### Secrets management

- CI signs releases. Apple credentials and Windows cert in GitHub Actions secrets.
- Manual override: signing keys also stored in 1Password / equivalent for emergency manual signing.
- Rotation procedure documented in the DEVELOPMENT.md release section (no separate `docs/release.md`).

## Auto-updater

Tauri's built-in updater:

- Update manifest hosted at `https://releases.browser-recall.app/{platform}/{arch}/manifest.json` (or a GitHub Releases-backed static manifest, simpler for v1).
- Daemon polls daily; user-prompted install on app launch with a "Restart to update" option.
- Updater verifies signature against a hardcoded public key embedded in the binary. Critical for security — without this, a compromised update server pwns every user.

Generate the updater signing keypair once; commit the public key to the repo, store the private key offline (1Password / hardware token).

## Release pipeline (CI)

GitHub Actions workflow:

1. Trigger: tag matching `v*.*.*` on main.
2. Job matrix: macOS-latest (x86 + arm64 universal binary), windows-latest (x64).
3. Per-platform: install Rust + Node, build daemon, sign, notarize (mac), package installer.
4. Upload artifacts to GitHub Releases.
5. Update the update manifest (commit to repo or push to S3).
6. Cross-platform job: bundle the connector extension as a `.zip` and upload (no auto-publish to CWS — that's manual, see below).

Test the full pipeline against a `v0.0.1-rc1` tag before tagging v1.

## Connector extension publication

- **Chrome Web Store**: new listing for the connector. Listing copy explains it's the companion to the desktop app, with a link to download.
- Manifest permissions in the connector are much smaller than the current extension's — review the resulting permission list and update `STORE_LISTING.md`.
- Privacy disclosures: connector sends data to `127.0.0.1` only, never makes outbound network requests, never reads/writes user files. Update `PRIVACY.md` to reflect the new architecture.
- Screenshots + promo images: refresh to show the desktop app + popup, not the old options page.
- Review timeline: 1-3 business days typically.

(Firefox AMO and Edge Add-ons listings are deferred per the master plan's non-goals.)

## Brave-on-macOS regression test

The full-stack E2E from Q14 includes a test that:

1. Spawns the daemon in a tempdir.
2. Launches Brave (not Chrome — verify Playwright supports Brave with `executablePath`).
3. Loads the connector extension.
4. Pairs.
5. Opens example.com, example.org, a Wikipedia page.
6. Asserts events land in `~/.tmp/.../data/logs/.../*.jsonl`.
7. **Asserts the connector never enters the `connector_buffer_full` state and the daemon never logs a WebSocket disconnect during the run.**

This test must pass on CI before v1 ships. It is the regression test that proves the architecture solves the original problem.

## Release notes for v1.0.0

Things to call out explicitly in the release post:

- New: desktop app + connector extension architecture (this is a fresh product).
- Why: reliability across browsers (the Brave issue, etc.) and always-on capture.
- Install: download the desktop app, install the Chrome extension, click Allow when prompted.
- Privacy: data lives in your local folder; nothing leaves your machine unless you configure GitHub sync.
- Roadmap: Firefox connector, LAN sync, global hotkey — all post-v1.

## Docs updates (part of this phase)

### PRIVACY.md

Rewrite to reflect the split architecture:

- **Data location**: lives in the folder the user explicitly picked in onboarding. Never leaves the device unless sync is configured.
- **Network behavior**: connector extension makes exactly one kind of outbound connection — WebSocket to `127.0.0.1` on the daemon's port. Daemon makes outbound connections only for sync (GitHub API when enabled) and auto-update manifest fetch.
- **Threat model**:
  - Network eavesdropping: loopback traffic doesn't leave the machine; not the threat.
  - Malicious webpage: blocked by `Origin` header check and token auth.
  - Other browser extension: blocked by `Origin` check (different extension ID).
  - Different user account on same machine: blocked by filesystem permissions on the data folder + daemon config.
  - Another machine on LAN: blocked by `127.0.0.1`-only binding.
  - Malicious process running as your user: has equal access via filesystem OR IPC — same access ceiling.
- **Token storage**: plain file in daemon's config dir (same access boundary as the data folder). OS keychain integration is a future enhancement, not v1.
- **Logs**: daemon logs to `~/Library/Logs/browser-recall/` (mac) / `%LOCALAPPDATA%\browser-recall\logs\` (win). Tokens redacted. 7-day retention.

### DEVELOPMENT.md

Add a section on the new development workflow:

- **Running the daemon locally**: `cd apps/desktop && npm run dev` starts Tauri in dev mode with the Rust side recompiling on save.
- **Dev data folder convention**: point the daemon at a dedicated dev folder (e.g., `~/browser-recall-dev`) to avoid collisions with personal use. Set via the picker on first launch; overridable via `BROWSER_RECALL_DATA_DIR` env var.
- **Loading the connector extension**: `apps/extension/` loaded as an unpacked extension; `BROWSER_RECALL_DAEMON_PORT` env var or a dev toggle in the stub options page overrides the default port probe for testing.
- **Running daemon-driven integration tests**: `npm run test:integration` spawns the built daemon binary and drives it from a Node WebSocket client. No browser needed.
- **Running full-stack E2E**: `npm run test:e2e` — Playwright, slow, only runs on CI in main-branch workflow normally.
- **Hot reload of UI**: Tauri's dev mode reloads the webview on HTML/CSS/JS saves. Rust side recompiles via `cargo watch`.
- **Rebuilding the WASM search engine**: no longer applicable (Phase 2 removed the WASM target).

## Manual release checklist

- [ ] Tag pushed and CI green.
- [ ] Signed mac DMG installs on a clean macOS VM without Gatekeeper warnings.
- [ ] Signed Windows MSI installs on a clean Windows VM (SmartScreen warning expected for OV cert; accept and verify install).
- [ ] Auto-updater: install old build, push new tag, verify update is offered and applies.
- [ ] Connector extension submitted to CWS.
- [ ] Brave-on-mac E2E passes locally and on CI.
- [ ] `~/browser-data` adopt-in-place verified by the dev's own data folder.
- [ ] PRIVACY.md, STORE_LISTING.md, README.md, DEVELOPMENT.md updated for the new architecture.
- [ ] Release post drafted.

## End state

- v1.0.0 is downloadable from the project site as signed installers for macOS and Windows.
- The connector extension is in the Chrome Web Store.
- Auto-update is wired and tested.
- The original Brave bug is closed by E2E proof.
- The product is shipped.

## Risks

- **Apple notarization can fail intermittently** on transient API issues. Build retry into the CI step.
- **Windows SmartScreen** will show warnings for an unknown-publisher OV cert for several weeks of releases. Expect support questions.
- **Update manifest hosting**. If the manifest goes down, every install fails to update. Use a CDN-backed static host or GitHub Releases (high-availability free option).
- **Linux is not in v1**, but users will ask. Have a one-paragraph response: "Build from source for now; first-class Linux installers in v1.x."
- **Operational burden begins now.** A day a month of release ops (cert renewal, notarization tweaks, CWS review responses, update manifest health) is the new permanent cost of being a desktop product.
