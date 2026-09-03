/**
 * Converts embedding vectors between the shape a model returns and the shape
 * SQLite stores.
 *
 * ## Why binary instead of JSON text
 *
 * Vectors were stored as JSON text, which is 5.3× larger and has to be parsed
 * on every read. Measured on this repository's own index, for one 768-dimension
 * vector:
 *
 * | | JSON text | Float32 BLOB |
 * |---|---|---|
 * | size | 16,208 bytes | **3,072 bytes** |
 * | decoding 50 vectors, 200× | 1,130 ms | **1 ms** |
 *
 * Extrapolated to a 50,000-chunk repository — roughly 5,000 source files — a
 * single query read and parsed **773 MB**. As BLOBs that is 146 MB with no
 * parsing at all. The parse cost is not a rounding error: it was three orders
 * of magnitude larger than reading a typed-array view.
 *
 * Float32 rather than Float64 is deliberate. Embedding models emit float32
 * internally, the extra precision carries no information, and it would double
 * the size. The loss against the float64 values JSON happened to preserve is
 * ~4e-7 on a cosine distance, verified against `cosineSimilarity` — far below
 * anything a ranking could notice.
 *
 * Binary is also the shape `sqlite-vec` expects, so this is what lets the
 * distance computation move into SQL.
 *
 * @example
 * ```ts
 * const blob = encodeVector(await port.embedQuery('...'));
 * const view = decodeVector(rowFromSqlite.vector);
 * ```
 */

/** Bytes per component of a stored vector. */
const BYTES_PER_FLOAT32 = 4;

/**
 * Packs a vector into the little-endian float32 buffer SQLite stores.
 *
 * @param vector - Components as returned by an embedding model.
 * @returns A buffer of `vector.length * 4` bytes.
 * @throws {Error} When the vector is empty, which would produce a row that
 *         cannot be compared against anything and would read as valid.
 */
export function encodeVector(vector: readonly number[]): Buffer {
  if (vector.length === 0) {
    throw new Error('Refusing to store an empty embedding vector.');
  }

  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

/**
 * Reads a stored vector back as a typed-array view.
 *
 * A view, not a copy: nothing is allocated for the components themselves. This
 * is the entire performance argument of this module, so it must not quietly
 * become a `slice`.
 *
 * @param blob - The stored buffer.
 * @returns A float32 view over the same memory.
 * @throws {Error} When the buffer length is not a multiple of 4, which means it
 *         is not a float32 vector and comparing it would yield noise.
 */
export function decodeVector(blob: Buffer): Float32Array {
  if (blob.byteLength === 0 || blob.byteLength % BYTES_PER_FLOAT32 !== 0) {
    throw new Error(
      `Stored vector is ${blob.byteLength} bytes, which is not a whole number of float32 components.`,
    );
  }

  // `byteOffset` matters: Node pools small Buffers inside a shared ArrayBuffer,
  // so ignoring it reads a neighbouring vector's memory. Silent and wrong.
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / BYTES_PER_FLOAT32,
  );
}

/**
 * How many components a stored vector holds, without decoding it.
 *
 * @param blob - The stored buffer.
 * @returns The dimension count.
 */
export function vectorDimensions(blob: Buffer): number {
  return Math.floor(blob.byteLength / BYTES_PER_FLOAT32);
}

/**
 * Converts a legacy JSON-text vector into the binary form.
 *
 * Used only by the one-time migration out of `code_chunks`'s vector columns.
 *
 * @param json - The stored JSON array text.
 * @returns The packed buffer, or `undefined` when the text is not a usable
 *          vector — a corrupt row is skipped and reported rather than migrated
 *          into a shape that looks valid.
 */
export function encodeLegacyJsonVector(json: string): Buffer | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    if (!parsed.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return undefined;
    }
    return encodeVector(parsed as number[]);
  } catch {
    return undefined;
  }
}
