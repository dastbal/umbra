import {
  decodeVector,
  encodeLegacyJsonVector,
  encodeVector,
  vectorDimensions,
} from './vector-codec';
import { cosineSimilarity } from './math';

describe('vector codec', () => {
  it('round-trips a vector through the stored form', () => {
    const original = [0.1, -0.5, 0.25, 1];
    const decoded = decodeVector(encodeVector(original));

    expect(decoded).toHaveLength(4);
    // float32, so equality is approximate by construction.
    original.forEach((value, i) => expect(decoded[i]).toBeCloseTo(value, 6));
  });

  it('stores 4 bytes per component, several times smaller than the JSON text', () => {
    // Full-precision components, the way an embedding model actually returns
    // them. A synthetic vector of round numbers would understate the JSON size
    // and make this assertion meaningless.
    const realistic = Array.from({ length: 768 }, (_, i) =>
      Math.sin(i) * 0.0413871234567,
    );

    const blob = encodeVector(realistic);
    const asJsonText = JSON.stringify(realistic).length;

    expect(blob.byteLength).toBe(768 * 4);
    // Measured on this repository's real index: 16,208 bytes of JSON against
    // 3,072 as a BLOB, a 5.3x reduction (ADR-026).
    expect(asJsonText / blob.byteLength).toBeGreaterThan(4);
  });

  it('reports dimensions without decoding', () => {
    expect(vectorDimensions(encodeVector([1, 2, 3]))).toBe(3);
  });

  it('reads the right vector when Node pools buffers', () => {
    // Node allocates small Buffers inside one shared ArrayBuffer, so a decoder
    // that ignores `byteOffset` reads a neighbouring vector's memory. Silent,
    // and wrong in a way that looks like a bad embedding rather than a bug.
    const first = encodeVector([1, 1, 1, 1]);
    const second = encodeVector([9, 9, 9, 9]);

    const decodedFirst = decodeVector(first);
    const decodedSecond = decodeVector(second);

    expect(Array.from(decodedFirst)).toEqual([1, 1, 1, 1]);
    expect(Array.from(decodedSecond)).toEqual([9, 9, 9, 9]);
  });

  it('scores a decoded vector without copying it into a plain array', () => {
    const a = decodeVector(encodeVector([1, 0, 0]));
    const b = decodeVector(encodeVector([1, 0, 0]));

    // `cosineSimilarity` takes ArrayLike precisely so this needs no Array.from.
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  describe('refusals', () => {
    it('refuses to store an empty vector', () => {
      // A zero-length row compares against nothing and would read as valid.
      expect(() => encodeVector([])).toThrow(/empty/i);
    });

    it('refuses to decode a buffer that is not whole float32 components', () => {
      expect(() => decodeVector(Buffer.alloc(7))).toThrow(/float32/);
    });

    it('refuses to decode an empty buffer', () => {
      expect(() => decodeVector(Buffer.alloc(0))).toThrow();
    });
  });

  describe('legacy JSON migration', () => {
    it('converts a stored JSON array', () => {
      const blob = encodeLegacyJsonVector('[0.5,-0.25,1]');

      expect(blob).toBeDefined();
      expect(vectorDimensions(blob!)).toBe(3);
    });

    it('skips values that are not usable vectors instead of coercing them', () => {
      // A corrupt legacy row must be skipped and counted, never migrated into a
      // shape that reads as valid — that is ADR-017's third failure.
      expect(encodeLegacyJsonVector('not json')).toBeUndefined();
      expect(encodeLegacyJsonVector('[]')).toBeUndefined();
      expect(encodeLegacyJsonVector('{"a":1}')).toBeUndefined();
      expect(encodeLegacyJsonVector('[1,"two",3]')).toBeUndefined();
      expect(encodeLegacyJsonVector('[1,null,3]')).toBeUndefined();
      expect(encodeLegacyJsonVector('[1,2,NaN]')).toBeUndefined();
    });
  });
});
