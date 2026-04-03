# 01 — Search within snapshots & notes

## Context

Current Explore search (`runSearchFilterPipeline` in options.js) only matches title/URL/user_title from in-memory `historyAllEntries`. WASM search (`pipelinedSearch`) exists but is dead code. Notes and snapshot content are not searchable. Goal: progressive multi-phase search where results appear as fast as possible.

## Architecture: Four-phase progressive search

All phases fire concurrently (with per-type concurrency limits). A **generation counter** gates every merge callback — stale results from superseded queries are discarded silently.

| Phase | Source | Where | Speed | Returns |
|-------|--------|-------|-------|---------|
| **0** | In-memory `historyAllEntries` | JS (existing `wordsMatchItem`) | Instant | title/URL matches, score=0 |
| **1** | ALL JSONL history files | WASM `searchBatch` × N chunks (concurrency=3) | Fast | title/url/intent matches with scores |
| **2a** | `data/notes/*.json` | New WASM `searchNotes` | Fast | note excerpt + annotation matches |
| **2b** | `data/snapshots/*.md` (latest per slug) | New WASM `searchSnapshots` × M chunks (concurrency=2) | Slow | snapshot content matches |

**Dirty data**: Only `logBuffer` (undrained JSONL entries) — already handled by Phase 1's buffer search path. Notes and snapshots are flushed to disk before UI responds.

**Phase 1 has no content scoring by design.** The existing `searchBatch` reads page markdown from `pages/{slug}/{timestamp}.md` subdirectories, but those directories **don't exist** — all content is in `data/snapshots/`. So Phase 1's `content_score` field is always empty, scoring only title + intent. This is correct: snapshot content is covered by Phase 2b. Do not "fix" the broken `pages/{slug}/` read path in `searchBatch`.

**Only active when there's a search query.** All-history demand-loading mode is unchanged.

## Result merging

- Deduplicate by URL across all phases
- When a URL already exists: take max score, add source badge (`[note]`, `[snapshot]`)
- When a URL is new (found only via notes/snapshots): load page entity via `readCacheable('page:' + slug)` for display metadata (title, url, childIds, etc.)
- After each merge: re-sort the master `searchResults` array, call `vs.updateData(sorted, renderer)` — virtual scroller only re-renders visible rows
- Filters (`filterState`) apply to all phase results via `enrichForFilters` + `applyFilters`

## UI

- **Spinner**: shown while any phase is still running, hidden when all complete
- **Badges**: small `[note]` / `[snapshot]` badge on result rows that matched via content (not title/URL). Badge only, no context snippet.

## Implementation steps

### Step 1: Upgrade WASM matching semantics (`src/lib.rs`)

Current `content_score` does simple `contains()`. Upgrade to match Phase 0 semantics:
- Parse query into words (split on whitespace, quoted phrases stay together)
- Require ALL words present (AND semantics)
- Quoted words use word-boundary matching
- Apply to title, content, and intent fields

### Step 2: New WASM function `searchNotes` (`src/lib.rs`)

```
#[wasm_bindgen(js_name = "searchNotes")]
pub async fn search_notes(
    notes_dir: JsValue,     // FileSystemDirectoryHandle for data/notes/
    query: String,
) -> Result<JsValue, JsValue>
```

- Iterate all `.json` files in `notes_dir`
- Parse JSON via serde_json, extract `excerpt` (string or array) and `note` fields
- Match query words against excerpt + note text (AND semantics)
- Return `Vec<{ url: String, noteSlug: String }>` for matches

### Step 3: New WASM function `searchSnapshots` (`src/lib.rs`)

```
#[wasm_bindgen(js_name = "searchSnapshots")]
pub async fn search_snapshots(
    snapshots_dir: JsValue,  // FileSystemDirectoryHandle for data/snapshots/
    query: String,
    file_names: Vec<String>,  // batched, latest-per-slug only
) -> Result<JsValue, JsValue>
```

- Read each `.md` file by name from `snapshots_dir`
- Match query words against markdown content (AND semantics)
- Extract slug from filename via regex `^(.+)-(\d{13})\.md$`
- Return `Vec<{ slug: String }>` for matches

### Step 4: Wire up `pipelinedSearch` for streaming (`extension/options.js`)

Rewrite `pipelinedSearch` to support per-chunk callbacks instead of `Promise.all`:

```js
async function pipelinedSearchStreaming(query, generation, onChunkResults) {
  // ... setup (initWasm, get dirs, list files, extract buffer) ...
  const CHUNK = 10;
  const CONCURRENCY = 3; // Phase 1 concurrency limit
  // Process chunks with limited concurrency
  // After each chunk: merge into byUrl map, call onChunkResults(newResults)
  // Also search logBuffer (dirty data) and include in first callback
}
```

### Step 5: Search orchestrator (`extension/options.js`)

New function `runProgressiveSearch(allQueries)` replacing the search logic inside `runSearchFilterPipeline`:

```
let searchGeneration = 0;
let searchResults = [];  // master array, mutated by merge callbacks

async function runProgressiveSearch(allQueries) {
  const gen = ++searchGeneration;
  searchResults = [];
  showSearchSpinner();

  // Phase 0: instant in-memory matching (existing wordsMatchItem logic)
  const phase0 = matchInMemory(allQueries);
  mergeResults(phase0, 'title', gen);
  renderResults(gen);

  // Phase 1: WASM JSONL streaming
  pipelinedSearchStreaming(query, gen, (chunkResults) => {
    mergeResults(chunkResults, 'history', gen);
    renderResults(gen);
  });

  // Phase 2a: WASM notes
  searchNotesPhase(query, gen).then(noteResults => {
    mergeResults(noteResults, 'note', gen);
    renderResults(gen);
  });

  // Phase 2b: WASM snapshots (streaming chunks)
  searchSnapshotsPhase(query, gen, (chunkResults) => {
    mergeResults(chunkResults, 'snapshot', gen);
    renderResults(gen);
  });
}

function mergeResults(newResults, source, gen) {
  if (gen !== searchGeneration) return; // stale — discard
  for (const r of newResults) {
    const existing = searchResults.find(e => e.url === r.url);
    if (existing) {
      if (r.score > existing.score) existing.score = r.score;
      existing.matchSources.add(source);
    } else {
      searchResults.push({ ...r, matchSources: new Set([source]) });
    }
  }
}

function renderResults(gen) {
  if (gen !== searchGeneration) return;
  // enrichFromEntityStorage for new entries, applyFilters, sort, updateData
}
```

### Step 6: Snapshot file listing + grouping (`extension/options.js`)

Before Phase 2b, JS lists all files in `data/snapshots/`, groups by slug (regex `^(.+)-(\d{13})\.md$`), picks the latest timestamp per slug, chunks the filenames, and passes each chunk to WASM `searchSnapshots`.

### Step 7: UI changes (`extension/options.html` + `extension/options.js`)

- Add spinner element near search input (reuse existing spinner pattern from loading-states)
- In `resultRowHtml`: if `opts.matchSources` contains 'note' or 'snapshot', render small badge
- CSS for badges (small, muted, inline with existing extras area)

### Step 8: Integrate with `runSearchFilterPipeline`

- When queries are present: call `runProgressiveSearch(allQueries)` instead of the current in-memory matching block
- When no queries (all-history mode): unchanged demand-loading behavior
- Filter state still applies to all results
- Time chart updates after each render

## Files modified

| File | Changes |
|------|---------|
| `src/lib.rs` | Upgrade `content_score` to AND/quoted matching; add `searchNotes`, `searchSnapshots` functions |
| `extension/options.js` | Rewrite `pipelinedSearch` → streaming; add `runProgressiveSearch` orchestrator; add `mergeResults`; wire into `runSearchFilterPipeline`; spinner show/hide; badge rendering in `resultRowHtml` |
| `extension/options.html` | Add spinner element for content search |
| `tests/progressive-loading.test.js` | 4 new tests (see below) |

## Tests (progressive-loading.test.js)

Using existing deferred-promise pattern:

**T-content-1: Phase 0 renders before Phase 1/2 complete**
- Block `searchBatch`, `searchNotes`, `searchSnapshots` via deferred promises
- Trigger search with a query matching a title in `historyAllEntries`
- Assert: result visible in DOM (Phase 0)
- Resolve deferreds → assert: more results may appear, no crash

**T-content-2: Phase 1 streaming — first chunk renders before second completes**
- `searchBatch` mock: first call resolves immediately with results, second call blocks on deferred
- Trigger search
- Assert: first chunk's results visible
- Resolve second chunk → assert: merged results visible

**T-content-3: Phase 2 results merge without destroying Phase 0/1 results**
- Let Phase 0 + Phase 1 complete (mock `searchBatch` returns results)
- Block `searchNotes` on deferred
- Assert: Phase 0/1 results visible, count = N
- Resolve notes deferred with a new URL not in Phase 0/1
- Assert: result count = N+1, original results still present

**T-content-4: Stale generation discarded**
- Block all WASM calls on deferred
- Fire search "react"
- Fire new search "vue" (increments generation)
- Resolve "react" deferreds with react-specific results
- Assert: no react results in DOM (stale generation)
- Resolve "vue" deferreds → assert: vue results appear

## Verification

1. `cargo build --target wasm32-unknown-unknown` — Rust compiles
2. `wasm-pack build` — WASM package builds
3. `npm test` — all unit tests pass (including 4 new ones)
4. `npx playwright test tests/e2e/search.spec.js` — E2E search tests pass
5. Manual: search for text only in a snapshot → verify it appears with `[snapshot]` badge after spinner
6. Manual: search for text only in a note annotation → verify it appears with `[note]` badge
