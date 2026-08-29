/**
 * Content block kinds that are the model thinking, not the model answering.
 *
 * A provider that returns reasoning marks it, and every provider marks it
 * differently: LangChain normalizes some of it to a `type`, Anthropic uses
 * `thinking` and `redacted_thinking`, and Gemini flags a part with
 * `thought: true` while leaving its `type` alone. All three are checked,
 * because the cost of missing one is showing the operator a model's private
 * deliberation as if it were the reply.
 */
const THOUGHT_TYPES: readonly string[] = ['thinking', 'redacted_thinking', 'reasoning'];

/**
 * Extracts the part of a streamed chunk that the operator should actually read.
 *
 * ## What this fixes
 *
 * The CLI read `chunk.content[0].text` — the **first** block, whatever it was,
 * and nothing after it. Two defects lived in that one expression.
 *
 * A chunk carrying reasoning ahead of the answer surfaced the reasoning and
 * dropped the answer. Observed on 2026-08-28: asked "hola listo para nuestro
 * trabajo", the agent printed a paragraph deliberating about its own
 * CONVERSATION GATE and then glued the greeting onto the end with no separator
 * — `...my response should reflect that simplicity.¡Todo bien por aquí!`. That
 * concatenation is the signature of thought and answer arriving as separate
 * parts and being printed as one.
 *
 * And a chunk carrying more than one text block lost everything past the first.
 *
 * ## What it cannot fix, and who does
 *
 * This function can only separate reasoning from answer while they are still
 * *separate blocks*. A provider that hands over one flat string has already
 * fused them, and no reader can tell the halves apart afterwards — which is
 * exactly what the Vertex non-streaming transport of
 * [ADR-006](../../../docs/adr/ADR-006-vertex-tool-cycle-streaming-fallback.md)
 * does. That case is therefore repaired at the source, in
 * {@link VertexChatAdapter}, which calls this function on the structured
 * message *before* the flat string is ever produced. This one stays as the
 * second line of defence, for every provider that does stream blocks.
 *
 * The repair was attempted once in the prompt, by instructing the model never to
 * narrate its reasoning. It did not hold, and it could not have: the model was
 * not disobeying. It was returning its reasoning in the channel meant for
 * reasoning, and the CLI was printing that channel.
 *
 * @param content - The `content` of a streamed chunk, in any shape a provider emits.
 * @returns The visible text, empty when the chunk carried none.
 */
export function readVisibleText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((block) => !isThought(block))
    .map((block) => readBlockText(block))
    .join('');
}

/**
 * Reports whether a content block is the model thinking.
 *
 * Unknown block shapes are **not** treated as thoughts: a block this function
 * cannot classify is more likely a new answer format than a new reasoning
 * format, and hiding an answer is worse than showing one oddly.
 */
function isThought(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false;

  const record = block as Record<string, unknown>;
  if (record['thought'] === true) return true;

  const type = record['type'];
  return typeof type === 'string' && THOUGHT_TYPES.includes(type);
}

function readBlockText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (typeof block !== 'object' || block === null) return '';

  const text = (block as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : '';
}
