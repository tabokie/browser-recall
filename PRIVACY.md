# Browser Recall — Privacy Policy

**Last updated:** April 2026

## What data Browser Recall collects

Browser Recall records the following data as you browse:

- **Page URLs and titles** from your browsing history
- **Page visit timestamps** and visit duration
- **User-created notes** attached to pages
- **Text highlights** you select on pages
- **Page snapshots** (full offline copies) when you explicitly capture them
- **Likes/dislikes** you assign to pages
- **Lists** you create to organize pages
- **Smart rules** you configure for automatic page categorization

## Where your data is stored

All data is stored in a **local folder on your device** that you choose during setup. Browser Recall uses the File System Access API to read and write files directly to this folder. No data is sent to any server by default.

A small amount of session state (UI preferences, in-flight log entries) is kept in Chrome's built-in extension storage (`chrome.storage.session` and `chrome.storage.local`). This data never leaves your browser.

## Optional sync

Browser Recall offers optional multi-device sync through transports you configure yourself:

- **GitHub** — syncs to a repository you own, using a personal access token you provide
- **Filesystem** — syncs to a shared folder (e.g., cloud drive) you designate
- **WebDAV** — syncs to a WebDAV server you control

When sync is enabled, your browsing data is transmitted only to the service you configure. Browser Recall never sends data to Anthropic, the extension developer, or any third party.

## What Browser Recall does NOT do

- No analytics or telemetry
- No tracking pixels or fingerprinting
- No data collection by the extension developer
- No advertisements
- No third-party SDKs or services
- No data sharing with any party

## Permissions

Browser Recall requests the following Chrome permissions:

| Permission | Purpose |
|---|---|
| `storage` | Store session state and pending log entries |
| `tabs` | Read the URL and title of the active tab |
| `activeTab` | Interact with the current page for highlights and snapshots |
| `history` | Detect revisits to previously seen pages |
| `offscreen` | Run filesystem I/O in a background document |
| `scripting` | Inject content scripts for highlights and snapshots |
| `webNavigation` | Detect page navigations for history tracking |
| `contextMenus` | Add right-click menu items (highlight, snapshot, etc.) |
| `alarms` | Schedule periodic sync and drain timers |
| `<all_urls>` | Content scripts run on all pages to enable highlighting and snapshots |

## Data export

Your data folder IS your export. All data is stored as plain JSON and JSONL files that you can read, copy, or back up at any time without the extension.

## Data deletion

To delete all Browser Recall data:

1. Remove the extension from Chrome
2. Delete the data folder you selected during setup

## Contact

For privacy questions or concerns, open an issue at the project's GitHub repository.
