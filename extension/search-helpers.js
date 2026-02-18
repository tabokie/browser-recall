// Extracted search helpers — pure functions testable without browser APIs

/**
 * Extract visit entries from the logBuffer.
 * The logBuffer contains entries of different types: visits (no action field)
 * and mutations (with action field). This returns only visit entries.
 */
export function extractInteractionBuffer(logBuffer) {
  return logBuffer.filter(e => !e.action);
}

/**
 * Merge log buffer visit entries into the interactions array, deduplicating
 * by URL (last-write-wins).
 *
 * Mutates and returns { interactions }.
 */
export function mergeBufferIntoInteractions(interactions, buffer) {
  const indexByUrl = new Map();
  interactions.forEach((interaction, i) => {
    indexByUrl.set(interaction.url, i);
  });

  for (const entry of buffer) {
    // Log buffer entries are flat (url, title, timestamp, slug, etc.)
    const existingIdx = indexByUrl.get(entry.url);
    if (existingIdx !== undefined) {
      interactions[existingIdx] = entry;
    } else {
      indexByUrl.set(entry.url, interactions.length);
      interactions.push(entry);
    }
  }

  interactions.sort((a, b) => a.timestamp - b.timestamp);
  return { interactions };
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
 * Build WASM Interaction objects from raw data and add them to a SearchEngine.
 *
 * @param {Function} InteractionClass – the WASM Interaction constructor
 * @param {object}   engine           – a SearchEngine instance
 * @param {Array}    dataList         – raw interaction objects
 * @param {object}   contentMap       – slug → markdown content
 */
export function buildInteractionsForEngine(InteractionClass, engine, dataList, contentMap) {
  for (const data of dataList) {
    const interaction = new InteractionClass(data.url, data.title);
    interaction.timestamp = BigInt(data.timestamp);
    interaction.setIntent(data.intent || '');

    interaction.setContent((data.slug && contentMap[data.slug]) || '');

    const att = data.attention;
    interaction.setAttention(typeof att === 'string' ? att : (att ? JSON.stringify(att) : ''));
    engine.addInteraction(interaction);
  }
}
