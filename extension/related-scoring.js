// Related pages scoring — pure functions, no DOM or Chrome API deps

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','up','about','into','over','after','is','are','was','were','be','been',
  'being','have','has','had','do','does','did','will','would','shall','should',
  'may','might','must','can','could','that','which','who','whom','this','these',
  'those','it','its','my','your','his','her','our','their','what','how','when',
  'where','why','not','no','nor','so','if','then','than','too','very','just',
  'also','now','here','there','all','each','every','both','few','more','most',
  'other','some','such','only','same','new','-','|','/'
]);

function titleWords(text) {
  if (!text) return new Set();
  return new Set(text.toLowerCase().split(/[\s\-_|/:.?!,;()\[\]{}]+/).filter(w => w.length > 1 && !STOP_WORDS.has(w)));
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scoreTemporalProximity(seedTimestamps, candTimestamps) {
  const seeds = seedTimestamps.slice(0, 10);
  const cands = candTimestamps.slice(0, 10);
  let minGap = Infinity;
  for (const s of seeds) for (const c of cands) minGap = Math.min(minGap, Math.abs(s - c));
  const ONE_HOUR = 3600000;
  const DAY = 86400000;
  if (minGap <= ONE_HOUR) return 1;
  if (minGap >= DAY) return 0;
  return 1 - (minGap - ONE_HOUR) / (DAY - ONE_HOUR);
}

function prepareSeed(seed) {
  let hostname = '', origin = '';
  try { const u = new URL(seed.url); hostname = u.hostname; origin = u.origin; } catch {}
  return {
    hostname, origin,
    titleTokens: titleWords(seed.title),
    intentTokens: titleWords(seed.intent),
    timestamps: seed.timestamps || [],
  };
}

function scorePair(seedData, cand) {
  let candHostname = '', candOrigin = '';
  try { const u = new URL(cand.url); candHostname = u.hostname; candOrigin = u.origin; } catch {}
  let score = 0;
  if (candHostname && seedData.hostname === candHostname) {
    score += 0.30;
    if (candOrigin === seedData.origin) score += 0.10;
  }
  score += 0.30 * jaccardSimilarity(seedData.titleTokens, titleWords(cand.title));
  const candTs = cand.timestamps || [];
  if (seedData.timestamps.length > 0 && candTs.length > 0)
    score += 0.25 * scoreTemporalProximity(seedData.timestamps, candTs);
  score += 0.15 * jaccardSimilarity(seedData.intentTokens, titleWords(cand.intent));
  return score;
}

export function findRelatedPages(seeds, candidates, poolLimit) {
  if (seeds.length === 0) return [];
  const pool = new Map(); // url → { item, relatedness }

  for (const seed of seeds) {
    if (pool.size >= poolLimit) break;

    const seedData = prepareSeed(seed);
    for (const cand of candidates) {
      if (pool.size >= poolLimit && !pool.has(cand.url)) continue;
      const score = scorePair(seedData, cand);
      if (score > 0) {
        const existing = pool.get(cand.url);
        if (!existing || score > existing.relatedness) {
          pool.set(cand.url, { ...cand, relatedness: score });
        }
      }
    }
  }

  return [...pool.values()]
    .sort((a, b) => b.relatedness - a.relatedness)
    .slice(0, poolLimit);
}
