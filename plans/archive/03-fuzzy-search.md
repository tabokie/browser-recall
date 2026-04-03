# Plan 03: Fuzzy Search for Unquoted Keywords

## Context

Currently, unquoted search keywords use case-insensitive substring matching (`contains()`). This means typos like "raect" for "react" return zero results. We want fuzzy matching for unquoted keywords so near-misses surface relevant results.

**Approach**: uFuzzy (JS, Phase 0) + Damerau-Levenshtein (Rust, Phases 1/2). Quoted phrases remain exact word-boundary matches — unchanged.

## Architecture

```
Query: raect "hooks"
        │
  parseSearchWords()
        │
  ┌─────┴─────┐
  │ "raect"   │ "hooks"
  │ exact:false│ exact:true
  └─────┬─────┘
        │
  Phase 0 (JS in-memory):
  │  unquoted → uFuzzy search against haystack
  │  quoted   → matchesExactWithBoundary (unchanged)
  │  intersect indices (AND semantics)
        │
  Phases 1-2 (Rust/WASM):
     unquoted → substring check first, then Damerau-Levenshtein
                against tokenized field words
     quoted   → word-boundary match (unchanged)
```

## Implementation Steps

### Step 1: Vendor uFuzzy into extension

Copy `node_modules/@leeoniya/ufuzzy/dist/uFuzzy.iife.min.js` to `extension/vendor/ufuzzy.js`. Use IIFE build (not ESM) because options.html can load it via `<script>` before the module script, making `uFuzzy` available as a global — simpler than dynamic import.

**Files**: `extension/vendor/ufuzzy.js` (new), `extension/options.html`

### Step 2: Phase 0 — uFuzzy for in-memory fuzzy matching

Replace the `wordsMatchItem` loop in `runProgressiveSearch()` with a uFuzzy-based approach:

```javascript
// Build haystack once at search time (title + url per entry)
const haystack = historyAllEntries.map(item =>
  [item.user_title || '', item.title || '', item.url || ''].join(' ')
);
const uf = new uFuzzy({ intraMode: 1 }); // SingleError = DL distance 1

// Per-word matching with AND semantics
let matchingIndices = null;
for (const { q, exact } of parseSearchWords(query)) {
  let wordMatches;
  if (exact) {
    // Unchanged: word-boundary exact match
    wordMatches = new Set();
    for (let i = 0; i < historyAllEntries.length; i++) {
      const item = historyAllEntries[i];
      const fields = [item.user_title, item.title, item.url];
      if (fields.some(f => f && matchesExactWithBoundary(f, q))) {
        wordMatches.add(i);
      }
    }
  } else {
    // NEW: fuzzy match via uFuzzy
    const [idxs] = uf.search(haystack, q);
    wordMatches = new Set(idxs || []);
  }
  // Intersect across words
  if (matchingIndices === null) matchingIndices = wordMatches;
  else matchingIndices = new Set([...matchingIndices].filter(i => wordMatches.has(i)));
}
```

**Files**: `extension/options.js` — modify `runProgressiveSearch()` (lines 516-543)

### Step 3: Rust — Damerau-Levenshtein distance function

Hand-roll ~40 lines in `src/lib.rs`. No external crate — keeps WASM binary small.

```rust
fn damerau_levenshtein(a: &str, b: &str) -> usize {
    // Standard optimal string alignment distance
    // Handles: insertion, deletion, substitution, adjacent transposition
}
```

**Threshold policy** (matches Algolia's approach):
- Query word length <= 2: no fuzzy (substring only)
- Query word length 3-4: max distance 1
- Query word length >= 5: max distance 2

**Files**: `src/lib.rs`

### Step 4: Rust — Tokenize fields + fuzzy word matching

Add a `tokenize` helper that splits text on non-alphanumeric boundaries. Modify `word_matches_text` to return match quality instead of bool:

```rust
enum MatchQuality {
    Exact,      // substring or word-boundary match (quality = 1.0)
    Fuzzy(u32), // edit distance (quality = 1.0 - distance * 0.3)
}

fn word_match_quality(word: &QueryWord, text: &str) -> Option<MatchQuality> {
    let lower = text.to_lowercase();
    if word.exact {
        // Word-boundary matching (unchanged logic)
        return if boundary_match(&lower, &word.text) { Some(Exact) } else { None };
    }
    // 1. Try substring first (fast path, covers prefix matching)
    if lower.contains(&word.text) {
        return Some(Exact);
    }
    // 2. Fuzzy: tokenize field, check DL distance against each token
    let max_dist = match word.text.len() {
        0..=2 => return None,  // too short for fuzzy
        3..=4 => 1,
        _     => 2,
    };
    let mut best_dist = usize::MAX;
    for token in tokenize(&lower) {
        // Compare against whole token
        let d = damerau_levenshtein(&word.text, token);
        best_dist = best_dist.min(d);
        // Compare against token prefix (handles incomplete typing + typo)
        if token.len() > word.text.len() {
            let prefix_len = (word.text.len() + max_dist).min(token.len());
            let d = damerau_levenshtein(&word.text, &token[..prefix_len]);
            best_dist = best_dist.min(d);
        }
        if best_dist == 0 { break; } // can't beat exact
    }
    if best_dist <= max_dist { Some(Fuzzy(best_dist as u32)) } else { None }
}
```

**Files**: `src/lib.rs`

### Step 5: Rust — Quality-aware scoring

Modify `content_score` to weight fuzzy matches lower than exact matches:

```rust
fn field_match_quality(words: &[QueryWord], text: &str) -> Option<f64> {
    let mut total = 0.0;
    for word in words {
        match word_match_quality(word, text) {
            None => return None,
            Some(Exact) => total += 1.0,
            Some(Fuzzy(d)) => total += (1.0 - d as f64 * 0.3).max(0.1),
        }
    }
    Some(total / words.len() as f64)
}

fn content_score(entry: &HistoryEntry, words: &[QueryWord]) -> f64 {
    let mut score = 0.0;
    if let Some(q) = field_match_quality(words, &entry.title) { score += 2.0 * q; }
    if !entry.content.is_empty() {
        if let Some(q) = field_match_quality(words, &entry.content) { score += 1.0 * q; }
    }
    if !entry.intent.is_empty() {
        if let Some(q) = field_match_quality(words, &entry.intent) { score += 1.5 * q; }
    }
    score
}
```

Score examples (all words in title):
| Match type | Quality per word | Field score (title=2.0) |
|------------|-----------------|------------------------|
| All exact/substring | 1.0 | 2.0 |
| All fuzzy distance-1 | 0.7 | 1.4 |
| All fuzzy distance-2 | 0.4 | 0.8 |
| Mixed (1 exact + 1 fuzzy-1) | 0.85 | 1.7 |

**Files**: `src/lib.rs`

### Step 6: Rust — Update `words_match_fields` (bool filter)

Keep returning bool for notes/snapshots phases (they use fixed scores). Just call `word_match_quality` and check for `Some`:

```rust
fn words_match_fields(words: &[QueryWord], fields: &[&str]) -> bool {
    words.iter().all(|w| {
        fields.iter().any(|f| word_match_quality(w, f).is_some())
    })
}
```

**Files**: `src/lib.rs`

### Step 7: Tests

1. **Unit tests** (vitest): uFuzzy integration in Phase 0 matching logic — extract the new matching function and test with typo queries
2. **Rust tests** (`#[cfg(test)]`): Damerau-Levenshtein distance, tokenize, word_match_quality with edge cases
3. **E2E tests** (playwright): Search for a seeded page title with a typo query, verify it appears in results

**Files**: `tests/unit/`, `src/lib.rs` (test module), `tests/e2e/`

## Files Modified (summary)

| File | Change |
|------|--------|
| `extension/vendor/ufuzzy.js` | NEW — vendored IIFE build |
| `extension/options.html` | Add `<script>` for ufuzzy vendor |
| `extension/options.js` | Phase 0 fuzzy matching via uFuzzy |
| `src/lib.rs` | DL distance, tokenize, quality-aware matching + scoring |
| `tests/` | Unit + E2E tests for fuzzy search |

## Verification

1. `npm run build:wasm` — WASM compiles with new Rust code
2. `npm test` — unit tests pass (including new fuzzy tests)
3. `npx playwright test` — E2E tests pass (including new fuzzy search tests)
4. Manual: open options page, search for a visited page with a typo → should appear in results with slightly lower ranking than exact match
