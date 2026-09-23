#!/usr/bin/env node
/**
 * The per-turn floor: what one request costs before the user says anything.
 *
 * Every turn sends the system prompt and the whole tool catalog again. That is
 * the floor under every conversation, and it had never been measured where it
 * matters — at the provider boundary. `recordSessionOverhead` records it at
 * construction, before deepagents concatenates its own prompt blocks and adds
 * `write_todos`, and a hook in `wrapModelCall` sees the tool list before
 * deepagents' exclusion middleware filters it. Neither is what leaves the
 * process.
 *
 * This builds the REAL agent through `DeepAgentFactory.create` — real system
 * prompt, real tools, real harness-profile registration, the real provider
 * model class — and replaces only that model's `_generate`. What the
 * replacement records is, by construction, what would have been sent.
 *
 * ## Why the real model class, and not a fake
 *
 * deepagents resolves a model instance to a harness profile by its class name
 * (`getModelProvider`). A fake model would resolve to a different profile and
 * this would measure a different catalog from the one the agent actually sends.
 * The class is an input to the measurement, so it cannot be substituted.
 *
 * ## What it reports
 *
 * `measured` is the floor at the boundary. `believed` is what
 * `sessionOverhead()` holds — the number `ContextCompressor` decides with — and
 * `unseen` is the difference: cost the budget guard cannot see. On 2026-09-23
 * that difference was 54% of the floor. A number that large under a guard is
 * the guard measuring something other than what it guards.
 *
 * ## Two arms, so the saving can be re-derived rather than remembered
 *
 * `compact` - the shipped agent: `write_todos` shows the model
 *             `COMPACT_WRITE_TODOS_DESCRIPTION`.
 * `library` - the control. The same agent, the same middleware stack, with that
 *             description set to the one the installed `todoListMiddleware`
 *             ships. Only the text differs, so the difference between the arms
 *             is the compaction and nothing else — on this commit, this
 *             provider and this library version, not on the day it was written.
 *
 * No network call is made and no credential is needed. Index sync is skipped:
 * it has no bearing on the floor and would touch the embedding provider.
 *
 * Usage:
 *   node scripts/bench-turn-floor.mjs
 *   node scripts/bench-turn-floor.mjs --arm library
 *   node scripts/bench-turn-floor.mjs --model gemini-2.5-pro --output report.json
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/bench-turn-floor.mjs [--arm compact|library] [--model <id>] [--output <file>]');
  process.exit(0);
}

const model = valueAfter(args, '--model') ?? 'gemini-2.5-flash-lite';
const arm = valueAfter(args, '--arm') ?? 'compact';
if (!['compact', 'library'].includes(arm)) {
  console.error('Benchmark blocked: unknown arm ' + arm + '. Use compact or library.');
  process.exit(2);
}

for (const [label, target] of [
  ['compiled agent factory', path.join(repoRoot, 'dist/core/agent/deep-agent-factory.js')],
  ['compiled token counter', path.join(repoRoot, 'dist/core/llm/tokens/token-counter.js')],
]) {
  if (!fs.existsSync(target)) {
    console.error('Benchmark blocked: ' + label + ' does not exist: ' + target + '. Run `npm run build` first.');
    process.exit(2);
  }
}

const compiled = (relative) => import(pathToFileURL(path.join(repoRoot, 'dist', relative)).href);
const { LLMProvider } = await compiled('core/llm/provider.js');
const { DeepAgentFactory } = await compiled('core/agent/deep-agent-factory.js');
const { tokenCounter } = await compiled('core/llm/tokens/token-counter.js');
const { sessionOverhead } = await compiled('core/agent/session-overhead.js');
const { AIMessage } = await import('@langchain/core/messages');

// A project id is resolved at model construction for the Vertex routes; no call
// is ever made with it.
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'bench-turn-floor';

// Irrelevant to the floor, and it would reach the embedding provider.
DeepAgentFactory.maybeReindex = async () => undefined;

// The control arm. The middleware reads this export at call time, and the
// factory resolves the middleware at call time, so setting it here changes the
// description the model sees and nothing else. The text is read from the
// installed library, not copied, so the control tracks the library.
if (arm === 'library') {
  const require = createRequire(import.meta.url);
  const compact = require(path.join(repoRoot, 'dist/core/agent/compact-todo-tool.middleware.js'));
  const { todoListMiddleware } = require('langchain');
  compact.COMPACT_WRITE_TODOS_DESCRIPTION = todoListMiddleware().tools[0].description;
}

const captured = [];
const realCreate = LLMProvider.createChatModel.bind(LLMProvider);
LLMProvider.createChatModel = (...createArgs) => {
  const instance = realCreate(...createArgs);
  instance._generate = async (messages, options) => {
    captured.push({ messages, tools: options?.tools ?? [] });
    return { generations: [{ text: 'ok', message: new AIMessage('ok') }] };
  };
  return instance;
};

const threadId = 'bench-turn-floor-' + process.pid;
const agent = await DeepAgentFactory.create({ model, threadId, rootDir: repoRoot });
try {
  await agent.invoke(
    { messages: [{ role: 'user', content: 'What does the retrieval module do?' }] },
    { configurable: { thread_id: threadId }, recursionLimit: 5 },
  );
} catch (error) {
  // Only the first request is the floor. A loop after it is not this script's
  // question, but no request at all is.
  if (captured.length === 0) {
    console.error('Benchmark blocked: the model was never called. ' + (error?.message ?? error));
    process.exit(1);
  }
}

const first = captured[0];
const isSystem = (message) => (message._getType?.() ?? message.getType?.()) === 'system';
const system = first.messages
  .filter(isSystem)
  .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
  .join('\n');

const counter = tokenCounter();
// Gemini receives tools already converted to `functionDeclarations`; other
// providers receive them flat. Both shapes are what the wire carries.
const declarations = first.tools.flatMap((entry) => entry.functionDeclarations ?? [entry]);
const tools = declarations
  .map((declaration) => ({
    name: declaration.name ?? declaration.function?.name,
    tokens: counter.countText(JSON.stringify(declaration)),
  }))
  .sort((left, right) => right.tokens - left.tokens);

const systemTokens = counter.countText(system);
const toolTokens = tools.reduce((sum, entry) => sum + entry.tokens, 0);
const measured = systemTokens + toolTokens;

const believedOverhead = sessionOverhead();
const believedCount = counter.countRequest({
  system: believedOverhead.system,
  tools: believedOverhead.tools,
  messages: [],
});
const believed = believedCount.system + believedCount.toolSchemas;

/**
 * Records which code state produced these numbers.
 *
 * The same rule as the other benchmarks: a number whose commit cannot be
 * recovered is an anecdote with a schema, and a dirty tree is recorded rather
 * than refused, so a mid-change run is never mistaken for its commit.
 *
 * Dirtiness ignores the results directory. Running the two arms back to back
 * otherwise stamps the second one dirty because of the report the first one
 * wrote — a stamp counting its own output as a code change, which says the code
 * differed when it did not. Any change outside that directory still counts.
 *
 * @returns Short SHA and whether the tree had uncommitted changes.
 */
function codeVersion() {
  const run = (command) =>
    childProcess
      .execSync(command, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim();
  try {
    return {
      commit: run('git rev-parse --short HEAD'),
      dirty: run('git status --porcelain -- . ":(exclude)docs/benchmarks/results"').length > 0,
    };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

const code = codeVersion();
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit: code.commit,
  dirtyWorkingTree: code.dirty,
  model,
  arm,
  counter: counter.identity,
  measured: { system: systemTokens, tools: toolTokens, total: measured, systemChars: system.length },
  believed: { system: believedCount.system, tools: believedCount.toolSchemas, total: believed },
  unseen: { tokens: measured - believed, shareOfFloor: measured === 0 ? 0 : (measured - believed) / measured },
  tools,
};

const stamp = code.commit + (code.dirty ? '-dirty' : '');
const defaultOutput = path.join(
  repoRoot,
  'docs/benchmarks/results',
  new Date().toISOString().slice(0, 10) + '-turn-floor-' + model + '-' + arm + '-' + stamp + '.json',
);
const outputPath = path.resolve(valueAfter(args, '--output') ?? defaultOutput);
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');

const pct = (share) => (share * 100).toFixed(1) + '%';
console.log('turn floor - ' + model + ', arm ' + arm + ' (' + counter.identity.encoding + ')');
console.log('  measured at the boundary  ' + measured + ' tokens  (system ' + systemTokens + ' + ' + tools.length + ' tools ' + toolTokens + ')');
console.log('  what the budget guard sees ' + believed + ' tokens');
console.log('  unseen by the guard        ' + (measured - believed) + ' tokens  (' + pct(report.unseen.shareOfFloor) + ' of the floor)');
console.log('  heaviest tools             ' + tools.slice(0, 3).map((entry) => entry.name + ' ' + entry.tokens).join(', '));
console.log('report written to ' + path.relative(repoRoot, outputPath));
