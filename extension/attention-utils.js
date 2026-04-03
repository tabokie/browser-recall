// Attention scoring — pure functions, no DOM or Chrome API deps

export function attentionStrength(att) {
  // Composite score: weighted sum of normalized metrics
  let score = 0;
  if (att.timeOnPage) score += Math.min(att.timeOnPage / 60000, 10); // minutes, cap at 10
  if (att.scrollDepth) score += att.scrollDepth / 100 * 2; // 0-2
  if (att.likes) score += Math.min(Math.max(att.likes, 0), 5); // 1 per like, cap at 5, floor at 0
  return score;
}

// Blue (low) → Red (high) color scale
export function attentionColor(normalizedScore) {
  // 0 = blue (#4285f4), 0.5 = yellow (#fbbc04), 1 = red (#ea4335)
  const t = Math.max(0, Math.min(1, normalizedScore));
  if (t <= 0.5) {
    const s = t * 2; // 0→1
    const r = Math.round(66 + (251 - 66) * s);
    const g = Math.round(133 + (188 - 133) * s);
    const b = Math.round(244 + (4 - 244) * s);
    return `rgb(${r},${g},${b})`;
  } else {
    const s = (t - 0.5) * 2; // 0→1
    const r = Math.round(251 + (234 - 251) * s);
    const g = Math.round(188 + (67 - 188) * s);
    const b = Math.round(4 + (53 - 4) * s);
    return `rgb(${r},${g},${b})`;
  }
}

// Compute aggregate attention for a group of history entries (flat fields)
export function aggregateAttention(entries) {
  let total = 0;
  let att = null;
  for (const i of entries) {
    if (i.scrollDepth !== undefined || i.timeOnPage !== undefined || i.likes !== undefined) {
      total += attentionStrength(i);
      att = i; // keep last one for details
    }
  }
  return { score: total, detail: att };
}
