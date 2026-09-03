#!/usr/bin/env node
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.log('Usage: node scripts/run-benchmark.mjs --root <repository> --corpus <file> --providers vertex,ollama --no-index');
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
const rootArg = valueAfter(args, '--root');
const corpusArg = valueAfter(args, '--corpus');
const providersArg = valueAfter(args, '--providers');
if (!rootArg || !corpusArg || !providersArg || !args.includes('--no-index')) {
  usage();
  process.exit(2);
}
const root = path.resolve(rootArg);
const corpusPath = path.resolve(corpusArg);
const cliPath = path.join(root, 'dist', 'bin', 'cli.js');
if (!fs.existsSync(corpusPath)) {
  console.error(`Benchmark blocked: corpus file does not exist: ${corpusPath}.`);
  process.exit(2);
}
if (!fs.existsSync(cliPath)) {
  console.error(`Benchmark blocked: compiled Umbra CLI does not exist: ${cliPath}. Run the project's build first.`);
  process.exit(2);
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
if (!Array.isArray(corpus.queries) || corpus.queries.length === 0) throw new Error('Corpus must contain a non-empty queries array.');
const providers = providersArg.split(',').map((value) => value.trim()).filter(Boolean);
if (providers.some((provider) => provider !== 'vertex' && provider !== 'ollama')) throw new Error('Providers must be vertex and/or ollama.');

function extractPaths(text) {
  return [...text.matchAll(/\*\*FILE:\*\*\s*([^\r\n]+)/g)].map((match) => match[1].trim().replaceAll('\\', '/'));
}

function score(paths, expectedPaths) {
  if (expectedPaths.length === 0) return { hit: paths.length === 0 ? 1 : 0, reciprocalRank: paths.length === 0 ? 1 : 0 };
  const index = paths.findIndex((candidate) => expectedPaths.some((expected) => candidate.endsWith(expected)));
  return { hit: index === -1 ? 0 : 1, reciprocalRank: index === -1 ? 0 : 1 / (index + 1) };
}

function provesActiveProvider(text, provider) {
  return text.includes(`[embeddings: ${provider}/`) || text.includes(`queried with ${provider}/`);
}

function startServer(provider) {
  const child = childProcess.spawn(process.execPath, ['dist/bin/cli.js', 'mcp', '--root', root, '--embeddings', provider, '--no-index'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    child.once('error', reject);
  });
  return { child, call };
}

async function runProvider(provider) {
  const server = startServer(provider);
  try {
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await server.call('tools/list', {});
    const tools = listed.result?.tools ?? [];
    if (!tools.some((tool) => tool.name === 'ask_codebase')) throw new Error(`${provider}: ask_codebase was not published.`);
    const runs = [];
    for (const item of corpus.queries) {
      const startedAt = performance.now();
      const response = await server.call('tools/call', { name: 'ask_codebase', arguments: { query: item.query } });
      const elapsedMs = performance.now() - startedAt;
      const result = response.result;
      const text = result?.content?.map((content) => content.text).join('\n') ?? '';
      if (result?.isError === true) throw new Error(`${provider}: ask_codebase returned an error for corpus id ${item.id}.`);
      if (!provesActiveProvider(text, provider)) throw new Error(`${provider}: response does not prove the selected active provider for corpus id ${item.id}.`);
      const metrics = score(extractPaths(text), item.expectedPaths);
      runs.push({ id: item.id, ...metrics, elapsedMs });
    }
    const ordered = runs.map((run) => run.elapsedMs).sort((a, b) => a - b);
    return {
      provider,
      queries: runs.length,
      hitAt4: runs.reduce((sum, run) => sum + run.hit, 0) / runs.length,
      mrr: runs.reduce((sum, run) => sum + run.reciprocalRank, 0) / runs.length,
      medianLatencyMs: ordered[Math.floor((ordered.length - 1) / 2)],
      p95LatencyMs: ordered[Math.ceil(ordered.length * 0.95) - 1],
    };
  } finally {
    server.child.stdin.end();
    server.child.kill();
  }
}

const report = { corpusVersion: corpus.version, root, providers: [] };
for (const provider of providers) report.providers.push(await runProvider(provider));
console.log(JSON.stringify(report, null, 2));
