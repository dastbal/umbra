#!/usr/bin/env node
/** Fixed lexical cases that compare the 2.4.1 overlay-first rule with the current rule. */
import { createRequire } from 'module';
import * as fs from 'fs';
import { performance } from 'perf_hooks';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { findLexicalCandidates, toLexicalMatchExpression } = require('../dist/core/rag/lexical-index.js');
const outputAt = process.argv.indexOf('--output');
const output = outputAt < 0 ? '' : process.argv[outputAt + 1];
const cases = [
  {
    name: 'weak worktree mention, strong base implementation', query: 'payment', expected: 'base-payment',
    overlay: [['overlay-footer', 'src/footer.ts', 'payment']],
    base: [['base-payment', 'src/payments/invoice-payment-retry.service.ts', 'retry payment after payment failure; record payment attempt']],
  },
  {
    name: 'strong worktree implementation, weak base mention', query: 'payment', expected: 'overlay-payment',
    overlay: [['overlay-payment', 'src/payments/payment-retry.service.ts', 'retry payment after payment failure']],
    base: [['base-footer', 'src/footer.ts', 'payment']],
  },
  {
    name: 'base covers both query terms', query: 'payment retry', expected: 'base-retry',
    overlay: [['overlay-mention', 'src/payment-note.ts', 'payment']],
    base: [['base-retry', 'src/billing/retry.service.ts', 'retry payment after a failed payment']],
  },
  {
    name: 'worktree path names the subject', query: 'payment', expected: 'overlay-path',
    overlay: [['overlay-path', 'src/payment.ts', 'return true']],
    base: [['base-mention', 'src/footer.ts', 'payment payment payment payment']],
  },
  {
    name: 'hidden base path is excluded', query: 'payment', expected: 'overlay-visible',
    overlay: [['overlay-visible', 'src/footer.ts', 'payment']],
    base: [['base-hidden', 'src/payments/payment-retry.service.ts', 'payment payment retry']],
    hidden: ['src/payments/payment-retry.service.ts'],
  },
];

const results = cases.map((item) => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      ATTACH DATABASE ':memory:' AS base;
      CREATE VIRTUAL TABLE main.code_chunks_fts USING fts5(chunk_id UNINDEXED, file_path, metadata, content);
      CREATE VIRTUAL TABLE base.code_chunks_fts USING fts5(chunk_id UNINDEXED, file_path, metadata, content);
      CREATE TABLE main.hidden_paths (path TEXT PRIMARY KEY);
    `);
    const insert = (schema, rows) => {
      const statement = db.prepare(`INSERT INTO ${schema}.code_chunks_fts VALUES (?, ?, '', ?)`);
      for (const row of rows) statement.run(...row);
    };
    insert('main', item.overlay);
    insert('base', item.base);
    for (const hidden of item.hidden ?? []) db.prepare('INSERT INTO main.hidden_paths VALUES (?)').run(hidden);
    const expression = toLexicalMatchExpression(item.query);
    const oldSearch = (schema) => db.prepare(`
      SELECT chunk_id AS id FROM ${schema}.code_chunks_fts
      WHERE code_chunks_fts MATCH ?
      ${schema === 'base' ? 'AND file_path NOT IN (SELECT path FROM main.hidden_paths)' : ''}
      ORDER BY bm25(code_chunks_fts, 0.0, 5.0, 1.0, 1.0) LIMIT 12
    `).all(expression).map((row) => row.id);
    const previous = [...oldSearch('main'), ...oldSearch('base')];
    const started = performance.now();
    const current = findLexicalCandidates(db, item.query, 12).map((candidate) => candidate.chunkId);
    const currentMs = performance.now() - started;
    return { name: item.name, expected: item.expected, previousTop: previous[0], currentTop: current[0],
      currentMs: Number(currentMs.toFixed(3)), pass: current[0] === item.expected };
  } finally { db.close(); }
});
const report = {
  cases: results.length,
  previousHitAt1: results.filter((result) => result.previousTop === result.expected).length,
  currentHitAt1: results.filter((result) => result.pass).length,
  results,
  scope: 'Five synthetic, labelled FTS cases; this does not establish live repository relevance or MCP latency.',
};
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.currentHitAt1 !== report.cases) process.exitCode = 1;
