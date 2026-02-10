// Extracted search helpers — pure functions testable without browser APIs

/**
 * Merge write-buffer entries into the interactions array, deduplicating by URL
 * (last-write-wins). Also merges buffer markdown content into contentMap.
 *
 * Mutates and returns { interactions, contentMap }.
 */
export function mergeBufferIntoInteractions(interactions, buffer, contentMap) {
  const indexByUrl = new Map();
  interactions.forEach((interaction, i) => {
    indexByUrl.set(interaction.url, i);
  });

  for (const entry of buffer) {
    const interaction = entry.interaction || entry;
    const existingIdx = indexByUrl.get(interaction.url);
    if (existingIdx !== undefined) {
      interactions[existingIdx] = interaction;
    } else {
      indexByUrl.set(interaction.url, interactions.length);
      interactions.push(interaction);
    }
    if (entry.markdown && interaction.slug) {
      contentMap[interaction.slug] = entry.markdown;
    }
  }

  interactions.sort((a, b) => a.timestamp - b.timestamp);
  return { interactions, contentMap };
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

    const content = (data.slug && contentMap[data.slug]) || data.content || '';
    interaction.setContent(content);

    interaction.setAttention(data.attention || '');
    engine.addInteraction(interaction);
  }
}
