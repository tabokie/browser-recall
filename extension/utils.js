// Shared utility functions

// Generate slug from URL for content file naming
export function generateSlugFromUrl(url) {
  try {
    const parsed = new URL(url);
    const base = (parsed.hostname + parsed.pathname)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    // Short hash of full URL for uniqueness (query params, fragments, etc.)
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
    }
    const hashStr = Math.abs(hash).toString(36);
    const slug = `${base}-${hashStr}`;
    return slug.substring(0, 80);
  } catch {
    return 'untitled';
  }
}
