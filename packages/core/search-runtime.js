/* @ts-self-types="./search-runtime.d.ts" */

export const RankingAlgorithm = Object.freeze({
  Content: 0,
  0: 'Content',
});

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function toTimestampNumber(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const words = [];
  const input = normalizeText(query);
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

  let total = 0;
  for (const word of words) {
    let best = null;
    for (const field of fields) {
      const text = normalizeText(field?.text);
      const weight = Number(field?.weight || 0);
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
    { text: entry.userTitle || entry.user_title, weight: 2 },
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
      right.score - left.score ||
      (right.timestamp || 0) - (left.timestamp || 0),
  );
  return results;
}

async function readFileText(fileHandle) {
  const file = await fileHandle.getFile();
  return file.text();
}

async function readNamedFileText(directory, name) {
  try {
    const fileHandle = await directory.getFileHandle(name);
    return await readFileText(fileHandle);
  } catch {
    return null;
  }
}

async function sha256Shard(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const bytes = new TextEncoder().encode(value);
  const digest = await subtle.digest('SHA-256', bytes);
  const first = new Uint8Array(digest)[0];
  return first.toString(16).padStart(2, '0');
}

async function readPageUserTitle(pagesDir, slug) {
  try {
    const shard = await sha256Shard(slug);
    if (!shard) return '';
    const shardDir = await pagesDir.getDirectoryHandle(shard);
    const fileHandle = await shardDir.getFileHandle(`${slug}.json`);
    const text = await readFileText(fileHandle);
    const page = JSON.parse(text);
    return typeof page.user_title === 'string' ? page.user_title.trim() : '';
  } catch {
    return '';
  }
}

function parseHistoryLine(line) {
  try {
    const item = JSON.parse(line);
    if (!item || typeof item.url !== 'string') return null;
    return {
      timestamp: toTimestampNumber(item.timestamp),
      url: item.url,
      title: normalizeText(item.title),
      user_title: normalizeText(item.user_title),
      slug: typeof item.slug === 'string' ? item.slug : null,
    };
  } catch {
    return null;
  }
}

function extractNoteFields(note) {
  const fields = [];

  if (Array.isArray(note.excerpt)) {
    for (const item of note.excerpt) {
      if (typeof item === 'string') fields.push(item);
    }
  }

  if (typeof note.note === 'string') fields.push(note.note);

  return fields;
}

function extractSnapshotPartsFromName(name) {
  const match = /^(.+)-(\d{13})\.(?:md|html)$/.exec(name);
  return match ? { slug: match[1], timestamp: Number(match[2]) } : null;
}

export class HistoryEntry {
  constructor(url, title) {
    this.timestamp = BigInt(Date.now());
    this.url = normalizeText(url);
    this.title = normalizeText(title);
    this.userTitle = '';
    this.content = '';
  }

  free() {}

  setContent(content) {
    this.content = normalizeText(content);
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

export function main() {
  noop();
}

export function initSync() {
  noop();
}

export async function searchBatch(historyDir, pagesDir, query, fileNames) {
  const seenUrls = new Set();
  const entries = [];

  for (const name of fileNames) {
    const text = await readNamedFileText(historyDir, name);
    if (text == null) continue;
    for (const line of text.split('\n')) {
      const item = parseHistoryLine(line.trim());
      if (!item || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      entries.push(item);
    }
  }

  const userTitleBySlug = new Map();
  for (const slug of new Set(
    entries.map((entry) => entry.slug).filter(Boolean),
  )) {
    userTitleBySlug.set(slug, await readPageUserTitle(pagesDir, slug));
  }

  const engine = new SearchEngine();
  for (const entry of entries) {
    const historyEntry = new HistoryEntry(entry.url, entry.title);
    historyEntry.timestamp = BigInt(entry.timestamp);
    historyEntry.userTitle =
      entry.user_title || (entry.slug ? userTitleBySlug.get(entry.slug) : '');
    engine.addEntry(historyEntry);
  }

  return engine.search(query, RankingAlgorithm.Content);
}

export async function searchNotes(notesDir, query) {
  const words = parseSearchQueryWords(query);
  if (words.length === 0) return [];

  const matches = [];
  for await (const entry of notesDir.values()) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue;

    const text = await readNamedFileText(notesDir, entry.name);
    if (text == null) continue;
    let note;
    try {
      note = JSON.parse(text);
    } catch {
      continue;
    }

    const fields = extractNoteFields(note);
    const score = scoreSearchFields(
      words,
      fields.map((field) => ({ text: field, weight: 1 })),
    );
    if (score == null) continue;
    if (typeof note.url !== 'string' || !note.url) continue;

    matches.push({
      url: note.url,
      noteSlug:
        typeof note.slug === 'string' && note.slug
          ? note.slug
          : entry.name.replace(/\.json$/, ''),
      score,
    });
  }

  return matches;
}

export async function searchSnapshots(snapshotsDir, query, fileNames) {
  const words = parseSearchQueryWords(query);
  if (words.length === 0) return [];

  const matches = [];
  for (const name of fileNames) {
    const parts = extractSnapshotPartsFromName(name);
    if (!parts) continue;

    const text = await readNamedFileText(snapshotsDir, name);
    if (text == null) continue;
    const score = scoreSearchFields(words, [{ text, weight: 1 }]);
    if (score != null) {
      matches.push({ ...parts, score });
    }
  }

  return matches;
}
