// Shared DOM-to-Markdown extraction. Keep the implementation self-contained:
// the extension stages the same function as a classic content-script bridge.

export function extractMarkdown(root, { baseUrl } = {}) {
  if (!root || typeof root !== 'object' || !root.childNodes) {
    throw new TypeError('extractMarkdown requires a DOM root node');
  }

  const resolvedBaseUrl =
    baseUrl ?? root.ownerDocument?.baseURI ?? root.baseURI ?? null;
  const skippedTags = new Set([
    'BUTTON',
    'CANVAS',
    'EMBED',
    'FORM',
    'IFRAME',
    'INPUT',
    'NAV',
    'NOSCRIPT',
    'OBJECT',
    'OPTION',
    'SCRIPT',
    'SELECT',
    'STYLE',
    'SVG',
    'TEMPLATE',
    'TEXTAREA',
  ]);
  const blockTags = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DETAILS',
    'DIALOG',
    'DIV',
    'DL',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HGROUP',
    'HR',
    'MAIN',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'UL',
  ]);
  const lineBreakMarker = '\u0000';

  // Search sidecars follow rendered visibility, not only DOM attributes.
  function isHidden(element) {
    if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') {
      return true;
    }
    const view = element.ownerDocument?.defaultView;
    if (typeof view?.getComputedStyle !== 'function') {
      throw new TypeError(
        'extractMarkdown requires DOM nodes with computed-style access',
      );
    }
    const style = view.getComputedStyle(element);
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden'
    );
  }

  function escapeText(value) {
    return String(value).replace(/([\\`*_[\]<>])/g, '\\$1');
  }

  function normalizeInline(value) {
    return String(value)
      .split(lineBreakMarker)
      .map((line) => line.replace(/[\t\n\f\r ]+/g, ' ').trim())
      .join('\n');
  }

  function absoluteUrl(value) {
    if (!value) return '';
    try {
      return resolvedBaseUrl ? new URL(value, resolvedBaseUrl).href : value;
    } catch {
      return value;
    }
  }

  function markdownDestination(value) {
    const resolved = absoluteUrl(value);
    // Embedded resource bytes have no searchable value and can be enormous.
    if (/^(?:blob|data):/i.test(resolved)) return '';
    return resolved.replace(/([()\\])/g, '\\$1');
  }

  function inlineCode(value) {
    const content = String(value)
      .replace(/[\t\n\f\r ]+/g, ' ')
      .trim();
    const longestRun = Math.max(
      0,
      ...[...content.matchAll(/`+/g)].map((match) => match[0].length),
    );
    const fence = '`'.repeat(Math.max(1, longestRun + 1));
    const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
    return `${fence}${padding}${content}${padding}${fence}`;
  }

  function renderInlineNode(node) {
    if (node.nodeType === 3) {
      return escapeText(node.nodeValue ?? '');
    }
    if (
      node.nodeType !== 1 ||
      isHidden(node) ||
      skippedTags.has(node.tagName)
    ) {
      return '';
    }

    const children = () =>
      Array.from(node.childNodes, renderInlineNode).join('');
    switch (node.tagName) {
      case 'BR':
        return lineBreakMarker;
      case 'A': {
        const label = normalizeInline(children());
        const href = markdownDestination(node.getAttribute('href'));
        if (!href) return label;
        const title = node.getAttribute('title');
        const titlePart = title
          ? ` "${String(title).replace(/(["\\])/g, '\\$1')}"`
          : '';
        return `[${label || href}](${href}${titlePart})`;
      }
      case 'IMG': {
        const src = markdownDestination(
          node.currentSrc || node.getAttribute('src'),
        );
        if (!src) return escapeText(node.getAttribute('alt') || '');
        const alt = escapeText(node.getAttribute('alt') || '');
        const title = node.getAttribute('title');
        const titlePart = title
          ? ` "${String(title).replace(/(["\\])/g, '\\$1')}"`
          : '';
        return `![${alt}](${src}${titlePart})`;
      }
      case 'STRONG':
      case 'B':
        return `**${normalizeInline(children())}**`;
      case 'EM':
      case 'I':
        return `*${normalizeInline(children())}*`;
      case 'DEL':
      case 'S':
      case 'STRIKE':
        return `~~${normalizeInline(children())}~~`;
      case 'CODE':
        return inlineCode(node.textContent ?? '');
      default:
        return children();
    }
  }

  function normalizeMarkdown(value) {
    const output = [];
    let activeFence = null;
    let previousBlank = true;
    for (const rawLine of String(value).replace(/\r\n?/g, '\n').split('\n')) {
      if (activeFence) {
        output.push(rawLine);
        const closing = rawLine.match(/^\s*(`+|~+)\s*$/);
        if (
          closing &&
          closing[1][0] === activeFence.character &&
          closing[1].length >= activeFence.length
        ) {
          activeFence = null;
          previousBlank = false;
        }
        continue;
      }

      const line = rawLine.replace(/[\t ]+$/g, '');
      const opening = line.match(/^\s*(`{3,}|~{3,})[^`~]*$/);
      if (opening) {
        activeFence = {
          character: opening[1][0],
          length: opening[1].length,
        };
        output.push(line);
        previousBlank = false;
        continue;
      }
      if (line.trim() === '') {
        if (!previousBlank) output.push('');
        previousBlank = true;
        continue;
      }
      output.push(line);
      previousBlank = false;
    }
    while (output.at(-1) === '') output.pop();
    while (output[0] === '') output.shift();
    return output.join('\n');
  }

  function renderInlineChildren(node) {
    return normalizeInline(
      Array.from(node.childNodes, renderInlineNode).join(''),
    );
  }

  function renderNodes(nodes) {
    const blocks = [];
    let inline = '';
    const flushInline = () => {
      const value = normalizeInline(inline);
      if (value) blocks.push(value);
      inline = '';
    };

    for (const node of nodes) {
      if (
        node.nodeType === 1 &&
        !isHidden(node) &&
        !skippedTags.has(node.tagName) &&
        blockTags.has(node.tagName)
      ) {
        flushInline();
        const value = renderBlock(node);
        if (value) blocks.push(value);
      } else {
        inline += renderInlineNode(node);
      }
    }
    flushInline();
    return normalizeMarkdown(blocks.join('\n\n'));
  }

  function renderListItemContent(item) {
    return renderNodes(
      Array.from(item.childNodes).filter(
        (child) =>
          child.nodeType !== 1 ||
          (child.tagName !== 'UL' && child.tagName !== 'OL'),
      ),
    );
  }

  function renderList(list, baseIndent = 0) {
    const ordered = list.tagName === 'OL';
    const parsedStart = Number.parseInt(list.getAttribute('start') || '1', 10);
    let ordinal = Number.isFinite(parsedStart) ? parsedStart : 1;
    const lines = [];
    const items = Array.from(list.children).filter(
      (child) => child.tagName === 'LI' && !isHidden(child),
    );

    for (const item of items) {
      const explicitValue = Number.parseInt(
        item.getAttribute('value') || '',
        10,
      );
      if (ordered && Number.isFinite(explicitValue)) ordinal = explicitValue;
      const marker = ordered ? `${ordinal}. ` : '- ';
      const indent = ' '.repeat(baseIndent);
      const continuation = `${indent}${' '.repeat(marker.length)}`;
      const content = renderListItemContent(item);
      const contentLines = content ? content.split('\n') : [''];
      lines.push(`${indent}${marker}${contentLines[0]}`.trimEnd());
      for (const line of contentLines.slice(1)) {
        lines.push(line ? `${continuation}${line}` : '');
      }
      for (const nested of Array.from(item.children).filter(
        (child) => child.tagName === 'UL' || child.tagName === 'OL',
      )) {
        const nestedMarkdown = renderList(nested, baseIndent + marker.length);
        if (nestedMarkdown) lines.push(nestedMarkdown);
      }
      ordinal += 1;
    }
    return lines.join('\n');
  }

  function renderPre(node) {
    const code =
      Array.from(node.children).find((child) => child.tagName === 'CODE') ??
      node;
    const content = String(code.textContent ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/^\n|\n$/g, '');
    const language =
      Array.from(code.classList ?? [])
        .map((name) => name.match(/^(?:language|lang)-([\w+-]+)$/)?.[1])
        .find(Boolean) ?? '';
    const longestRun = Math.max(
      0,
      ...[...content.matchAll(/`+/g)].map((match) => match[0].length),
    );
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `${fence}${language}\n${content}\n${fence}`;
  }

  function renderTable(table) {
    const rows = Array.from(table.querySelectorAll('tr')).filter(
      (row) => row.closest('table') === table && !isHidden(row),
    );
    if (rows.length === 0) return '';
    const parsedRows = rows.map((row) =>
      Array.from(row.children)
        .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
        .flatMap((cell) => {
          const content = renderInlineChildren(cell)
            .replace(/\n/g, '<br>')
            .replace(/\|/g, '\\|');
          const span = Math.max(
            1,
            Number.parseInt(cell.getAttribute('colspan') || '1', 10) || 1,
          );
          return [content, ...Array(span - 1).fill('')];
        }),
    );
    const width = Math.max(...parsedRows.map((row) => row.length));
    const formatRow = (row) =>
      `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`;
    return [
      formatRow(parsedRows[0]),
      formatRow(Array(width).fill('---')),
      ...parsedRows.slice(1).map(formatRow),
    ].join('\n');
  }

  function renderBlock(node) {
    if (isHidden(node) || skippedTags.has(node.tagName)) return '';
    if (/^H[1-6]$/.test(node.tagName)) {
      return `${'#'.repeat(Number(node.tagName[1]))} ${renderInlineChildren(node)}`;
    }
    switch (node.tagName) {
      case 'P':
        return renderInlineChildren(node);
      case 'HR':
        return '---';
      case 'PRE':
        return renderPre(node);
      case 'BLOCKQUOTE': {
        const content = renderNodes(node.childNodes);
        return content
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>'))
          .join('\n');
      }
      case 'UL':
      case 'OL':
        return renderList(node);
      case 'TABLE':
        return renderTable(node);
      case 'DL': {
        const parts = [];
        for (const child of node.children) {
          if (child.tagName === 'DT') {
            parts.push(`**${renderInlineChildren(child)}**`);
          } else if (child.tagName === 'DD') {
            parts.push(`: ${renderNodes(child.childNodes)}`);
          }
        }
        return parts.join('\n');
      }
      default:
        return renderNodes(node.childNodes);
    }
  }

  return renderNodes(root.childNodes);
}

export function createMarkdownExtractorGlobalScript() {
  return `// Generated from packages/core/markdown-extractor.js by scripts/stage-app-assets.mjs.
(function installBrowserRecallMarkdownExtractor() {
  const extractMarkdown = ${extractMarkdown.toString()};
  globalThis.browserRecallMarkdownExtractor = Object.freeze({ extractMarkdown });
})();
`;
}
