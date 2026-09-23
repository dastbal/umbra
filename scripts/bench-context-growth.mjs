#!/usr/bin/env node
/**
 * How the input of each model call grows across a conversation, and whether it
 * stops growing.
 *
 * `bench-turn-floor.mjs` measures the first request: the fixed cost of a turn.
 * This measures the part that is not fixed. Every tool result a conversation
 * produces is sent again on every later call, so a long session pays for its
 * whole history each time the model is asked anything. That growth is what
 * context editing exists to bound, and it can only be judged across many calls.
 *
 * Same construction as the floor benchmark: the REAL agent through
 * `DeepAgentFactory.create`, the real provider model class, and only that
 * model's `_generate` replaced. Here the replacement is scripted: over TURNS user
 * turns on one thread, it asks for READS real files with `safe_read_file` and
 * then answers. The reads are real — bounded by `UMBRA_MAX_READ_TOKENS` like any
 * other — so the history grows exactly as a session reading those files would.
 *
 * ## Two arms
 *
 * `on`  - the shipped agent.
 * `off` - the control: the same agent, with the context-editing trigger set out
 *         of reach, so nothing is ever cleared. Only the trigger differs. Before
 *         context editing exists in the code, both arms are the same and either
 *         is the baseline.
 *
 * No network call, no credential. Index sync is skipped, as in the floor bench.
 *
 * Usage:
 *   node scripts/bench-context-growth.mjs
 *   node scripts/bench-context-growth.mjs --arm off --turns 8 --reads 2
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
  console.log('Usage: node scripts/bench-context-growth.mjs [--arm on|off] [--turns <n>] [--reads <n>] [--model <id>] [--output <file>]');
  process.exit(0);
}

const model = valueAfter(args, '--model') ?? 'gemini-2.5-flash-lite';
const arm = valueAfter(args, '--arm') ?? 'on';
const TURNS = Number.parseInt(valueAfter(args, '--turns') ?? '6', 10);
const READS = Number.parseInt(valueAfter(args, '--reads') ?? '2', 10);
if (!['on', 'off'].includes(arm) || !(TURNS > 0) || !(READS > 0)) {
  console.error('Benchmark blocked: use --arm on|off and positive --turns and --reads.');
  process.exit(2);
}

/**
 * Large source files of this repository, read in order. Real files, so each read
 * costs what reading them costs; the largest first, so the curve rises fast.
 */
const FILES = [
  'src/core/agent/deep-agent-factory.ts', 'src/presentation/cli/chat-session.ts',
  'src/core/rag/graphrag.ts', 'src/core/tools/read-only-executions.ts',
  'src/bin/cli.ts', 'src/core/rag/indexer.ts', 'src/presentation/cli/model-menu.ts',
  'src/core/rag/retriever.ts', 'src/core/llm/provider.ts',
  'src/presentation/cli/stream-renderer.ts', 'src/presentation/cli/interactive-select.ts',
  'src/core/rag/index-integrity.ts', 'src/core/agent/orchestration-guard.middleware.ts',
  'src/presentation/cli/line-editor.ts', 'src/core/rag/nest-graph-store.ts',
  'src/core/agent/agent-kernel.ts',
];
if (TURNS * READS > FILES.length) {
  console.error('Benchmark blocked: at most ' + FILES.length + ' reads; lower --turns or --reads.');
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

// Reads resolve against the working directory, as in an interactive session.
process.chdir(repoRoot);

const compiled = (relative) => import(pathToFileURL(path.join(repoRoot, 'dist', relative)).href);
const { LLMProvider } = await compiled('core/llm/provider.js');
const { DeepAgentFactory } = await compiled('core/agent/deep-agent-factory.js');
const { tokenCounter } = await compiled('core/llm/tokens/token-counter.js');
const { AIMessage } = await import('@langchain/core/messages');

process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'bench-context-growth';
DeepAgentFactory.maybeReindex = async () => undefined;

// The control arm. The trigger is read when the middleware is built, so moving
// it out of reach before `create()` disables clearing and changes nothing else.
// A tree that predates context editing has no module, and then both arms are
// the baseline.
const editingModule = path.join(repoRoot, 'dist/core/agent/context-editing.js');
const editingExists = fs.existsSync(editingModule);
if (arm === 'off' && editingExists) {
  const require = createRequire(import.meta.url);
  require(editingModule).CONTEXT_EDITING.triggerTokens = Number.MAX_SAFE_INTEGER;
}

// The script: per turn, READS tool calls, then an answer.
const script = [];
for (let turn = 0; turn < TURNS; turn += 1) {
  for (let read = 0; read < READS; read += 1) script.push({ turn, read: FILES[turn * READS + read] });
  script.push({ turn, answer: true });
}

const counter = tokenCounter();
const isType = (message, type) => (message._getType?.() ?? message.getType?.()) === type;
const calls = [];

const realCreate = LLMProvider.createChatModel.bind(LLMProvider);
LLMProvider.createChatModel = (...createArgs) => {
  const instance = realCreate(...createArgs);
  instance._generate = async (messages, options) => {
    const index = calls.length;
    const step = script[index] ?? { turn: TURNS - 1, answer: true };
    const system = messages.filter((m) => isType(m, 'system'))
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const rest = messages.filter((m) => !isType(m, 'system'));
    const declarations = (options?.tools ?? []).flatMap((entry) => entry.functionDeclarations ?? [entry]);
    const tools = declarations.map((d) => ({ name: d.name, description: d.description, schema: d.parameters }));
    const count = counter.countRequest({ system, tools, messages: rest });
    const toolResults = rest.filter((m) => isType(m, 'tool'));
    calls.push({
      call: index + 1,
      turn: step.turn + 1,
      inputTokens: count.total,
      messages: rest.length,
      toolResults: toolResults.length,
      clearedToolResults: toolResults.filter((m) => String(m.content).trim() === '[cleared]').length,
    });

    const message = step.read
      ? new AIMessage({
        content: '',
        tool_calls: [{ name: 'safe_read_file', args: { file_path: step.read }, id: 'read-' + (index + 1), type: 'tool_call' }],
      })
      : new AIMessage('Noted.');
    return { generations: [{ text: step.read ? '' : 'Noted.', message }] };
  };
  return instance;
};

const threadId = 'bench-context-growth-' + process.pid;
const agent = await DeepAgentFactory.create({ model, threadId, rootDir: repoRoot });
for (let turn = 0; turn < TURNS; turn += 1) {
  await agent.invoke(
    { messages: [{ role: 'user', content: 'Turn ' + (turn + 1) + ': read the next files and note what they do.' }] },
    { configurable: { thread_id: threadId }, recursionLimit: 60 },
  );
}

if (calls.length === 0) {
  console.error('Benchmark blocked: the model was never called.');
  process.exit(1);
}

/**
 * Records which code state produced these numbers; the results directory does
 * not count as a change, for the reason `bench-turn-floor.mjs` records.
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

const inputs = calls.map((entry) => entry.inputTokens);
const last = calls[calls.length - 1];
const code = codeVersion();
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  commit: code.commit,
  dirtyWorkingTree: code.dirty,
  model,
  arm,
  editingInCode: editingExists,
  turns: TURNS,
  readsPerTurn: READS,
  counter: counter.identity,
  summary: {
    calls: calls.length,
    firstInput: inputs[0],
    lastInput: last.inputTokens,
    peakInput: Math.max(...inputs),
    totalInput: inputs.reduce((sum, value) => sum + value, 0),
    clearedAtEnd: last.clearedToolResults,
  },
  calls,
};

const stamp = code.commit + (code.dirty ? '-dirty' : '');
const defaultOutput = path.join(
  repoRoot,
  'docs/benchmarks/results',
  new Date().toISOString().slice(0, 10) + '-context-growth-' + model + '-' + arm + '-' + stamp + '.json',
);
const outputPath = path.resolve(valueAfter(args, '--output') ?? defaultOutput);
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');

console.log('context growth - ' + model + ', arm ' + arm + (editingExists ? '' : ' (no editing in this tree)') +
  ', ' + TURNS + ' turns x ' + READS + ' reads');
for (const entry of calls) {
  console.log('  call ' + String(entry.call).padStart(2) + '  turn ' + entry.turn + '  input ' +
    String(entry.inputTokens).padStart(6) + '  tool results ' + entry.toolResults +
    (entry.clearedToolResults ? ' (' + entry.clearedToolResults + ' cleared)' : ''));
}
console.log('  total input ' + report.summary.totalInput + ' tokens across ' + calls.length + ' calls; peak ' +
  report.summary.peakInput + ', last ' + report.summary.lastInput);
console.log('report written to ' + path.relative(repoRoot, outputPath));
