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

const htmlRawTextElements = new Set([
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

function findHtmlTagEnd(html, start) {
  let quote = null;
  for (let index = start + 1; index < html.length; index++) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function activateShadowRootStartTag(tag) {
  const name = tag.match(/^<\s*([a-z][^\s/>]*)/i)?.[1]?.toLowerCase();
  if (
    name !== 'template' ||
    !/\sdata-savepage-shadowroot(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i.test(
      tag,
    ) ||
    /\sshadowrootmode(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i.test(tag)
  ) {
    return { name, tag };
  }
  const insertionIndex = /\/\s*>$/.test(tag) ? tag.lastIndexOf('/') : -1;
  if (insertionIndex >= 0) {
    const prefix = tag.slice(0, insertionIndex);
    return {
      name,
      tag: `${prefix}${/\s$/.test(prefix) ? '' : ' '}shadowrootmode="open" ${tag.slice(insertionIndex)}`,
    };
  }
  return {
    name,
    tag: `${tag.slice(0, -1)} shadowrootmode="open">`,
  };
}

function activateDeclarativeShadowRoots(html) {
  // Scan HTML structure instead of rewriting the whole archive with a regex:
  // srcdoc attributes and raw-text elements may contain markup-looking text.
  let cursor = 0;
  let output = '';
  let rawTextElement = null;

  while (cursor < html.length) {
    if (rawTextElement) {
      if (rawTextElement === 'plaintext') {
        output += html.slice(cursor);
        break;
      }
      const closingTag = new RegExp(`</\\s*${rawTextElement}\\b`, 'gi');
      closingTag.lastIndex = cursor;
      const match = closingTag.exec(html);
      if (!match) {
        output += html.slice(cursor);
        break;
      }
      output += html.slice(cursor, match.index);
      cursor = match.index;
      rawTextElement = null;
      continue;
    }

    const tagStart = html.indexOf('<', cursor);
    if (tagStart < 0) {
      output += html.slice(cursor);
      break;
    }
    output += html.slice(cursor, tagStart);

    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      if (commentEnd < 0) {
        output += html.slice(tagStart);
        break;
      }
      output += html.slice(tagStart, commentEnd + 3);
      cursor = commentEnd + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', tagStart)) {
      const cdataEnd = html.indexOf(']]>', tagStart + 9);
      if (cdataEnd < 0) {
        output += html.slice(tagStart);
        break;
      }
      output += html.slice(tagStart, cdataEnd + 3);
      cursor = cdataEnd + 3;
      continue;
    }

    const tagEnd = findHtmlTagEnd(html, tagStart);
    if (tagEnd < 0) {
      output += html.slice(tagStart);
      break;
    }
    const originalTag = html.slice(tagStart, tagEnd + 1);
    const activated = activateShadowRootStartTag(originalTag);
    output += activated.tag;
    cursor = tagEnd + 1;
    if (
      activated.name &&
      htmlRawTextElements.has(activated.name) &&
      !/\/\s*>$/.test(originalTag)
    ) {
      rawTextElement = activated.name;
    }
  }

  return output;
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
  const shadowReadyHtml = activateDeclarativeShadowRoots(safeHtml);
  const cleanHtml = removeBrowserRecallHighlightMarkup(shadowReadyHtml);
  return injectSnapshotIdentity(cleanHtml, slug, url);
}
