# browser-recall — Privacy Policy

**Last updated:** April 2026

## What data browser-recall collects

browser-recall records the following data as you browse:

- **Page URLs and titles** from your browsing history
- **Page visit timestamps** and visit duration
- **User-created notes** attached to pages
- **Text highlights** you select on pages
- **Page snapshots** (full offline copies) when you explicitly capture them
- **Likes/dislikes** you assign to pages
- **Lists** you create to organize pages
- **Smart rules** you configure for automatic page categorization

## Where your data is stored

All product data is stored in a **local folder on your device** that you choose during desktop setup. Browser Recall Desktop writes JSONL logs, JSON checkpoints, notes, and snapshots directly through its local daemon. No data is sent to any server by default.

A small amount of connector state is kept in Chrome's built-in extension storage (`chrome.storage.session` and `chrome.storage.local`), such as pairing identity, connection state, and short-lived commands waiting for the desktop app. Product settings and durable history live in the desktop data folder.

## Optional sync

browser-recall offers optional multi-device sync through a transport you configure yourself:

- **GitHub** — syncs to a repository you own, using a personal access token you provide

When sync is enabled, your browsing data is transmitted only to the GitHub repository you configure. browser-recall never sends data to Anthropic, the extension developer, or any Browser Recall cloud service.

## What browser-recall does NOT do

- No analytics or telemetry
- No tracking pixels or fingerprinting
- No data collection by the extension developer
- No advertisements
- No third-party SDKs or services
- No data sharing with any party

## Permissions

browser-recall requests the following Chrome permissions:

| Permission | Purpose |
|---|---|
| `storage` | Store connector pairing/session state and short-lived pending commands |
| `tabs` | Read the URL and title of the active tab |
| `activeTab` | Interact with the current page for highlights and snapshots |
| `scripting` | Inject content scripts for highlights and snapshots |
| `webNavigation` | Detect page navigations for history tracking |
| `contextMenus` | Add right-click menu items (highlight, snapshot, etc.) |
| `alarms` | Retry local desktop connector reconnection and queue draining |
| `<all_urls>` | Content scripts run on all pages to enable highlighting and snapshots |

## Data export

Your data folder IS your export. All data is stored as plain JSON and JSONL files that you can read, copy, or back up at any time without the extension.

## Data deletion

To delete all browser-recall data:

1. Remove the extension from Chrome
2. Delete the data folder you selected during setup

## Contact

For privacy questions or concerns, open an issue at the project's GitHub repository.
