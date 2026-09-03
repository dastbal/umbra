/**
 * Mathematical utilities for Vector Search.
 */

/**
 * Calculates the Cosine Similarity between two vectors.
 * A score of 1.0 means identical direction (perfect match).
 * A score of 0.0 means orthogonal (no relation).
 *
 * Accepts `ArrayLike<number>` rather than `number[]` so a `Float32Array` read
 * straight out of SQLite can be scored without being copied into a plain array
 * first. That copy is exactly the cost ADR-026 removed, and narrowing this
 * signature again would quietly bring it back.
 *
 * @param vecA - The query vector
 * @param vecB - The database vector
 */
export function cosineSimilarity(
  vecA: ArrayLike<number>,
  vecB: ArrayLike<number>,
): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have the same dimensionality');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
