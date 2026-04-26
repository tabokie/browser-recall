/**
 * Parse Netscape Bookmark Format HTML into a folder tree.
 * @param {string} html - Raw HTML string from an exported bookmarks file.
 * @returns {RootNode}
 *
 * @typedef {Object} RootNode
 * @property {string} title
 * @property {BookmarkEntry[]} bookmarks
 * @property {BookmarkEntry[]} skipped
 * @property {FolderNode[]} children
 *
 * @typedef {Object} FolderNode
 * @property {string} title
 * @property {BookmarkEntry[]} bookmarks
 * @property {BookmarkEntry[]} skipped
 * @property {FolderNode[]} children
 * @property {number} bookmarkCount
 * @property {number} subfolderCount
 *
 * @typedef {Object} BookmarkEntry
 * @property {string} url
 * @property {string} title
 * @property {string} [reason]
 */

const WEB_PROTOCOL_RE = /^https?:\/\//i;

function isWebUrl(url) {
  return WEB_PROTOCOL_RE.test(url);
}

function skippedReason(url) {
  if (!url) return 'empty URL';
  try {
    const proto = new URL(url).protocol;
    return `unsupported protocol: ${proto}`;
  } catch {
    return 'invalid URL';
  }
}

function parseDL(dlElement) {
  const bookmarks = [];
  const skipped = [];
  const children = [];

  for (const dt of dlElement.children) {
    if (dt.tagName !== 'DT') continue;

    const h3 = dt.querySelector(':scope > h3');
    if (h3) {
      const childDL = dt.querySelector(':scope > dl');
      const childResult = childDL
        ? parseDL(childDL)
        : { bookmarks: [], skipped: [], children: [] };

      const ownCount = childResult.bookmarks.length;
      const descendantCount = childResult.children.reduce(
        (sum, child) => sum + child.bookmarkCount,
        0,
      );

      children.push({
        title: h3.textContent,
        bookmarks: childResult.bookmarks,
        skipped: childResult.skipped,
        children: childResult.children,
        bookmarkCount: ownCount + descendantCount,
        subfolderCount: childResult.children.length,
      });
      continue;
    }

    const anchor = dt.querySelector(':scope > a');
    if (!anchor) continue;

    const url = anchor.getAttribute('href');
    const title = anchor.textContent;
    if (url && isWebUrl(url)) {
      bookmarks.push({ url, title });
    } else {
      skipped.push({ url: url || '', title, reason: skippedReason(url) });
    }
  }

  return { bookmarks, skipped, children };
}

export function parseBookmarkHtml(html) {
  const cleaned = html.replace(/<\/?p>/gi, '');
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleaned, 'text/html');

  const h1 = doc.querySelector('h1');
  const titleEl = doc.querySelector('title');
  const title = h1?.textContent || titleEl?.textContent || 'Bookmarks';

  const rootDL = doc.querySelector('dl');
  if (!rootDL) {
    return { title, bookmarks: [], skipped: [], children: [] };
  }

  const result = parseDL(rootDL);
  return {
    title,
    bookmarks: result.bookmarks,
    skipped: result.skipped,
    children: result.children,
  };
}
