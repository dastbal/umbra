#!/usr/bin/env node
/**
 * Measures real Ollama embedding cost and reuse from a fresh process.
 *
 * Usage: node scripts/bench-embedding-cache.mjs --source-db <memory.db>
 *   [--count 590] [--output <report.json>]
 * Build first. The source database is opened read-only; the temporary cache is
 * deleted after measurement. This measures vector work, not a full MCP call.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { EmbeddingCache, ensureEmbeddingCacheSchema } = require('../dist/core/rag/embedding-cache.js');
const { embeddingInputFor } = require('../dist/core/rag/embedding-input.js');
const { OllamaEmbeddingsAdapter } = require('../dist/core/rag/embeddings/ollama-embeddings.adapter.js');
const scriptPath = fileURLToPath(import.meta.url);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function selectedInputs(sourcePath, count) {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT id, chunk_type, content, metadata FROM code_chunks ORDER BY file_path, id').all();
    const inputs = [...new Set(rows.map((row) => embeddingInputFor({
      id: row.id,
      type: row.chunk_type,
      content: row.content,
      metadata: JSON.parse(row.metadata),
    })))].filter((input) => input.length <= 1_500).slice(0, count);
    if (inputs.length !== count) throw new Error(`Only ${inputs.length} usable unique chunks are available; requested ${count}.`);
    return inputs;
  } finally {
    db.close();
  }
}

if (process.argv[2] === '--reader') {
  const cacheDb = new Database(process.argv[3], { readonly: true, fileMustExist: true });
  try {
    const inputs = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
    const identity = { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768 };
    const cache = new EmbeddingCache(cacheDb);
    const samplesMs = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = process.hrtime.bigint();
      const hits = cache.get(identity, inputs);
      samplesMs.push(elapsedMs(started));
      if (hits.size !== inputs.length) throw new Error(`Warm process found ${hits.size}/${inputs.length} vectors.`);
    }
    process.stdout.write(JSON.stringify({ hits: inputs.length, providerCalls: 0, samplesMs }) + '\n');
  } finally {
    cacheDb.close();
  }
} else {
  const sourcePath = option('--source-db');
  const count = Number(option('--count', '590'));
  const output = option('--output');
  if (!sourcePath || !Number.isInteger(count) || count < 1) {
    throw new Error('Usage: node scripts/bench-embedding-cache.mjs --source-db <memory.db> [--count 590] [--output <report.json>]');
  }
  const inputs = selectedInputs(sourcePath, count);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-cache-bench-'));
  try {
    const cachePath = path.join(temporary, 'cache.db');
    const inputPath = path.join(temporary, 'inputs.json');
    fs.writeFileSync(inputPath, JSON.stringify(inputs));
    const db = new Database(cachePath);
    ensureEmbeddingCacheSchema(db);
    const cache = new EmbeddingCache(db);
    const provider = new OllamaEmbeddingsAdapter();
    const identity = provider.identity;
    let providerMs = 0;
    let providerCalls = 0;
    const coldStart = process.hrtime.bigint();
    try {
      for (let start = 0; start < inputs.length; start += 10) {
        const batch = inputs.slice(start, start + 10);
        const hits = cache.get(identity, batch);
        const missing = batch.filter((input) => !hits.has(input));
        if (missing.length === 0) continue;
        const providerStart = process.hrtime.bigint();
        const vectors = await provider.embedDocuments(missing);
        providerMs += elapsedMs(providerStart);
        providerCalls += missing.length;
        cache.put(identity, missing, vectors);
      }
    } finally {
      db.close();
    }
    const coldMs = elapsedMs(coldStart);
    const reader = JSON.parse(execFileSync(process.execPath, [scriptPath, '--reader', cachePath, inputPath], { encoding: 'utf8' }));
    const ordered = [...reader.samplesMs].sort((a, b) => a - b);
    const report = {
      benchmark: 'embedding-cache-across-processes',
      measuredAt: new Date().toISOString(),
      scope: 'vector generation and cache lookup only; excludes git delta, parsing, overlay transaction and MCP transport',
      source: 'unique code_chunks from an existing read-only Umbra index',
      inputCount: inputs.length,
      inputHash: crypto.createHash('sha256').update(inputs.join('\0')).digest('hex'),
      identity: { provider: identity.provider, model: identity.model, dimensions: identity.dimensions },
      cold: { elapsedMs: coldMs, providerMs, providerCalls },
      freshProcess: { elapsedMsMedian: ordered[2], samplesMs: reader.samplesMs, providerCalls: reader.providerCalls, hits: reader.hits },
      cacheFileBytes: fs.statSync(cachePath).size,
    };
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
