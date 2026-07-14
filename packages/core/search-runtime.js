/* @ts-self-types="./search-runtime.d.ts" */

export const RankingAlgorithm = Object.freeze({
  Content: 0,
  0: 'Content',
});

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  throw new Error(
    `Search text must be a string or null, received ${typeof value}`,
  );
}

function toTimestampNumber(value) {
  const timestamp = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('Search timestamps must be non-negative safe integers');
  }
  return timestamp;
}

function isAsciiAlphanumeric(char) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

export function parseSearchQueryWords(query) {
  if (typeof query !== 'string') {
    throw new Error('Search query must be a string');
  }
  const words = [];
  const input = query;
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char === '"') {
      index += 1;
      let phrase = '';
      while (index < input.length && input[index] !== '"') {
        phrase += input[index];
        index += 1;
      }
      if (index < input.length && input[index] === '"') index += 1;
      if (phrase) words.push({ text: phrase.toLowerCase(), exact: true });
      continue;
    }

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    let token = '';
    while (
      index < input.length &&
      !/\s/.test(input[index]) &&
      input[index] !== '"'
    ) {
      token += input[index];
      index += 1;
    }
    if (token) words.push({ text: token.toLowerCase(), exact: false });
  }

  return words;
}

function damerauLevenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev2 = Array.from({ length: b.length + 1 }, () => 0);
  let prev = Array.from({ length: b.length + 1 }, (_, idx) => idx);
  let curr = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j - 1] + cost, curr[j - 1] + 1, prev[j] + 1);

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], prev2[j - 2] + cost);
      }
    }
    const nextPrev2 = prev;
    const nextPrev = curr;
    curr = prev2;
    prev2 = nextPrev2;
    prev = nextPrev;
  }

  return prev[b.length];
}

function tokenize(text) {
  return normalizeText(text).match(/[A-Za-z0-9]+/g) || [];
}

function maxFuzzyDistance(length) {
  if (length <= 2) return null;
  if (length <= 4) return 1;
  return 2;
}

function wordMatchQuality(word, text) {
  const lower = normalizeText(text).toLowerCase();
  if (!lower) return null;

  if (word.exact) {
    let start = 0;
    while (start < lower.length) {
      const pos = lower.indexOf(word.text, start);
      if (pos === -1) return null;
      const end = pos + word.text.length;
      const atWordStart = pos === 0 || !isAsciiAlphanumeric(lower[pos - 1]);
      const atWordEnd =
        end === lower.length || !isAsciiAlphanumeric(lower[end]);
      if (atWordStart && atWordEnd) return { kind: 'exact' };
      start = pos + 1;
    }
    return null;
  }

  if (lower.includes(word.text)) return { kind: 'exact' };

  const maxDist = maxFuzzyDistance(word.text.length);
  if (maxDist == null) return null;

  let bestDist = Number.POSITIVE_INFINITY;
  for (const token of tokenize(lower)) {
    bestDist = Math.min(bestDist, damerauLevenshtein(word.text, token));
    if (token.length > word.text.length) {
      for (const prefixLength of [
        Math.max(word.text.length - 1, 0),
        word.text.length,
        word.text.length + 1,
      ]) {
        if (prefixLength > 0 && prefixLength <= token.length) {
          bestDist = Math.min(
            bestDist,
            damerauLevenshtein(word.text, token.slice(0, prefixLength)),
          );
        }
      }
    }
    if (bestDist === 0) break;
  }

  if (bestDist <= maxDist) return { kind: 'fuzzy', distance: bestDist };
  return null;
}

function matchQualityScore(quality) {
  if (quality.kind === 'exact') return 1;
  return Math.max(1 - quality.distance * 0.3, 0.1);
}

export function scoreSearchFields(words, fields) {
  if (!Array.isArray(words) || words.length === 0) return null;
  if (!Array.isArray(fields)) throw new Error('Search fields must be an array');

  let total = 0;
  for (const word of words) {
    let best = null;
    for (const [index, field] of fields.entries()) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new Error(`Search field ${index} must be an object`);
      }
      const text = normalizeText(field.text);
      const weight = field.weight;
      if (!Number.isFinite(weight)) {
        throw new Error(`Search field ${index} weight must be finite`);
      }
      if (!text || weight <= 0) continue;
      const quality = wordMatchQuality(word, text);
      if (!quality) continue;
      const score = weight * matchQualityScore(quality);
      best = best == null ? score : Math.max(best, score);
    }
    if (best == null) return null;
    total += best;
  }

  return total / words.length;
}

function identityFields(entry) {
  return [
    { text: entry.title, weight: 2 },
    { text: entry.userTitle, weight: 2 },
    { text: entry.url, weight: 0.5 },
  ];
}

function identityScore(entry, words) {
  return scoreSearchFields(words, identityFields(entry));
}

function buildSearchResults(entries, query) {
  const words = parseSearchQueryWords(query);
  if (words.length === 0) return [];

  const results = entries
    .map((entry) => {
      const score = identityScore(entry, words);
      if (score == null) return null;
      return {
        url: normalizeText(entry.url),
        title: normalizeText(entry.title),
        timestamp: toTimestampNumber(entry.timestamp),
        score,
      };
    })
    .filter(Boolean);

  results.sort(
    (left, right) =>
      right.score - left.score || right.timestamp - left.timestamp,
  );
  return results;
}

export class HistoryEntry {
  constructor(url, title) {
    if (typeof url !== 'string' || !url) {
      throw new Error('HistoryEntry URL must be a non-empty string');
    }
    if (typeof title !== 'string') {
      throw new Error('HistoryEntry title must be a string');
    }
    this.timestamp = BigInt(Date.now());
    this.url = url;
    this.title = title;
    this.userTitle = '';
    this.content = '';
  }

  free() {}

  setContent(content) {
    if (typeof content !== 'string') {
      throw new Error('HistoryEntry content must be a string');
    }
    this.content = content;
  }
}

if (typeof Symbol.dispose === 'symbol') {
  HistoryEntry.prototype[Symbol.dispose] = HistoryEntry.prototype.free;
}

export class SearchEngine {
  constructor() {
    this.entries = [];
  }

  free() {}

  addEntry(entry) {
    this.entries.push(entry);
  }

  async search(query, _algorithm = RankingAlgorithm.Content) {
    return buildSearchResults(this.entries, query);
  }
}

if (typeof Symbol.dispose === 'symbol') {
  SearchEngine.prototype[Symbol.dispose] = SearchEngine.prototype.free;
}
