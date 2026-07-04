// Attention scoring — pure functions, no DOM or Chrome API deps

export function attentionStrength(attention) {
  // Composite score: weighted sum of normalized metrics
  let score = 0;
  if (attention.timeOnPage) {
    score += Math.min(attention.timeOnPage / 60000, 10);
  }
  if (attention.scrollDepth) score += (attention.scrollDepth / 100) * 2;
  if (attention.likes) {
    score += Math.min(Math.max(attention.likes, 0), 5);
  }
  return score;
}

// Compute aggregate attention for a group of history entries (flat fields)
export function aggregateAttention(entries) {
  let total = 0;
  let latestAttention = null;
  for (const entry of entries) {
    if (
      entry.scrollDepth !== undefined ||
      entry.timeOnPage !== undefined ||
      entry.likes !== undefined
    ) {
      total += attentionStrength(entry);
      latestAttention = entry;
    }
  }
  return { score: total, detail: latestAttention };
}
