<img src='icons/browser-recall-default.svg' width=110 height=110 align='right'/>

# Browser Recall

Help browser remember things.

- Keep browser **history** with no time limit. Capture compact webpage **snapshots**.
- Organize webpages with **lists**. A page can belong to more than one list, as it should.
- Add highlights and **notes** directly on the webpage and find them again in context.
- **Search** across titles, URLs, highlights, notes, and snapshots from one place.

Browser Recall stores your data using readable formats such as JSON and Markdown. You can read the files, search them with file tools, or ask an agent to analyze them. An [AGENTS.md](crates/daemon/resources/data-AGENTS.md) in the data directory explains the layout and conventions. Nothing in the collection depends on Browser Recall to remain readable. You own your data.

<img src='icons/browser-recall-icons-40px-gap-12px.svg' align='right'/>

## Gallery

<table>
  <tr>
    <td>
      <p align="center">
        <img src="docs/images/timeline-styles.png" alt="Browser Recall Timeline showing browsing history in Amber and Mono color schemes">
        <br>
        Timeline
      </p>
    </td>
    <td>
      <p align="center">
        <img src="docs/images/book.png" alt="Browser Recall Book showing collected highlights and notes grouped by day">
        <br>
        Book
      </p>
    </td>
  </tr>
  <tr>
    <td>
      <p align="center">
        <img src="docs/images/browser-popup-window.png" alt="Browser extension popup showing page details, lists, and saved snapshots">
        <br>
        See page details in browser
      </p>
    </td>
    <td>
      <p align="center">
        <img src="docs/images/browser-note-window.png" alt="Browser extension note editor beneath a highlighted passage on a webpage">
        <br>
        Take notes in browser
      </p>
    </td>
  </tr>
</table>

<details>
<summary>A few useful details</summary>

<table>
  <tr>
    <td width="33%">
      <img src="docs/images/details/bookmark-import.gif" alt="Choosing bookmark folders and importing the folders as nested lists">
      <strong>Bring your bookmarks.</strong> Choose which folders to import as lists.
    </td>
    <td width="33%">
      <img src="docs/images/details/page-copy-paste.gif" alt="Selecting pages, pasting readable titles and URLs into TextEdit, and pasting the text back into a Browser Recall list">
      <strong>Share a reading list.</strong> Copy readable titles and URLs into your notes. Paste a text list back into Browser Recall.
    </td>
    <td width="33%">
      <img src="docs/images/details/recording-pause.gif" alt="Pausing recording in the browser extension makes the toolbar icon close its eyes">
      <strong>Give recording a rest.</strong> Pause from the browser extension. The toolbar icon closes its eyes.
    </td>
  </tr>
</table>

</details>

## Install

<!-- Replace APP_ID before publishing. -->

Install both the desktop app and the browser extension.

Desktop app is supported on macOS and on Windows. The signed macOS app is available on the [App Store](https://apps.apple.com/app/idAPP_ID). You can also [download from GitHub releases](https://github.com/tabokie/browser-recall/releases) or [build from source](DEVELOPMENT.md#build-and-run).

Browser extension is available on the [Chrome Web Store](https://chromewebstore.google.com/detail/bgghgkobpfgcinpjjeeconciefclpdgp) and [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/browser-recall-connector/). Edge and Orion are supported using the Chromium extension.

## Alternatives

[Zotero](https://www.zotero.org/) is an excellent tool for organizing research materials, including webpages. Browser Recall is a smaller, more open and more web-centric version of it. Feature-wise, Zotero doesn’t support history tracking or taking notes in browser.

[Hister](https://hister.org/) is another tool in this space with similar browser integration. Compared with Browser Recall, it puts more emphasis on search and retrieval.

File an issue if you think someone else deserves a mention.

---

[Development](DEVELOPMENT.md) · [Privacy](docs/PRIVACY.md) · MIT licensed
