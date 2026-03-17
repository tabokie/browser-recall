/**
 * Semantic engine unit tests.
 *
 * Tests actual embedding generation with the MiniLM-L6-v2 model.
 * First run downloads the model (~22.8MB, cached after).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  initModel,
  generateEmbedding,
  generateEmbeddingBatch,
  isModelLoaded,
} from '../extension/semantic-engine.js';
import { cosineSimilarity } from '../extension/rule-engine.js';

// Model download + init can take a while on first run
const MODEL_TIMEOUT = 120_000;

describe('semantic-engine', () => {
  beforeAll(async () => {
    await initModel();
  }, MODEL_TIMEOUT);

  it('isModelLoaded returns true after init', () => {
    expect(isModelLoaded()).toBe(true);
  });

  it('generateEmbedding returns 384-dim Float32Array', async () => {
    const embedding = await generateEmbedding('hello world');
    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding.length).toBe(384);
  }, MODEL_TIMEOUT);

  it('embedding is normalized (magnitude ≈ 1)', async () => {
    const embedding = await generateEmbedding('test sentence');
    let mag = 0;
    for (let i = 0; i < embedding.length; i++) mag += embedding[i] * embedding[i];
    expect(Math.sqrt(mag)).toBeCloseTo(1.0, 1);
  }, MODEL_TIMEOUT);

  it('similar texts have high cosine similarity', async () => {
    const a = await generateEmbedding('machine learning algorithms');
    const b = await generateEmbedding('deep learning neural networks');
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.5);
  }, MODEL_TIMEOUT);

  it('dissimilar texts have low cosine similarity', async () => {
    const a = await generateEmbedding('machine learning algorithms');
    const b = await generateEmbedding('chocolate cake recipe');
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThan(0.3);
  }, MODEL_TIMEOUT);

  it('identical texts have similarity ≈ 1', async () => {
    const a = await generateEmbedding('the quick brown fox');
    const b = await generateEmbedding('the quick brown fox');
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(1.0, 4);
  }, MODEL_TIMEOUT);

  it('generateEmbeddingBatch returns correct count', async () => {
    const texts = ['hello', 'world', 'test'];
    const embeddings = await generateEmbeddingBatch(texts);
    expect(embeddings).toHaveLength(3);
    for (const e of embeddings) {
      expect(e).toBeInstanceOf(Float32Array);
      expect(e.length).toBe(384);
    }
  }, MODEL_TIMEOUT);

  it('batch embeddings match individual embeddings', async () => {
    const texts = ['apple pie', 'banana split'];
    const batch = await generateEmbeddingBatch(texts);
    const individual0 = await generateEmbedding(texts[0]);
    const individual1 = await generateEmbedding(texts[1]);
    expect(cosineSimilarity(batch[0], individual0)).toBeCloseTo(1.0, 4);
    expect(cosineSimilarity(batch[1], individual1)).toBeCloseTo(1.0, 4);
  }, MODEL_TIMEOUT);

  it('initModel is idempotent — second call is instant', async () => {
    const t0 = performance.now();
    await initModel();
    const elapsed = performance.now() - t0;
    // Second init should return immediately (model already loaded)
    expect(elapsed).toBeLessThan(100);
  });
});
