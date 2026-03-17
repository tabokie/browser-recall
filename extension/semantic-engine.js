// semantic-engine.js — Offscreen-only embedding module.
// Uses @huggingface/transformers v3 with Xenova/all-MiniLM-L6-v2 quantized int8.
// Loaded by offscreen.js on first semantic rule use. Library vendored locally
// (extension/vendor/); model weights downloaded from HF CDN on first use (~22.8MB),
// cached in browser Cache API after first load.

let pipeline = null;
let extractor = null;
let loading = false;

/**
 * Lazily initialize the feature-extraction pipeline.
 * Singleton — multiple calls during loading return the same promise.
 */
export async function initModel() {
  if (extractor) return;
  if (loading) {
    // Wait for in-flight init
    while (loading) await new Promise(r => setTimeout(r, 50));
    return;
  }
  loading = true;
  try {
    const transformers = await import('./vendor/transformers.min.js');
    transformers.env.allowRemoteModels = true;

    // Extension CSP blocks dynamic import() from CDN but not fetch().
    // The ort WASM backend has two parts:
    //   .mjs module — loaded via import(), must be local (vendored in ./vendor/)
    //   .wasm binary — loaded via fetch(), can come from CDN
    // Set wasmPaths to local so the .mjs import works, then pre-fetch the
    // .wasm binary from CDN and provide it directly to skip locateFile.
    const ortWasm = transformers.env.backends.onnx.wasm;
    ortWasm.wasmPaths = './';
    ortWasm.proxy = false;
    const cdnBase = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${transformers.env.version}/dist/`;
    const wasmResp = await fetch(cdnBase + 'ort-wasm-simd-threaded.jsep.wasm');
    ortWasm.wasmBinary = await wasmResp.arrayBuffer();

    pipeline = transformers.pipeline;
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    });
  } finally {
    loading = false;
  }
}

/**
 * Generate a 384-dim normalized embedding for text.
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function generateEmbedding(text) {
  await initModel();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * Batch generate embeddings.
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]>}
 */
export async function generateEmbeddingBatch(texts) {
  await initModel();
  const results = [];
  for (const text of texts) {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    results.push(new Float32Array(output.data));
  }
  return results;
}

/**
 * Check if the model is loaded and ready.
 */
export function isModelLoaded() {
  return extractor !== null;
}
