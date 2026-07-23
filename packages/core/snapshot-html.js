function escapeHtmlAttribute(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

function deactivateUnembeddedStylesheets(html) {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = tag.match(/(?:^|\s)rel\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (
      !rel?.split(/\s+/).some((value) => value.toLowerCase() === 'stylesheet')
    ) {
      return tag;
    }
    const href = tag.match(/(?:^|\s)href\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href || /^data:/i.test(href)) return tag;
    return tag.replace(
      /(^|\s)href(\s*=\s*["'][\s\S]*?["'])/i,
      '$1data-browser-recall-unavailable-href$2',
    );
  });
}

function removeBrowserRecallHighlightMarkup(html) {
  return html
    .replace(
      /<mark\b(?=[^>]*\bclass=(["'])[^"']*\bbrowser-recall-highlight\b[^"']*\1)[^>]*>([\s\S]*?)<\/mark>/gi,
      '$2',
    )
    .replace(
      /\sclass=(["'])([^"']*\bbrowser-recall-highlight\b[^"']*)\1/gi,
      (_, quote, classes) => {
        const remaining = classes
          .split(/\s+/)
          .filter(
            (className) =>
              className && className !== 'browser-recall-highlight',
          )
          .join(' ');
        return remaining ? ` class=${quote}${remaining}${quote}` : '';
      },
    )
    .replace(/\sdata-highlight-(?:text|timestamp)=(["']).*?\1/gi, '')
    .replace(/\sdata-note-slug=(["']).*?\1/gi, '');
}

function removeInactiveShadowLoader(html) {
  return html.replace(
    /<script\b(?=[^>]*\bid=(["'])savepage-shadowloader\1)[^>]*>[\s\S]*?<\/script\s*>/gi,
    '',
  );
}

function injectSnapshotIdentity(html, slug, url) {
  if (!slug || /<meta\s+name=(["'])x-browser-recall-slug\1/i.test(html)) {
    return html;
  }
  const metadata = [
    `<meta name="x-browser-recall-slug" content="${escapeHtmlAttribute(slug)}">`,
    url
      ? `<meta name="x-browser-recall-url" content="${escapeHtmlAttribute(url)}">`
      : '',
  ].join('');
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}${metadata}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(
      /<html\b[^>]*>/i,
      (match) => `${match}<head>${metadata}</head>`,
    );
  }
  return `${metadata}${html}`;
}

/**
 * Applies the idempotent transformations required before snapshot HTML is
 * persisted. This pure boundary is shared by live capture and repair tooling.
 */
export function prepareSnapshotHtml(html, { slug, url = null } = {}) {
  if (!html) return html;
  const selfContainedHtml = deactivateUnembeddedStylesheets(html);
  const safeHtml = removeInactiveShadowLoader(selfContainedHtml);
  const cleanHtml = removeBrowserRecallHighlightMarkup(safeHtml);
  return injectSnapshotIdentity(cleanHtml, slug, url);
}
