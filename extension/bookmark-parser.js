/**
 * Parse Netscape Bookmark Format HTML into a folder tree.
 * @param {string} html - Raw HTML string from an exported bookmarks file.
 * @returns {RootNode}
 *
 * @typedef {Object} RootNode
 * @property {string} title - Root title from the file (usually "Bookmarks")
 * @property {BookmarkEntry[]} bookmarks - Root-level bookmarks (not inside any folder)
 * @property {BookmarkEntry[]} skipped - Root-level non-web URLs
 * @property {FolderNode[]} children - Top-level folders
 *
 * @typedef {Object} FolderNode
 * @property {string} title
 * @property {BookmarkEntry[]} bookmarks - Direct http(s) bookmarks in this folder
 * @property {BookmarkEntry[]} skipped - Direct non-web URLs in this folder
 * @property {FolderNode[]} children - Sub-folders
 * @property {number} bookmarkCount - Recursive count of valid bookmarks in subtree
 * @property {number} subfolderCount - Direct child folder count
 *
 * @typedef {Object} BookmarkEntry
 * @property {string} url
 * @property {string} title
 * @property {string} [reason] - Only on skipped entries
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

/**
 * Walk a <DL> element, extracting folders and bookmarks.
 *
 * DOMParser nests the Netscape format as:
 *   <DL>
 *     <DT>           ← folder: contains <H3> + child <DL>
 *       <H3>Name</H3>
 *       <DL>...</DL>
 *     </DT>
 *     <DT>           ← bookmark: contains <A>
 *       <A HREF="...">Title</A>
 *     </DT>
 *   </DL>
 */
function parseDL(dlElement) {
  const bookmarks = [];
  const skipped = [];
  const children = [];

  // Iterate direct <DT> children of this <DL>
  for (const dt of dlElement.children) {
    if (dt.tagName !== 'DT') continue;

    const h3 = dt.querySelector(':scope > h3');
    if (h3) {
      // Folder: the child <DL> inside this <DT> holds the folder contents
      const childDL = dt.querySelector(':scope > dl');
      const childResult = childDL
        ? parseDL(childDL)
        : { bookmarks: [], skipped: [], children: [] };

      const ownCount = childResult.bookmarks.length;
      const descendantCount = childResult.children.reduce((sum, c) => sum + c.bookmarkCount, 0);

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
    if (anchor) {
      const url = anchor.getAttribute('href');
      const title = anchor.textContent;
      if (url && isWebUrl(url)) {
        bookmarks.push({ url, title });
      } else {
        skipped.push({ url: url || '', title, reason: skippedReason(url) });
      }
    }
  }

  return { bookmarks, skipped, children };
}

export function parseBookmarkHtml(html) {
  // Strip <p> tags — they're noise in the Netscape Bookmark Format and
  // confuse DOMParser's tree construction (DT/DL end up as siblings of P
  // rather than children of DL).
  const cleaned = html.replace(/<\/?p>/gi, '');
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleaned, 'text/html');

  // Extract root title (usually from <H1> or <TITLE>)
  const h1 = doc.querySelector('h1');
  const titleEl = doc.querySelector('title');
  const title = h1?.textContent || titleEl?.textContent || 'Bookmarks';

  // Find the root <DL> — the first one in the document
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
