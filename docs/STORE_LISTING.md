# Browser Recall Connector — Chrome Web Store Copy

## Short description

Browser connector for Browser Recall Desktop.

## Detailed description

Browser Recall Connector connects Chrome to a local desktop library of history,
highlights, notes, lists, and saved pages.

- **Find pages:** browse Timeline or search titles, URLs, highlights, annotations,
  and snapshot text.
- **Keep highlights:** select text and press Alt+H. Read highlights and annotations
  together in Book.
- **Organize pages:** pin pages to lists. Keyword rules collect matching titles.
- **Save copies:** press Alt+S to capture a snapshot and reopen the saved page,
  including offline.

The desktop app must run while browsing. Open the extension popup and approve the
connection in Browser Recall after installation.

Data stays in the folder chosen during desktop setup. No Browser Recall account
is required, and the application sends no analytics. Experimental GitHub sync
shares recent logs and notes through your repository; snapshots stay local.

| Shortcut | Action              |
| -------- | ------------------- |
| Alt+R    | Open popup          |
| Alt+H    | Highlight selection |
| Alt+S    | Capture snapshot    |
| Alt+L    | Like current page   |

On macOS, use Option instead of Alt. Change shortcuts in Chrome's extension settings.

## Listing assets

- Category: Productivity. Language: English.
- Privacy policy: publish [PRIVACY.md](PRIVACY.md) at a public URL matching the
  current policy; a local file path is insufficient.
- Screenshots: [popup](images/chrome-web-store/browser-popup-window.png) and
  [highlight editor](images/chrome-web-store/browser-note-window.png), both opaque
  1280 × 800 RGB PNGs.

Use English captures as global screenshots or English-localized screenshots.
Localized images appear before global images; avoid duplicating the pair unless
required by the dashboard. See [localization guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-listing#localize_screenshots_and_promotional_video).
Regeneration and provenance checks are in [Documentation](DOCUMENTATION.md#verify-and-export).

## Privacy practices form

### Single purpose

Browser Recall Connector records visits and lets users save highlights, annotations,
and snapshots to Browser Recall Desktop. The desktop app is required. The library
stays on the user's computer; the connector sends no analytics or browsing data to
a developer-operated service.

### Permission justifications

Each justification fits the dashboard's 1,000-character limit.

| Field                                 | Text                                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                             | Stores installation identity, pairing token, connection/recording state, and temporary pending commands. This supports reconnection and delivery after brief outages. The library remains in the chosen desktop folder.                                           |
| `tabs`                                | Reads tab URLs/titles to associate actions and popup data with the correct record. Identifies saved snapshots and unsupported pages, including files before file access is enabled, to show appropriate status/instructions.                                      |
| `scripting`                           | Runs packaged highlight/snapshot scripts, reads original snapshot identity, and displays action feedback. Scripts and injected functions are included in the package.                                                                                             |
| `declarativeNetRequestWithHostAccess` | Creates temporary exact-resource rules for the connector's snapshot downloads, setting/removing Referer according to page policy. Rules target the resource URL and extension origin and are removed afterward. This preserves images, styles, and fonts.         |
| `webRequest`                          | Reads redirect and Referrer-Policy headers on the connector's snapshot downloads and checks each redirect before the next request. Does not monitor unrelated traffic.                                                                                            |
| `webNavigation`                       | Detects page, new-tab, and same-document navigation so recorded identities, referrers, popup information, and badges follow the current page.                                                                                                                     |
| `contextMenus`                        | Adds Highlight Selected to save selected text to Browser Recall Desktop.                                                                                                                                                                                          |
| `alarms`                              | Wakes the service worker to reconnect to the paired desktop and deliver briefly queued commands.                                                                                                                                                                  |
| Host permission                       | `<all_urls>` supports visit recording, highlight restoration, user-requested highlights/snapshots, and cross-domain snapshot resources. Local snapshots require Chrome's Allow access to file URLs setting. Data goes to the paired desktop on the same computer. |

`activeTab` is not requested; existing host access supports current-page actions.

### Remote code

Select **No, I am not using Remote code**. If an explanation is requested:

All executable JavaScript is packaged with Browser Recall Connector. The connector
does not download or evaluate remote JavaScript or Wasm. Snapshot resources are
saved as data; website scripts are not executed by the connector. The local desktop
connection exchanges commands and data, not code.

### Data usage

Disclose directly handled categories:

- **Web history:** URLs, titles, referrers, visit times.
- **User activity:** time on page, scroll depth.
- **Website content:** selections, annotations, HTML, resources.
- **Authentication information:** desktop pairing token.

Snapshot capture also preserves arbitrary content and non-password form values.
Disclose **Personally identifiable information**, **Health information**,
**Financial and payment information**, **Personal communications**, and **Location**
for unrestricted user-saved content. Password/file input values are cleared;
capture does not redact all sensitive information.

Local processing still requires disclosure; see the [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).
The implementation supports the three limited-use certifications: no sale/transfer
outside approved uses, no unrelated use, and no creditworthiness/lending use.
Optional user-configured GitHub sync supports the library and is disclosed in the
privacy policy. The publisher remains responsible for these certifications.
