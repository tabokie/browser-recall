# File System Storage

The Portal extension now supports automatic, continuous writing of your interaction history to a user-designated folder on your computer.

## How It Works

### 1. One-Time Setup

1. Open extension options (right-click extension icon → Options)
2. In the "File System Storage" section, click "Select Directory"
3. Choose a folder (e.g., `~/Documents/PortalHistory/`)
4. Grant permission when prompted
5. Optionally sync all existing history immediately

### 2. Automatic Writing

- Every time you visit a webpage, the interaction is automatically written to the selected directory
- **No export needed** - files are always up-to-date
- Files are organized by date: `2026-02-09.jsonl`
- Continues working even after browser restarts (permission is saved)

### 3. File Format

Files use **JSONL** (JSON Lines) format:
- One complete JSON object per line
- Easy to read with any text editor
- Easy to process with command-line tools

Example file content (`2026-02-09.jsonl`):
```json
{"id":"1707523200000-https://example.com","timestamp":1707523200000,"url":"https://example.com","title":"Example Page","intent":"","content":"Page content...","attention":"{\"scrollDepth\":75,\"timeOnPage\":45000,\"highlights\":[],\"clicks\":3}"}
{"id":"1707523300000-https://github.com","timestamp":1707523300000,"url":"https://github.com","title":"GitHub","intent":"[{\"type\":\"search\",\"value\":\"rust wasm\"}]","content":"GitHub content...","attention":"{\"scrollDepth\":100,\"timeOnPage\":120000,\"highlights\":[{\"text\":\"WebAssembly\",\"timestamp\":1707523350000}],\"clicks\":12}"}
```

### 4. Directory Structure

```
PortalHistory/
├── README.md              # Auto-generated documentation
├── 2026-02-08.jsonl      # Previous day's interactions
├── 2026-02-09.jsonl      # Today's interactions
└── 2026-02-10.jsonl      # Future interactions...
```

## Benefits

### Human-Readable
- Open with any text editor
- No proprietary format
- Self-documenting JSON structure

### No Export Needed
- Files are updated in real-time
- Always current and accessible
- No manual export/backup steps

### Tool-Friendly
Process with standard command-line tools:

```bash
# Count today's interactions
wc -l 2026-02-09.jsonl

# Search for specific URL
grep "github.com" *.jsonl

# Extract all URLs with jq
jq -r '.url' 2026-02-09.jsonl

# Find interactions with highlights
jq 'select(.attention | fromjson | .highlights | length > 0)' 2026-02-09.jsonl

# Get total time spent today
jq -r '.attention | fromjson | .timeOnPage' 2026-02-09.jsonl | awk '{sum+=$1} END {print sum/1000 " seconds"}'
```

### Privacy-Friendly
- Data stays on your local machine
- Full control over storage location
- Easy to backup, encrypt, or version control

## Technical Details

### Browser Support
Uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API):
- Chrome 86+
- Edge 86+
- Not supported in Firefox (as of 2026-02)

### Permission Model
- One-time directory selection
- Permission persists across browser sessions
- Stored in browser's IndexedDB
- Can revoke anytime with "Disconnect" button

### Performance
- Async file writes (non-blocking)
- Appends to daily file (efficient)
- No impact on browsing speed

### Limitations
- Only writes when options page has been opened at least once per session (establishes permission)
- If options page is closed, writes are queued in chrome.storage.local
- Can manually sync anytime with "Sync All History Now" button

## Use Cases

### Research Journal
Keep timestamped records of your research browsing with attention data showing what you found interesting.

### Work Log
Automatic work diary - see what sites you visited, what you searched for, how long you spent.

### Knowledge Management
Feed your interaction history into personal knowledge management systems, note-taking apps, or LLMs for context.

### Data Analysis
Analyze your browsing patterns, search queries, and attention metrics over time.

### Backup & Sync
- Put directory in Dropbox/Google Drive for automatic cloud backup
- Version control with git for historical tracking
- Sync across devices via any file sync service

## Example Processing Scripts

### Python: Load and analyze
```python
import json
from datetime import datetime

with open('2026-02-09.jsonl', 'r') as f:
    interactions = [json.loads(line) for line in f]

# Find most visited domains
from collections import Counter
from urllib.parse import urlparse

domains = [urlparse(i['url']).netloc for i in interactions]
print(Counter(domains).most_common(10))
```

### Shell: Daily summary
```bash
#!/bin/bash
# daily-summary.sh - Generate a summary of today's browsing

TODAY=$(date +%Y-%m-%d)
FILE="$TODAY.jsonl"

echo "=== Browsing Summary for $TODAY ==="
echo "Total pages visited: $(wc -l < "$FILE")"
echo ""
echo "Top 10 domains:"
jq -r '.url' "$FILE" | sed 's|https\?://||' | cut -d/ -f1 | sort | uniq -c | sort -rn | head -10
```

## Troubleshooting

### "Permission denied" errors
- Click "Select Directory" again to re-grant permission
- Make sure the directory hasn't been deleted or moved

### Files not updating
- Open the extension options page once per browser session
- Check that filesystem storage shows "Connected ✓"
- Click "Sync All History Now" to force a write

### Want to change directory
- Click "Disconnect" first
- Then "Select Directory" and choose a new location
- Old files won't be moved automatically

## Privacy Note

All data is stored locally on your machine. The extension does not send any data to external servers. You have complete control over:
- Where files are stored
- Who has access to the directory
- When to enable/disable filesystem storage
- What data is captured (configure in settings)
