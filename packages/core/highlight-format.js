export function highlightExcerptParts(excerpt) {
  if (
    !Array.isArray(excerpt) ||
    excerpt.length === 0 ||
    !excerpt.every((part) => typeof part === 'string' && part)
  ) {
    throw new Error('Highlight excerpt must be a non-empty string array');
  }
  return excerpt;
}

export function formatHighlightExcerpt(excerpt) {
  return highlightExcerptParts(excerpt).join('\n');
}
