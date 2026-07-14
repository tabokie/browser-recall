export function highlightExcerptParts(excerpt) {
  if (excerpt === null) return [];
  if (
    !Array.isArray(excerpt) ||
    !excerpt.every((part) => typeof part === 'string' && part)
  ) {
    throw new Error(
      'Highlight excerpt must be a non-empty string array or null',
    );
  }
  return excerpt;
}

export function formatHighlightExcerpt(excerpt) {
  return highlightExcerptParts(excerpt).join('\n');
}
