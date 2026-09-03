#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function usage() {
  console.log('Usage: node scripts/preflight.mjs --root <repository> [--json]');
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  usage();
  process.exit(0);
}

const rootArgument = valueAfter(args, '--root');
if (!rootArgument) {
  usage();
  process.exit(2);
}

const root = path.resolve(rootArgument);
const databasePath = path.join(root, '.umbra', 'memory.db');
const stampPath = path.join(root, '.umbra', 'index.identity.json');
if (!fs.existsSync(databasePath)) {
  console.error(`Preflight blocked: no Umbra index database at ${databasePath}.`);
  process.exit(2);
}

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  console.error('Preflight blocked: better-sqlite3 is unavailable from this repository.');
  process.exit(2);
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
let coverage;
try {
  coverage = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(vector_vertex_json, vector_json) IS NOT NULL THEN 1 ELSE 0 END) AS vertex,
      SUM(CASE WHEN vector_ollama_json IS NOT NULL THEN 1 ELSE 0 END) AS ollama,
      SUM(CASE WHEN COALESCE(vector_vertex_json, vector_json) IS NOT NULL AND vector_ollama_json IS NOT NULL THEN 1 ELSE 0 END) AS both
    FROM code_chunks
  `).get();
} catch (error) {
  database.close();
  console.error(`Preflight blocked: cannot inspect provider vector columns: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
database.close();

let stamp;
try {
  stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
} catch {
  stamp = null;
}

const ready = coverage.total > 0 && coverage.vertex === coverage.total && coverage.ollama === coverage.total && coverage.both === coverage.total;
const result = { root, coverage, stamp, ready };
if (args.includes('--json')) {
  console.log(JSON.stringify(result));
} else {
  console.log(`Embedding preflight: total=${coverage.total}; vertex=${coverage.vertex}; ollama=${coverage.ollama}; both=${coverage.both}.`);
  console.log(`Latest stamp: ${stamp?.provider ?? 'unavailable'}/${stamp?.model ?? 'unavailable'} (${stamp?.status ?? 'unavailable'}).`);
  console.log(ready ? 'READY: both providers cover every indexed chunk. No provider calls or writes were made.' : 'BLOCKED: provider coverage is unequal or empty. Do not run a comparison.');
}
process.exit(ready ? 0 : 3);
