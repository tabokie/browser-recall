// Extracted search helpers — pure functions testable without browser APIs

/**
 * Extract visit entries from the logBuffer.
 * The logBuffer contains entries of different types: visits (action: 'visit_page')
 * and mutations (other action values). This returns only visit entries.
 */
export function extractHistoryBuffer(logBuffer) {
  return logBuffer.filter(
    (e) => !e.action || e.action === 'visit_page' || e.action === 'leave_page',
  );
}

/**
 * Merge log buffer visit entries into the history entries array, deduplicating
 * by URL (last-write-wins).
 *
 * Mutates and returns { entries }.
 */
export function mergeBufferIntoHistory(entries, buffer) {
  const indexByUrl = new Map();
  entries.forEach((entry, i) => {
    indexByUrl.set(entry.url, i);
  });

  for (const bufEntry of buffer) {
    // Log buffer entries are flat (url, title, timestamp, slug, etc.)
    const existingIdx = indexByUrl.get(bufEntry.url);
    if (existingIdx !== undefined) {
      entries[existingIdx] = bufEntry;
    } else {
      indexByUrl.set(bufEntry.url, entries.length);
      entries.push(bufEntry);
    }
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);
  return { entries };
}

/**
 * Get buffer content map: slug → markdown for entries in the log buffer.
 * In the event-sourced model, content is on disk (referenced by mdPath).
 * This returns an empty map — content is not inline in log entries.
 */
export function getBufferContentMap(buffer) {
  return {};
}

/**
 * Build WASM HistoryEntry objects from raw data and add them to a SearchEngine.
 *
 * @param {Function} HistoryEntryClass – the WASM HistoryEntry constructor
 * @param {object}   engine            – a SearchEngine instance
 * @param {Array}    dataList          – raw history entry objects
 * @param {object}   contentMap        – slug → markdown content
 */
export function buildHistoryForEngine(
  HistoryEntryClass,
  engine,
  dataList,
  contentMap,
) {
  for (const data of dataList) {
    const entry = new HistoryEntryClass(data.url, data.title);
    entry.timestamp = BigInt(data.timestamp);
    entry.setContent((data.slug && contentMap[data.slug]) || '');
    engine.addEntry(entry);
  }
}
