// Attention scoring — pure functions, no DOM or Chrome API deps

export function attentionStrength(att) {
  // Composite score: weighted sum of normalized metrics
  let score = 0;
  if (att.timeOnPage) score += Math.min(att.timeOnPage / 60000, 10); // minutes, cap at 10
  if (att.scrollDepth) score += (att.scrollDepth / 100) * 2; // 0-2
  if (att.likes) score += Math.min(Math.max(att.likes, 0), 5); // 1 per like, cap at 5, floor at 0
  return score;
}

// Compute aggregate attention for a group of history entries (flat fields)
export function aggregateAttention(entries) {
  let total = 0;
  let att = null;
  for (const i of entries) {
    if (
      i.scrollDepth !== undefined ||
      i.timeOnPage !== undefined ||
      i.likes !== undefined
    ) {
      total += attentionStrength(i);
      att = i; // keep last one for details
    }
  }
  return { score: total, detail: att };
}
