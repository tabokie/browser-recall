export function highlightExcerptParts(excerpt) {
  return Array.isArray(excerpt)
    ? excerpt.map((part) => String(part || '')).filter(Boolean)
    : [];
}

export function formatHighlightExcerpt(excerpt) {
  return highlightExcerptParts(excerpt).join('\n');
}
