// Extracted search helpers — pure functions testable without browser APIs

/**
 * Merge write-buffer entries into the interactions array, deduplicating by URL
 * (last-write-wins).
 *
 * Mutates and returns { interactions }.
 */
export function mergeBufferIntoInteractions(interactions, buffer) {
  const indexByUrl = new Map();
  interactions.forEach((interaction, i) => {
    indexByUrl.set(interaction.url, i);
  });

  for (const entry of buffer) {
    const interaction = entry.interaction;
    const existingIdx = indexByUrl.get(interaction.url);
    if (existingIdx !== undefined) {
      interactions[existingIdx] = interaction;
    } else {
      indexByUrl.set(interaction.url, interactions.length);
      interactions.push(interaction);
    }
  }

  interactions.sort((a, b) => a.timestamp - b.timestamp);
  return { interactions };
}

/**
 * Get buffer content map: slug → markdown for entries in the write buffer.
 * Used to overlay fresh content on pipelined batches.
 */
export function getBufferContentMap(buffer) {
  const contentMap = {};
  for (const entry of buffer) {
    if (entry.markdown && entry.interaction.slug) {
      contentMap[entry.interaction.slug] = entry.markdown;
    }
  }
  return contentMap;
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
    interaction.id = data.id;
    interaction.timestamp = BigInt(data.timestamp);
    interaction.setIntent(data.intent || '');

    interaction.setContent((data.slug && contentMap[data.slug]) || '');

    interaction.setAttention(data.attention || '');
    engine.addInteraction(interaction);
  }
}
