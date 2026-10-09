# Browser Recall — Privacy Policy

**Last updated:** October 9, 2026

Browser Recall stores product data locally. Browser Recall does not send analytics
or browsing data to a developer-operated service. Optional GitHub sync uses a
repository selected by the user.

## Data recorded

When recording is enabled, Browser Recall records page URLs, titles, visit times,
time on page, and scroll depth. User actions can add highlights, annotations,
ratings, lists, rules, edited titles, and imported bookmarks or history.

Explicit snapshot capture saves page HTML, embedded resources, and extracted text.
Snapshot content can include information displayed on the captured page.
Snapshot capture preserves non-password form values and can include personal
information, health information, financial information, personal communications,
or location information present on the page. Password and file input values are
cleared during capture; other sensitive page content is not automatically redacted.

Local configuration stores a device ID, approved browser installations, connection
tokens, and recent connection activity. Settings control recording, excluded URLs,
display, and sync. Stop recording pauses capture across the browser extension.
The daemon, the desktop app's local data service, applies URL exclusions.

## Local storage

The desktop app writes event logs, JSON files describing current pages and lists,
notes, and snapshots to the folder chosen during setup. Product data uses JSON,
JSONL, HTML, and Markdown files. The data folder can be copied or backed up directly.

Extension storage holds pairing details, connection details, recording status, and
commands waiting briefly to be sent to the desktop. Snapshot HTML is sent directly
to the desktop without being saved in extension storage. Desktop configuration and
local diagnostic logs are stored separately from the product data folder.

The browser extension communicates with the paired desktop daemon through a
WebSocket connection on the same computer. Snapshot capture may request page resources from
the servers that host those resources.

## Optional GitHub sync

GitHub sync is disabled by default. When enabled, Browser Recall uses the supplied
personal access token to contact GitHub and upload recent logs from the current
device and note JSON files to the configured repository. Snapshot HTML and Markdown files are
not uploaded by the current sync implementation.

Repository permissions determine who can access synced data. Remembered GitHub
tokens are stored in local desktop configuration; tokens can also be kept only for
the current session. Browser Recall does not provide a hosted sync service.

## Browser permissions

| Permission | Purpose |
| --- | --- |
| `storage` | Desktop connection credentials, recording status, and pending commands |
| `tabs` | Identify tabs and perform current-page actions |
| `scripting` | Run highlight and snapshot scripts; read the original page URL from saved snapshots |
| `webNavigation` | Page and same-document navigation detection |
| `contextMenus` | Highlight Selected right-click action |
| `alarms` | Retry the desktop connection and send queued commands |
| `declarativeNetRequestWithHostAccess` | Temporary rules allowing appropriate referrer headers when downloading snapshot resources |
| `webRequest` | Snapshot redirect and response-header inspection |
| `<all_urls>` host access | Page capture, highlights, and snapshot resources on supported pages |

Chrome's separate **Allow access to file URLs** setting enables extension actions
on snapshots opened as local files.

## Deletion

Removing the extension removes the extension's stored data but leaves the desktop
library intact. Quit Browser Recall and standalone daemons before deleting the
selected data folder, or use Delete under desktop Settings → Data.

Local deletion does not remove copies in backups or GitHub repository history.
Delete those copies separately when removing all retained data. Desktop
configuration and diagnostic logs must also be removed separately for a complete
local uninstall.

## Limited use

Browser Recall's use and transfer of information received from Chrome APIs adheres
to the Chrome Web Store User Data Policy, including the Limited Use requirements.
Browser Recall uses browsing data only to provide the user's browsing library.
Browser Recall does not sell user data or use user data for advertising,
creditworthiness, or lending. Optional GitHub sync transfers data only to the
repository configured by the user for the browsing library.

## Contact

For privacy questions, open an issue in the project's GitHub repository.
