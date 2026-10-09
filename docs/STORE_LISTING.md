# Browser Recall Connector — Chrome Web Store Copy

## Short description

Browser connector for Browser Recall Desktop.

## Detailed description

Browser Recall Connector connects Chrome to a local desktop library of browsing history,
highlights, notes, lists, and saved pages.

- **Find pages:** browse Timeline or search recorded titles, URLs, highlights,
  annotations, and saved snapshot text.
- **Keep highlights:** select text and press Alt+H. Read highlights and annotations
  together in Book.
- **Organize pages:** pin pages to lists from the popup. Keyword rules collect pages
  whose titles match a pattern.
- **Save copies:** press Alt+S to capture a local snapshot and reopen the saved page
  from the desktop app, including offline.

The desktop app must run while browsing. Open the extension popup and approve the
connection in Browser Recall after installation.

Browser Recall stores data in a folder chosen during desktop setup. No Browser
Recall account is required, and Browser Recall sends no analytics. Experimental
GitHub sync shares recent history logs and note files through a repository you
control; snapshot files remain local.

Default shortcuts:

| Shortcut | Action |
| --- | --- |
| Alt+R | Open the popup |
| Alt+H | Highlight selected text |
| Alt+S | Capture a snapshot |
| Alt+L | Like the current page |

On macOS, use Option instead of Alt. Change shortcuts in Chrome's extension settings.

## Listing details

- Category: Productivity
- Language: English
- Privacy policy: [PRIVACY.md](PRIVACY.md)
- Screenshots: [Chrome popup](images/chrome-web-store/browser-popup-window.png)
  and [highlight editor](images/chrome-web-store/browser-note-window.png).
  Both images are 1280 × 800, 24-bit RGB PNGs without alpha.

Global screenshots are shared across language listings. Localized screenshots
belong to the language selected in the dashboard and appear before global
screenshots. Use the English captures as global screenshots, or as localized
screenshots for the English listing. Avoid uploading the same pair in both groups
unless the dashboard requires both. See [Chrome Web Store localization guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-listing#localize_screenshots_and_promotional_video).

Regenerate the store variants on macOS after capturing the browser documentation:

```bash
node scripts/export-chrome-web-store-screenshots.mjs
npm run ci:check-docs
```

Commit both store images with `images/chrome-web-store/capture.json`. The checker
rejects missing, stale, modified, or incorrectly formatted store images.

## Privacy practices form

### Single purpose description

Browser Recall Connector maintains a personal record of browsing in Browser Recall
Desktop. Browser Recall Connector records page visits and lets users save highlights,
annotations, and page snapshots to the paired desktop library so users can find and
revisit pages. Browser Recall Desktop is required. Browsing data is stored on the
user's computer; Browser Recall Connector does not send analytics or browsing data
to a developer-operated service.

### Permission justifications

Each justification below is under the dashboard's 1,000-character limit.

| Field | Text |
| --- | --- |
| `storage` | Stores the browser installation ID, desktop pairing token, connection details, recording status, and commands waiting briefly for the desktop connection. This storage lets the connector reconnect to the approved desktop and deliver pending actions after a brief outage. The desktop library remains in the user's chosen data folder. |
| `tabs` | Reads tab URLs and titles to associate current-page actions and popup information with the correct desktop record. Tab metadata also identifies saved snapshot tabs and unsupported browser pages, including local files before file access is enabled, so the connector can show the appropriate status or access instructions. |
| `scripting` | Runs packaged scripts for page snapshot capture, inspects the original page identity embedded in saved snapshots, and displays feedback for user-initiated page actions. Script files and injected functions are included in the extension package. |
| `declarativeNetRequestWithHostAccess` | During a user-requested snapshot, creates temporary rules to set or remove the Referer header on the connector's own resource downloads according to the page's referrer policy. Each rule targets the exact resource URL and the extension's request origin. The rules are removed after the download. This allows images, styles, and fonts to be preserved in the saved page. |
| `webRequest` | During snapshot resource downloads, reads response headers for the connector's own requests to identify redirect destinations and Referrer-Policy headers. Each redirect is checked before the next request is sent. This preserves page resources while applying the correct referrer policy. The connector does not use this permission to monitor unrelated network traffic. |
| `webNavigation` | Detects completed page navigations, links that open new tabs, and same-document navigation in single-page applications. Navigation events keep recorded page identities, referring-page relationships, popup information, and badges aligned with the page the user is viewing. |
| `contextMenus` | Adds the Highlight Selected right-click action to save the user's selected text as a highlight in Browser Recall Desktop. |
| `alarms` | Schedules reconnection attempts when the paired desktop is unavailable. Alarms wake the extension service worker so the connector can restore the local connection and deliver commands queued during a brief outage. |
| Host permission | Access to <all_urls> allows visit recording and highlight restoration on the websites the user browses, user-requested highlights and snapshots, and retrieval of snapshot resources from other domains. The browsing library is not limited to a fixed set of websites. Local file access supports saved snapshots only when Chrome's separate Allow access to file URLs setting is enabled. Data is sent to the paired desktop on the same computer. |

`activeTab` is not requested. Existing host access supports current-page actions,
and the browser regression scenario verifies highlights, ratings, snapshot capture,
and local snapshot popup behavior without `activeTab`.

### Remote code

Select **No, I am not using Remote code**.

If the dashboard requests an explanation:

All JavaScript executed by Browser Recall Connector is included in the extension
package, including content scripts, snapshot capture scripts, and page navigation
scripts. The connector does not download or evaluate remote JavaScript or Wasm.
Snapshot downloads preserve page resources as data; saved website scripts are not
executed by the connector. The local desktop connection exchanges commands and
data, not extension code.

### Data usage

The directly handled categories are:

- **Web history:** page URLs, titles, referring pages, and visit times.
- **User activity:** time on page and scroll depth.
- **Website content:** selected text, annotations, page HTML, and snapshot resources.
- **Authentication information:** the local desktop pairing token.

The current snapshot capture also preserves arbitrary page content and non-password
form values. A saved page can therefore contain **Personally identifiable
information**, **Health information**, **Financial and payment information**,
**Personal communications**, or **Location**. For the current unrestricted capture
feature, disclose these categories as well; their handling is through user-saved
content, not separate background collection of those data types. Password and file
input values are cleared during snapshot capture. Do not describe snapshot capture
as redacting all sensitive information.

Local processing still requires disclosure. See [Chrome Web Store's User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

The current implementation supports checking all three limited-use certifications:
no sale or transfer outside approved uses, no use unrelated to the single purpose,
and no use for creditworthiness or lending. Optional desktop GitHub sync is a
user-configured transfer supporting the browsing library; the privacy policy
describes the transfer. These certifications remain the publisher's responsibility.

### Privacy policy URL

Publish [PRIVACY.md](PRIVACY.md) at a publicly accessible URL and enter that URL.
A local file path is not a privacy policy URL. Confirm that the published policy
matches the current version before submission.
