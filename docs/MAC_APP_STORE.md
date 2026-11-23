# Browser Recall for the Mac App Store

## Package

Build on macOS with Xcode. The `mac-app-store` Cargo feature removes GitHub sync,
the GitHub updater, and the JavaScript list rule editor and interpreter. The Mac
App Store bundle configuration sets macOS 13.0 as
the minimum version and applies App Sandbox entitlements for user-selected library
folders, security-scoped bookmarks, the local connector listener, and WebKit's
content process. The bundle includes a privacy manifest declaring that the Mac
App Store build collects no data and uses no tracking.

```sh
npm run build:app-store --workspace @browser-recall/desktop
```

The output is `target/mac-app-store/release/bundle/macos/Browser Recall.app` on
a native build. Verify a local build with
`node scripts/package-mac-app-store.mjs --verify-local`.

For distribution, register `app.browser-recall.desktop` and create a matching
Mac App Store provisioning profile. Create a local Tauri configuration overlay
that adds the profile at `bundle.macOS.files["embedded.provisionprofile"]` and
points `bundle.macOS.entitlements` to a copy of `scripts/app-store.entitlements`.
Add `com.apple.application-identifier` and `com.apple.developer.team-identifier`
to that copy using the values from the profile. Set `bundle.copyright` to the
publisher's copyright notice and `bundle.macOS.bundleVersion` to an unused build
number for this version. Set `APPLE_SIGNING_IDENTITY` to the distribution
application certificate and `MAC_INSTALLER_DISTRIBUTION_IDENTITY` to the Mac
Installer Distribution certificate.

```sh
npm run build:app-store --workspace @browser-recall/desktop -- \
  --config /absolute/path/to/store-signing.json
node scripts/package-mac-app-store.mjs --package "$BUILD_NUMBER"
```

Set `BUILD_NUMBER` to the same build number as the signing overlay. The packaging
command checks the application signature, sandbox entitlements, embedded profile,
and build number before writing the installer to `dist/mac-app-store/`. Validate
that installer in Transporter. Install the processed build through TestFlight in
a disposable macOS account and exercise the review steps below. Also test
selecting an existing library, a full quit and relaunch, revoking a browser, and
a fresh launch with the browser extension absent. If the build includes Intel
support, verify both executable architectures.

[Tauri Mac App Store packaging](https://v2.tauri.app/distribute/app-store/) ·
[Apple upload and validation](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/) ·
[Apple export compliance](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation/).

## Listing

- **Category** — Productivity
- **Subtitle** — Search your reading history
- **Keywords** — bookmarks,highlights,annotation,offline,snapshots,web,timeline,notes,library
- **Support URL** — [Browser Recall Support](https://github.com/tabokie/browser-recall/blob/main/docs/SUPPORT.md)
- **Privacy Policy URL** — [Browser Recall Privacy Policy](https://github.com/tabokie/browser-recall/blob/main/docs/PRIVACY.md)
- **Mac screenshots** — [Timeline](images/mac-app-store/timeline.jpg) and [Book](images/mac-app-store/book.jpg)

Browser Recall helps you find what you’ve read. Browse your history in Timeline,
read highlights and notes together in Book, and organize pages into lists. Search
titles, addresses, highlights, notes, and saved page text from one place.

Import bookmarks or try the included sample library to get started. For automatic
visit recording and saving pages from the browser, install Browser Recall
Connector from the Chrome Web Store or Firefox Add-ons and approve recording in
the desktop app. You can pause recording anytime from the browser toolbar.

Browser Recall stores your library in a folder you choose. Saved pages can be
reopened offline.

Publish Browser Recall Connector 1.0.2 or newer on both browser stores so the
snapshot behavior matches the updated Privacy Policy. `npm run build:extension`
stages the Chrome and Firefox artifacts under `dist/extension/`. Verify the
public connector versions and both listing links while signed out before
submitting the Mac App Store build.

## App Store Connect declarations

- **App Privacy** — Publish the public Privacy Policy URL and **No, we do not
  collect data from this app** for the Mac App Store build. The library and
  the browser connection stay on the same Mac. Publish the updated Privacy
  Policy and Support pages and verify both URLs before submission.
- **App Information** — Complete Age Ratings and Content Rights. Browser Recall
  opens live links in the default browser. User-saved notes and snapshots are
  stored in a private library. Consider the user-selected third-party material
  when answering Content Rights.
- **Export Compliance** — Answer for the uploaded build and its linked libraries.
  Use the questionnaire if `ITSAppUsesNonExemptEncryption` is unset.
- **App Review Information** — Provide the publisher's review contact, leave
  **Sign-in required** unchecked, paste the notes below, and attach
  [`review-bookmarks.html`](review-bookmarks.html).
- **Digital Services Act** — Declare the publisher's trader status in
  **Business → Agreements → Compliance** when prompted. Verify the public
  trader contact information if applicable.

## App Review notes

Browser Recall is a local reading library. Choose a folder and finish setup.
On Timeline, select **Try Sample Library**. Search for **A quieter way to read**
in the sample list, open its saved page offline, and open **Book** to see the
sample highlight. Return to **Sample Library** and select **Remove Sample Library**
to move the included example to the Recycle Bin. To test import, use **Import
Bookmarks** on the empty Timeline and choose the attached `review-bookmarks.html`.

For live capture, install Browser Recall Connector from the
[Chrome Web Store](https://chromewebstore.google.com/detail/browser-recall-connector/bgghgkobpfgcinpjjeeconciefclpdgp)
or [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/browser-recall-connector/).
Open the extension popup, refresh the connection if prompted, and choose
**Allow recording** in Browser Recall. Visit `https://example.org/` and look for
the visit in Timeline. Pin the extension to the browser toolbar to see its icon.
Pause recording from the popup and check that the toolbar icon changes. Open
`https://example.org/?browser-recall-review=paused` and confirm the visit does not
appear in Timeline. Resume recording and visit a new address to confirm capture
has resumed. The browser popup also saves snapshots on request. Quit Browser
Recall and reopen it to verify the library reopens without requesting the folder
again.

The extension communicates with the desktop app over an authenticated WebSocket
on the same Mac. Browser Recall stores visits and user-requested captures in the
selected folder. Keyword and regular-expression list rules match page titles.
Browser Recall works without an account.
