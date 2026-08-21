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

function htmlTagName(tag) {
  return tag.match(/^<\s*\/?\s*([a-z][^\s/>]*)/i)?.[1]?.toLowerCase() || null;
}

function htmlAttributeValue(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(
    new RegExp(
      `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
      'i',
    ),
  );
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function transformHtmlStructure(html, transformTag) {
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
    const tag = html.slice(tagStart, tagEnd + 1);
    const name = htmlTagName(tag);
    output += transformTag(tag, name);
    cursor = tagEnd + 1;
    if (
      name &&
      !/^<\s*\//.test(tag) &&
      htmlRawTextElements.has(name) &&
      !/\/\s*>$/.test(tag)
    ) {
      rawTextElement = name;
    }
  }
  return output;
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
  return transformHtmlStructure(
    html,
    (tag) => activateShadowRootStartTag(tag).tag,
  );
}

function snapshotIdentityMetadataName(tag, name) {
  if (name !== 'meta' || /^<\s*\//.test(tag)) return null;
  const metadataName = htmlAttributeValue(tag, 'name')?.toLowerCase();
  return metadataName === 'x-browser-recall-slug' ||
    metadataName === 'x-browser-recall-url'
    ? metadataName
    : null;
}

export function setSnapshotIdentity(html, { slug = null, url = null } = {}) {
  if (!html) return html;
  const replacedNames = new Set();
  const metadata = [];
  if (slug) {
    replacedNames.add('x-browser-recall-slug');
    metadata.push(
      `<meta name="x-browser-recall-slug" content="${escapeHtmlAttribute(slug)}">`,
    );
  }
  if (url) {
    replacedNames.add('x-browser-recall-url');
    metadata.push(
      `<meta name="x-browser-recall-url" content="${escapeHtmlAttribute(url)}">`,
    );
  }
  if (metadata.length === 0) return html;
  const metadataHtml = metadata.join('');
  const withoutIdentity = transformHtmlStructure(html, (tag, name) =>
    replacedNames.has(snapshotIdentityMetadataName(tag, name)) ? '' : tag,
  );
  let inserted = false;
  const withHeadIdentity = transformHtmlStructure(
    withoutIdentity,
    (tag, name) => {
      if (!inserted && name === 'head' && !/^<\s*\//.test(tag)) {
        inserted = true;
        return `${tag}${metadataHtml}`;
      }
      return tag;
    },
  );
  if (inserted) return withHeadIdentity;
  const withSyntheticHead = transformHtmlStructure(
    withoutIdentity,
    (tag, name) => {
      if (!inserted && name === 'html' && !/^<\s*\//.test(tag)) {
        inserted = true;
        return `${tag}<head>${metadataHtml}</head>`;
      }
      return tag;
    },
  );
  return inserted ? withSyntheticHead : `${metadataHtml}${withoutIdentity}`;
}

export function validateSnapshotIdentity(html, { slug, url = null } = {}) {
  if (typeof html !== 'string' || !html) {
    throw new Error('snapshot identity requires non-empty HTML');
  }
  const values = {
    'x-browser-recall-slug': [],
    'x-browser-recall-url': [],
  };
  transformHtmlStructure(html, (tag, name) => {
    const metadataName = snapshotIdentityMetadataName(tag, name);
    if (!metadataName) return tag;
    const content = htmlAttributeValue(tag, 'content');
    if (content === undefined) {
      throw new Error(`snapshot identity ${metadataName} is missing content`);
    }
    values[metadataName].push(decodeHtmlAttribute(content));
    return tag;
  });
  for (const name of Object.keys(values)) {
    if (values[name].length !== 1) {
      throw new Error(`snapshot identity requires exactly one ${name}`);
    }
  }
  const identity = {
    slug: values['x-browser-recall-slug'][0],
    url: values['x-browser-recall-url'][0],
  };
  if (typeof slug === 'string' && identity.slug !== slug) {
    throw new Error('snapshot identity slug does not match the requested slug');
  }
  if (typeof url === 'string' && identity.url !== url) {
    throw new Error(
      'snapshot identity URL does not match the authoritative URL',
    );
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(identity.url);
  } catch {
    throw new Error('snapshot identity URL is invalid');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('snapshot identity URL must use HTTP or HTTPS');
  }
  return identity;
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
  return setSnapshotIdentity(cleanHtml, { slug, url });
}
