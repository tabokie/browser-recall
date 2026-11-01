# Browser Recall — Privacy Policy

**Last updated:** October 24, 2026

Browser Recall's desktop app and browser extension store data locally and send no
analytics or browsing data to a developer-operated service. Optional GitHub sync
uses a repository chosen by the user. Website analytics are described separately below.

## Data recorded

While recording is enabled, Browser Recall records page URLs, titles, visit times,
time on page, and scroll depth. User actions add highlights, annotations, ratings,
lists, rules, edited titles, and imported bookmarks or history. Stop recording
pauses extension capture; the daemon, the desktop app's local data service, applies
URL exclusions.

User-requested snapshots save page HTML, resources, extracted text, and non-password
form values. Captured pages may contain personal, health, financial, communication,
or location information. Password/file input values are cleared; other sensitive
content is not automatically redacted.

Local configuration stores device identity, approved browsers, connection tokens,
and recent connection activity. Settings control recording, exclusions, display,
and sync.

## Storage and connections

The chosen data folder contains logs, current page/list records, notes, and
snapshots as JSON, JSONL, HTML, and Markdown. The folder can be copied or backed up.
Desktop configuration and diagnostic logs are stored separately.

Extension storage holds pairing/connection details, recording state, and commands
waiting briefly for the desktop. Snapshot HTML goes directly to the desktop without
being saved in extension storage. The paired extension connects to the daemon over
a WebSocket on the same computer. Snapshot capture may fetch resources from their
original hosting servers.

## Optional GitHub sync

GitHub sync is disabled by default. When enabled, the supplied personal access
token uploads recent current-device logs and note JSON to the configured repository.
Snapshot HTML and Markdown are not uploaded.

Repository permissions control access to synced data. Tokens may be saved in local
desktop configuration or kept for the session. Browser Recall provides no hosted
sync service.

## Browser permissions

| Permission                            | Purpose                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| `storage`                             | Connection credentials, recording state, pending commands |
| `tabs`                                | Identify tabs and support current-page actions            |
| `scripting`                           | Highlights, capture, original snapshot identity           |
| `webNavigation`                       | Page and same-document navigation                         |
| `contextMenus`                        | Highlight Selected action                                 |
| `alarms`                              | Reconnect and deliver queued commands                     |
| `declarativeNetRequestWithHostAccess` | Temporary referrer rules for snapshot downloads           |
| `webRequest`                          | Snapshot redirect and response-header inspection          |
| `<all_urls>`                          | Capture, highlights, and resources on supported pages     |

Chrome's **Allow access to file URLs** setting enables actions on local snapshots.

## Deletion

Removing the extension removes extension storage but leaves the desktop library.
Quit Browser Recall and standalone daemons before deleting the data folder, or use
**Settings → Data → Delete**. Desktop configuration and logs require separate
removal for a complete local uninstall.

Local deletion does not remove backups or GitHub repository history. Remove those
copies separately when deleting all retained data.

## Limited use

Browser Recall follows the Chrome Web Store User Data Policy, including Limited
Use requirements. Browsing data serves the user's library. Browser Recall does
not sell data or use data for advertising, creditworthiness, or lending. Optional
GitHub sync transfers data only to the user's configured repository for the library.

## Website analytics

The product website uses GoatCounter for page views, separately from the desktop
app and extension. GoatCounter receives the page path/title, referrer, and basic
visitor information such as browser, operating system, country, language, and
screen size. The page reports `/browser-recall/` without query strings or fragments;
automatic click events are disabled.

GoatCounter stores no cookies or visitor information in the browser. See the
[GoatCounter privacy policy](https://www.goatcounter.com/help/privacy). Local previews
and embedded demos load no analytics. Website analytics receive no history,
highlights, notes, lists, or snapshots from Browser Recall collections.

## Contact

For privacy questions, open an issue in the project's GitHub repository.
