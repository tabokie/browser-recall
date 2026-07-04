# Fuzzy Search Research

Benchmarked on ~/portal-data: 1001 pages, 227 snapshots (2 MB markdown), 37 notes.

## Library Comparison (1001 docs, url+title fields)

| | **uFuzzy** | **MiniSearch** | **FlexSearch** |
|---|---|---|---|
| **Index?** | No (regex scan) | Inverted index | Contextual index |
| **Build time** | 0 | 15 ms | 35 ms |
| **Search latency** | 0.8 ms | 0.1 ms | 0.005 ms |
| **Serialized index** | 0 | **378 KB** | **3 MB** |
| **Deserialize** | 0 | 11 ms | — |
| **Incremental add** | 0 | 0.007 ms/doc | — |
| **Bundle size** | ~4 KB | ~20 KB | ~6 KB |
| **Heap** | 5 MB | 53 MB | 25 MB |

### uFuzzy (~4 KB, @leeoniya/ufuzzy)
- No index, builds regex at search time, scans every haystack string
- Sub-ms for URL+title (100 KB), ~1.5ms with snapshots (2 MB)
- Zero storage, zero init overhead
- Scales linearly — would slow at ~100 MB corpus

### MiniSearch (~20 KB)
- Inverted index with fuzzy matching (Levenshtein), prefix search, field boosting
- 378 KB serialized index fits in `chrome.storage.session` (10 MB limit)
- Rebuild from entities in 15ms during hydration, or deserialize from session in 11ms
- Incremental `add()` is near-instant (0.007 ms/doc)
- **Best fit for extension architecture**: index in session cache, rebuild on hydrate, incremental updates on addLog

### FlexSearch (~6 KB)
- Contextual index, multiple presets (memory/speed/match)
- 3 MB serialized — too big for session, needs `chrome.storage.local` or filesystem via offscreen
- Fastest search (0.005ms) but overkill — MiniSearch 0.1ms is imperceptible
- Export/import API is callback-based, less ergonomic

## Storage Options for Index (Chrome MV3)

| Storage tier | Capacity | Latency | Survives | Notes |
|-------------|----------|---------|----------|-------|
| In-memory (rebuild on hydrate) | unlimited | 0 read, ~15-35ms build | SW restart: no | Simplest |
| `chrome.storage.session` | 10 MB | IPC ~1ms | SW restart: yes, browser: no | MiniSearch 378 KB fits easily |
| `chrome.storage.local` | 10 MB | LevelDB disk | browser restart: yes | Shared with logBuffer, tight |
| IndexedDB (offscreen) | ~hundreds MB | async disk | browser restart: yes | Best capacity, offscreen only |
| OPFS/filesystem (offscreen) | unlimited | async disk | browser restart: yes | Alongside ~/portal-data |

## Recommendation

MiniSearch in `chrome.storage.session`, rebuilt from page entities during `hydrateCache` (15ms), incrementally updated on each `addLog`. Handles URL+title search. For snapshot full-text, use uFuzzy on-demand (no index needed, 1.5ms/query at current scale).
