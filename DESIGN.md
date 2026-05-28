# Browser Recall — Design

## Vision

Browser Recall is a personal knowledge system that captures everything you do in the browser — intent, data, and attention — and makes it searchable. It is a memory extension, not a bookmarking tool.

## Portals

Portals are where we interact with external data sources: browsing webpages, chatting with LLMs, reading documents. There are three types of information embedded in an interaction:

- **User Intent** — search keywords, prompts, navigation decisions
- **External Data** — the content itself
- **User Attention** — engagement patterns, scroll depth, time on page, highlights, clicks

The system keeps records of intent and attention to the finest detail possible, and optionally archives external material based on its quality (+rarity, +uniqueness, -reproducibility).

Beyond being an external memory, the history of interactions (timeline and lineage) can:

- Reconstruct thought processes or explore alternative reasoning paths.
- Deduce cognitive preference or bias, valuable for information discovery.
- Categorize information based on context (activity patterns — work, research, leisure), not content.

Some portals support lineage tracking natively (hyperlinks). For those that don't, we use temporal proximity as a heuristic.

## Notes and Ideas

Notes and ideas are a special type of data with no explicit intent or attention — they *are* the intent/attention incarnated. They are recorded in the same timeline as portal interactions, making them first-class citizens alongside browsing history.

Compared to portals, notes have special opportunities: they capture the user's synthesis of information, which is often more valuable than the raw source material. Notes are immutable — editing creates a new entity via `replace_note`, preserving the full change history in the JSONL log.

## Search Over Graphs

The system intentionally avoids displaying information as a graph. Graphs carry an opinion (stronger than alternatives) that intrudes on how the user thinks. Branching structures are taxing on working memory and notoriously hard to navigate.

Instead, the system displays sorted lists — like a search engine, but private. With private data, we have multiple ranking algorithms to choose from: content relevance, temporal context, lineage distance, and attention weight. The user can mix all of them.

Each search query can be **pinned** to become a **materialized view** (a "list"). Users can selectively save results and subscribe to changes when new information matches the original query. Rules automate this: keyword rules match by pattern, function rules by user-defined JS predicates.

## File-System-First Architecture

All data is stored as human-readable files on the user's local machine:

- **JSONL event logs** (`logs/<device>/YYYY-MM-DD.jsonl`) — source of truth
- **Replay-derived checkpoints** (`views/pages/`, `views/lists/`, `views/manifest/`) — rebuildable from logs
- **User artifacts** (`objects/notes/`, `objects/snapshots/`) — note bodies and self-contained HTML/markdown snapshots

No cloud, no database, no export step. The data directory is a portable, inspectable archive that other tools can read. Logs are authoritative; `views/` checkpoints are private derived state that the daemon can rebuild.

This design means Browser Recall is an event-sourced system. The desktop daemon owns storage, replay, search, and sync; the browser extension is a connector for capture and current-page actions. The JSONL log is the authoritative record. Entity files are caches that can be rebuilt by full replay. This gives us:

- **Audit trail**: every mutation is a log entry with a timestamp and device ID.
- **Multi-device merge**: each device appends to its own log. Sync = exchanging log files.
- **Disaster recovery**: replay from logs reconstructs the full state.

## Entity Model

Not every visited page becomes an entity. Page entities are created only by explicit user actions: capturing a snapshot, creating a note, pinning to a list, renaming, or rating. Passive visits exist only as JSONL history entries. This keeps the entity store lean — only pages the user has expressed interest in.

Entities reference each other via typed keys (`page:<slug>`, `note:<slug>`, `snap:<slug>-<ts>`, `list:<id>`). Events use canonical replay fields such as URLs, slugs, and relative artifact references. The Rust replay layer translates between logs and materialized entities.

## Deletion Model

Deletion is logical, not physical. Deleting a note, list, or snapshot unlinks it from the entity graph and adds its key to the orphaned manifest. The underlying file stays on disk. This preserves replay idempotency — the JSONL history can reference any entity that ever existed, and replaying history always produces consistent state.

A separate permanent-delete operation (accessible via the recycle bin UI) removes files from disk after the user explicitly confirms.

## Attention as a First-Class Signal

Attention data (scroll depth, time on page, click count, text selections) is accumulated by the content script and reported on page leave. This makes attention a rich per-visit signal, not just a binary "visited" flag. Search ranking uses attention weight alongside content relevance, giving heavily-studied pages higher prominence than drive-by visits.

## Privacy Model

All data stays on the user's machine. There is no telemetry, no analytics, no Browser Recall server. Optional multi-device sync uses the user's own GitHub repository as a transport layer and is handled by the desktop daemon. The extension does not hold sync tokens.

## Technology Choices

- **Vanilla JavaScript** — no frameworks. The desktop UI and connector surfaces are plain HTML/JS staged with local shared modules.
- **Rust daemon and replay crates** — storage, replay, search, sync, and websocket pairing live on the desktop side.
- **Tauri desktop shell** — app window, tray, deep links, pairing approval, and OS integration.
- **Chrome MV3 connector** — service worker, popup, content scripts, context menus, and short-lived command buffering.
- **Event sourcing** — JSONL logs as source of truth, entity files as derived checkpoints. Chosen for auditability, multi-device merge simplicity, and disaster recovery.
