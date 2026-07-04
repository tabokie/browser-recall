// Extracted search helpers — pure functions testable without browser APIs

/**
 * Extract visit entries from the extension's pending Desktop command queue.
 * The queue stores connector items shaped as { kind: 'command', action, request }.
 */
export function extractHistoryQueue(desktopCommandQueue) {
  return desktopCommandQueue
    .map((item) => {
      if (item?.kind === 'command' && item.action === 'reportVisit') {
        return { action: 'visit_page', ...item.request };
      }
      if (item?.kind === 'command' && item.action === 'reportLeave') {
        return { action: 'leave_page', ...item.request };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Merge pending visit entries into the history entries array, deduplicating
 * by URL (last-write-wins).
 *
 * Mutates and returns { entries }.
 */
export function mergeQueueIntoHistory(entries, queueEntries) {
  const indexByUrl = new Map();
  entries.forEach((entry, i) => {
    indexByUrl.set(entry.url, i);
  });

  for (const queueEntry of queueEntries) {
    const existingIdx = indexByUrl.get(queueEntry.url);
    if (existingIdx !== undefined) {
      entries[existingIdx] = queueEntry;
    } else {
      indexByUrl.set(queueEntry.url, entries.length);
      entries.push(queueEntry);
    }
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);
  return { entries };
}

/**
 * Get queue content map: slug → markdown for entries in the pending queue.
 * In the event-sourced model, content is on disk (referenced by mdPath).
 * This returns an empty map — content is not inline in log entries.
 */
export function getQueueContentMap(_queueEntries) {
  return {};
}

/**
 * Build HistoryEntry objects from raw data and add them to a SearchEngine.
 *
 * @param {Function} HistoryEntryClass – the HistoryEntry constructor
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
