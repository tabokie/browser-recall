# Portal Extension Architecture

## Overview

Portal uses **file system as the primary storage**, with browser's local storage serving only as a fast write buffer.

## Storage Architecture

### Primary Storage: File System
- **Location**: User-designated directory (e.g., `~/Documents/PortalHistory/`)
- **Format**: JSONL (JSON Lines) - one interaction per line
- **Organization**: Daily files (`2026-02-09.jsonl`)
- **Persistence**: Survives browser restarts, extension reloads, and updates
- **Human-readable**: Can be opened with any text editor
- **Tool-friendly**: Process with `jq`, `grep`, Python, etc.

### Write Buffer: IndexedDB via chrome.storage.local
- **Purpose**: Fast write buffer for pending interactions
- **Lifetime**: Temporary - flushed to filesystem periodically
- **Size**: Typically 0-50 items
- **Flush triggers**:
  - Immediate: Every new interaction attempts immediate write
  - Batch: When buffer reaches 10 items
  - Periodic: Every 60 seconds
  - Manual: User can trigger flush in options

## Component Architecture

```
┌─────────────────┐
│  Content Script │ Captures user intent & attention
└────────┬────────┘
         │ (sends data)
         ▼
┌─────────────────┐
│ Background      │ Creates interaction records
│ Service Worker  │ Writes to buffer (fast)
└────────┬────────┘
         │ (triggers flush)
         ▼
┌─────────────────┐
│ Offscreen       │ Manages filesystem I/O
│ Document        │ Flushes buffer to files
└────────┬────────┘
         │ (writes)
         ▼
┌─────────────────┐
│ File System     │ 2026-02-09.jsonl
│ (Primary Store) │ 2026-02-10.jsonl
└─────────────────┘
         │
         │ (reads)
         ▼
┌─────────────────┐
│ Popup / Search  │ Loads from files + buffer
└─────────────────┘
```

## Data Flow

### Write Path (New Interaction)

1. **Content Script** captures page visit
   - Extracts intent (search queries, input fields)
   - Tracks attention (scroll depth, highlights, time on page)

2. **Background Worker** creates interaction record
   ```javascript
   {
     id: "timestamp-url",
     timestamp: 1707523200000,
     url: "https://example.com",
     title: "Page Title",
     intent: "[{\"type\":\"search\",\"value\":\"query\"}]",
     content: "Extracted page content...",
     attention: "{\"scrollDepth\":75,\"timeOnPage\":45000,...}"
   }
   ```

3. **Write Buffer** (IndexedDB) stores temporarily
   - Fast write (~1-5ms)
   - Non-blocking browser operation

4. **Offscreen Document** flushes to filesystem
   - Immediate attempt on each write
   - Batch flush when buffer reaches 10 items
   - Periodic flush every 60 seconds
   - Appends to daily JSONL file

### Read Path (Search / Display)

1. **Popup** requests data
   - Sends message to offscreen document: `{ action: 'loadInteractions' }`

2. **Offscreen Document** loads from filesystem
   - Reads all `.jsonl` files
   - Parses JSONL (one JSON object per line)
   - Returns array of interactions

3. **Popup** merges with buffer
   - Loads pending writes from `chrome.storage.local`
   - Merges by ID (deduplicates)
   - Sorts by timestamp

4. **WASM Search Engine** performs search
   - Loads interactions into Rust-based search engine
   - Applies ranking algorithm (Content/Context/Lineage/Attention/Hybrid)
   - Returns ranked results

## File Format

### JSONL Files

Each file contains interactions for one day:

**Filename**: `YYYY-MM-DD.jsonl`

**Content**: One complete JSON object per line (newline-delimited)
```
{"id":"...","timestamp":...,"url":"...","title":"...",...}
{"id":"...","timestamp":...,"url":"...","title":"...",...}
```

**Benefits**:
- Easy to append (no need to rewrite entire file)
- Easy to parse (line-by-line)
- Compatible with standard tools (`jq`, `grep`, `awk`)
- Human-readable with any text editor

### README.md

Auto-generated in storage directory:
- Documents file format
- Shows total interaction count
- Provides usage examples

## Permission Model

### File System Access API
- **User gesture required**: Initial directory selection
- **Persistent permission**: Saved in IndexedDB
- **Survives sessions**: No need to re-grant on browser restart
- **Revocable**: User can disconnect anytime

### Browser Support
- ✅ Chrome 86+ (Fully supported)
- ✅ Edge 86+ (Fully supported)
- ❌ Firefox (Not yet supported as of 2026-02)
- ❌ Safari (Not yet supported)

## Key Features

### 1. No Data Loss
- Write buffer ensures fast, reliable writes
- Periodic flush prevents buffer buildup
- Filesystem provides durable storage

### 2. Human-Readable
- All data in standard JSON format
- Files can be opened with any text editor
- Self-documenting structure

### 3. Tool-Friendly
```bash
# Count interactions
wc -l *.jsonl

# Search URLs
grep "github.com" *.jsonl

# Extract with jq
jq -r '.title' 2026-02-09.jsonl

# Analyze attention patterns
jq '.attention | fromjson | .scrollDepth' 2026-02-09.jsonl
```

### 4. Privacy-First
- All data stays on local machine
- No cloud services
- User controls storage location
- Easy to backup/encrypt/delete

### 5. No Export Needed
- Files are always up-to-date
- No manual export step
- Direct file access anytime

## Configuration

### First-Time Setup
1. Install extension
2. Extension opens options page automatically
3. User clicks "Select Directory"
4. Choose storage location (e.g., `~/Documents/PortalHistory/`)
5. Grant permission
6. Extension starts capturing interactions

### Changing Storage Location
1. Open options page
2. Click "Change Directory"
3. Select new location
4. Extension automatically migrates all existing data

### Clear All Data
1. Open options page
2. Click "Clear All Data" (danger button)
3. Confirm twice
4. All `.jsonl` files in storage directory are deleted
5. Write buffer is cleared

## Performance

### Write Performance
- Buffer write: ~1-5ms (IndexedDB)
- Filesystem write: ~10-50ms (append to file)
- No blocking: Writes are async

### Read Performance
- Load 1000 interactions: ~50-100ms
- Parse JSONL: ~20-30ms per file
- Search with WASM: ~10-50ms

### Storage Efficiency
- Each interaction: ~500-2000 bytes
- 1000 interactions: ~0.5-2 MB
- Daily file (50 pages): ~25-100 KB
- Yearly storage (18,000 pages): ~9-36 MB

## Error Handling

### Permission Denied
- Show warning in options page
- Prompt user to reselect directory
- Fall back to buffer-only mode temporarily

### Filesystem Write Failure
- Keep data in buffer
- Retry on next flush
- Show warning if buffer grows too large (>100 items)

### Filesystem Read Failure
- Show empty results
- Prompt user to check storage location
- Provide link to options page

## Future Enhancements

### Planned
- [ ] Compression for old files (`.jsonl.gz`)
- [ ] Data retention policy (auto-delete old files)
- [ ] Import/export to other formats (CSV, Markdown)
- [ ] Sync across devices (via file sync services)
- [ ] Full-text search index for faster queries

### Considered
- [ ] Incremental backups
- [ ] Encryption at rest
- [ ] Cloud storage integration (optional)
- [ ] API for third-party tools
