import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentDB } from '../state/db';
import { pinRuntimeRoot, resetRuntimeRoot } from '../config/runtime-root';
import { RetrieverService } from './retriever';
import { scoreCase, summarizeSplit, type RetrievalCorpusCase } from './retrieval-metrics';
import { normalizeRetrievalTerms } from './retrieval-memory';
import type { EmbeddingsPort } from './embeddings';

/**
 * The retrieval quality gate: ranking, rank fusion and abstention, scored in
 * CI with no provider, no network and no credentials.
 *
 * ## Why this exists as a spec rather than as a benchmark run
 *
 * `bench-retrieval` launches the compiled MCP binary, which resolves a live
 * embedding provider at startup — so it cannot run in GitHub Actions, and every
 * quality number this project has ever produced is a local, manual observation.
 * A regression reaches `main` unnoticed until somebody remembers to measure.
 *
 * ADR-028 holds that the compiled binary is the integration boundary, and that
 * remains true for what it was written about: launch pinning, the published
 * tool schema, and the read-only contract cannot be proved by an in-process
 * test. A *quality* gate needs none of those. It needs ranking, fusion and the
 * abstention policy, all of which live below the transport — so this runs them
 * directly and leaves the binary check to the live benchmark.
 *
 * ## What it cannot see
 *
 * The vectors are frozen, so the embedding model is invisible here: swapping
 * `nomic-embed-text` for something better would not move a single number. That
 * comparison is the live paired benchmark's job. This guards the code between
 * the vectors and the answer.
 *
 * ## Its numbers are not the live numbers, and must not be quoted as them
 *
 * The fixture holds 158 chunks against the repository's ~1,000. The
 * unknown-term abstention rule asks whether a query's terms appear *anywhere in
 * the index*, so a smaller index makes more terms unknown and the rule
 * correspondingly stricter: false abstention is 0.133 here against 0.022 on the
 * full corpus. Both are correct measurements of different things.
 *
 * This is a regression detector against its own baseline. The live benchmark
 * remains the measurement of production quality.
 *
 * ## Floors, not targets
 *
 * The thresholds below sit under the measured values with room for the
 * ordinary jitter of a tie-break, and they are floors: their purpose is to fail
 * when something breaks, not to certify that retrieval is good. Raising one
 * because today's run was lucky is how a gate becomes noise.
 */

interface Fixture {
  readonly version: number;
  readonly corpusVersion: number;
  readonly dimensions: number;
  readonly cases: RetrievalCorpusCase[];
  readonly chunks: {
    readonly id: string;
    readonly filePath: string;
    readonly chunkType: string;
    readonly content: string;
    readonly metadata: string | null;
    readonly vector: number;
  }[];
  readonly queries: { readonly id: string; readonly vector: number }[];
}

/**
 * Floor for mean reciprocal rank on the fixture. Measured 0.656 on 2026-09-10.
 *
 * It exists because Hit@4 is blind to the right file sliding from rank one to
 * rank four: a change can hold every other assertion here and still make every
 * answer worse to read.
 *
 * **It is not a guard against a BM25 re-weighting**, and the attempt to make it
 * one is what established the limit recorded below. A weight vector that cost
 * the live corpus 0.070 of MRR gained 0.011 here, so this fixture called a
 * measured regression a small improvement. Ranking changes belong to
 * `npm run bench:fts-only`.
 */
const MRR_FLOOR = 0.55;

const fixtureDir = path.resolve(__dirname, '..', '..', '..', 'docs/benchmarks/fixture');
const fixture: Fixture = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, 'retrieval-fixture.json'), 'utf8'),
);
const vectorBytes = fs.readFileSync(path.join(fixtureDir, 'retrieval-fixture.vectors.bin'));

/** Reads one frozen vector out of the packed binary by index. */
function vectorAt(index: number): number[] {
  const componentBytes = fixture.dimensions * 4;
  const start = index * componentBytes;
  const view = new Float32Array(
    vectorBytes.buffer.slice(
      vectorBytes.byteOffset + start,
      vectorBytes.byteOffset + start + componentBytes,
    ),
  );
  return [...view];
}

/**
 * The fixture's own identity.
 *
 * `provider: 'fixture'` is not a cosmetic label. `chunk_vectors` is keyed by
 * `(chunk_id, provider, model)`, so the fixture's vectors physically cannot be
 * ranked against a real provider's rows, and a real query vector cannot reach
 * them — the property ADR-026 built the key for, doing exactly its job for a
 * case it was not written for.
 */
const FIXTURE_IDENTITY = {
  provider: 'fixture' as never,
  model: 'fixture-v1',
  dimensions: fixture.dimensions,
  column: 'vector_ollama_json' as never,
};

describe('retrieval quality gate', () => {
  let rootDir: string;
  let retriever: RetrieverService;

  beforeAll(() => {
    resetRuntimeRoot();
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-gate-'));
    pinRuntimeRoot(rootDir);
    AgentDB.close();

    const db = AgentDB.getInstance();
    const insertChunk = db.prepare(
      'INSERT INTO code_chunks (id, file_path, chunk_type, content, metadata) VALUES (?, ?, ?, ?, ?)',
    );
    const insertVector = db.prepare(
      'INSERT INTO chunk_vectors (chunk_id, provider, model, dimensions, vector) VALUES (?, ?, ?, ?, ?)',
    );

    // `code_chunks` carries a foreign key onto `file_registry`, which is what
    // makes a chunk disappear with its file. The fixture has to satisfy it.
    const insertFile = db.prepare(
      'INSERT OR IGNORE INTO file_registry (path, hash, last_indexed, index_state) VALUES (?, ?, ?, ?)',
    );

    db.transaction(() => {
      for (const filePath of new Set(fixture.chunks.map((chunk) => chunk.filePath))) {
        insertFile.run(filePath, 'fixture', 0, 'indexed');
      }
      for (const chunk of fixture.chunks) {
        insertChunk.run(chunk.id, chunk.filePath, chunk.chunkType, chunk.content, chunk.metadata);
        insertVector.run(
          chunk.id,
          FIXTURE_IDENTITY.provider,
          FIXTURE_IDENTITY.model,
          fixture.dimensions,
          Buffer.from(new Float32Array(vectorAt(chunk.vector)).buffer),
        );
      }
    })();

    // Keyed by the **expanded** query, because that is the string
    // `RetrieverService` actually embeds: it runs the request through retrieval
    // memory first. Keying by the raw text scored a string production never
    // sends, which is how this was found. The builder freezes the same form,
    // through the same function, so the two cannot drift.
    const byQuery = new Map(
      fixture.cases.map((item) => {
        const entry = fixture.queries.find((query) => query.id === item.id);
        return [
          [...normalizeRetrievalTerms(item.query)].join(' '),
          entry === undefined ? undefined : vectorAt(entry.vector),
        ];
      }),
    );

    const port: EmbeddingsPort = {
      identity: FIXTURE_IDENTITY,
      // Throws rather than returning zeros for an unknown string. A silent
      // fallback would score a query nobody embedded and report the result as
      // retrieval quality.
      embedQuery: async (text: string) => {
        const known = byQuery.get(text);
        if (known === undefined) {
          throw new Error(`The fixture holds no vector for: ${text}`);
        }
        return known;
      },
      embedDocuments: async () => {
        throw new Error('The gate never indexes; it scores a frozen index.');
      },
    };

    retriever = new RetrieverService(port);
  });

  afterAll(() => {
    AgentDB.close();
    resetRuntimeRoot();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('is built from the corpus this repository ships', () => {
    expect(fixture.corpusVersion).toBe(5);
    expect(fixture.cases.filter((item) => item.expectedPaths.length === 0)).toHaveLength(10);
  });

  it('holds ranking and abstention at their measured floors', async () => {
    const outcomes = [];
    for (const item of fixture.cases) {
      const started = Date.now();
      const report = await retriever.getContextForLLM(item.query);
      const paths = [...report.matchAll(/\*\*FILE:\*\*\s*([^\r\n]+)/g)].map((match) =>
        match[1].trim().replaceAll('\\', '/'),
      );
      outcomes.push(scoreCase(item, paths, Date.now() - started));
    }

    const summary = summarizeSplit('gate', outcomes);

    // Printed on every run, passing or failing. A gate that only speaks when it
    // breaks leaves nobody able to see a number drifting towards its floor.
    process.stdout.write(
      `\nretrieval gate — hit ${summary.hitRate?.toFixed(3)} · ` +
        `mrr ${summary.mrr?.toFixed(3)} · ` +
        `false abstention ${summary.falseAbstentionRate?.toFixed(3)} · ` +
        `correct abstention ${summary.correctAbstentionRate?.toFixed(3)} · ` +
        `${summary.positives}+${summary.negatives} cases\n`,
    );

    // Measured 2026-09-09 at 0e06612: hit 0.867, false abstention 0.133,
    // correct abstention 1.0. Floors sit below with room for a tie-break.
    // Re-measured 2026-09-23 after the y/i probe (ADR-028): false abstention
    // 0.067, MRR 0.733. The floors are unchanged on purpose.
    expect(summary.hitRate).toBeGreaterThanOrEqual(0.75);
    expect(summary.falseAbstentionRate).toBeLessThanOrEqual(0.2);

    // MRR has its own floor because Hit@4 cannot see a ranking regression that
    // keeps the right file inside the window and pushes it down. What it does
    // *not* cover is documented on the constant: this fixture scored a measured
    // live regression as an improvement, so a green run here is not evidence
    // about ranking.
    expect(summary.mrr).toBeGreaterThanOrEqual(MRR_FLOOR);

    // No floor: the policy either abstains on a feature this repository does
    // not have or it does not, and 9 of 10 would mean it regressed.
    expect(summary.correctAbstentionRate).toBe(1);
  }, 60_000);
});
