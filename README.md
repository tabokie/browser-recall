<img src='icons/browser-recall-default.svg' width=100 height=100 align='right'/>

# Browser Recall

Help browser remember things.

- Keep browsing **history** without a time limit. Capture compact webpage **snapshots**.
- Organize webpages with **lists**. A page can belong to more than one list, as it should.
- Add highlights and **notes** directly on the webpage and find them again in context.
- **Search** across titles, URLs, highlights, notes, and snapshots from one place.

All data collected by the app are stored using plain, readable formats such as JSON and Markdown, in a directory of your choosing. You can inspect the files directly, search them with file tools, or ask an agent to analyze them. An AGENTS.md file in the data directory explains the layout and conventions. Nothing in the collection depends on Browser Recall to remain readable. You own your data.

## Gallery

<table>
  <tr>
    <td>
      <p align="center">
        <img src="docs/images/timeline-styles.png" alt="Browser Recall Timeline showing browsing history in Amber and Mono color schemes">
        <br>
        <strong>Timeline</strong> — browsing history and search
      </p>
    </td>
    <td>
      <p align="center">
        <img src="docs/images/book.png" alt="Browser Recall Book showing collected highlights and notes grouped by day">
        <br>
        <strong>Book</strong> — highlights and notes, gathered by day
      </p>
    </td>
  </tr>
  <tr>
    <td>
      <p align="center">
        <img src="docs/images/browser-popup-window.png" alt="Browser extension popup showing page details, lists, and saved snapshots">
        <br>
        Browser extension popup window
      </p>
    </td>
    <td>
      <p align="center">
        <img src="docs/images/browser-note-window.png" alt="Browser extension note editor beneath a highlighted passage on a webpage">
        <br>
        Highlight text and add a note on the page
      </p>
    </td>
  </tr>
</table>


## Install

<!-- Store URLs are placeholders. Replace APP_ID, CHROME_EXTENSION_ID, and FIREFOX_ADDON_ID before publishing. -->

Install both the desktop app and the browser extension.

Desktop app is supported on MacOS and on Windows. The signed macOS app is available as a paid download from the [App Store](https://apps.apple.com/app/idAPP_ID). You can also [build from source](DEVELOPMENT.md#build-and-run).

Browser extension is free on the [Chrome Web Store](https://chromewebstore.google.com/detail/browser-recall/CHROME_EXTENSION_ID) and [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/FIREFOX_ADDON_ID/). Edge and Orion are supported using the Chromium extension.

## Caveats

Browser Recall is 100% implemented by AI agents under my supervision. From the outside, the software quality appears good enough based on my own use. But I would not recommend reading the implementation without AI assistance. For your context, almost every prompt used to build the project is tracked in [./prompts](./prompts).

Browser Recall is one particular take on keeping a durable and searchable record of the web you have seen. There're other options out there that might suit you better. [Hister](https://hister.org/), for example, focuses more on building a powerful search engine.

---

[Development](DEVELOPMENT.md) · [Privacy](docs/PRIVACY.md) · MIT licensed

