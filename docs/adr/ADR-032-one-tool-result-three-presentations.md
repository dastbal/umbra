# ADR-032 — One tool result, three presentations

**Status:** Accepted
**Date:** 2026-09-14
**Tags:** `tools`, `mcp`, `cli`, `langchain`, `schema`, `evidence`

## Context

Umbra's read-only operations were implemented inside LangChain tools. MCP invoked those adapters and converted their final strings back into protocol output, while the CLI identified completion only by tool name and ignored the result. A successful operation, an empty search, an abstention, a policy block, and a failure were therefore presentation conventions rather than enforceable data.

## Decision

Each read-only capability executes in a framework-independent function and returns a versioned, tool-specific Zod result. The shared states are `success`, `partial`, `empty`, `abstained`, `blocked`, and `error`; blocked and error results require a diagnostic. Evidence, truncation, retryability, and recovery guidance are explicit fields.

One execution is projected three ways:

- LangChain receives evidence-bearing model content plus the structured result as `artifact`.
- The CLI reads the artifact, correlates completion by run identifier, and shows its real summary and failure state.
- MCP publishes `outputSchema` and validated `structuredContent`, with exactly the same object serialized as JSON text for compatibility.

Index status keeps live lifecycle, persisted stamp, and integrity inspection separate. Retrieval keeps the original query, optional clarification, paths, ranges, snippets, match reasons, and provenance; ranking signals are not confidence probabilities.

The canonical assistant guide is `.agents/skills/umbra-tool-usage/SKILL.md`. Provider directories link to it, and the installed package exposes the same body as an opt-in MCP prompt. Essential rules also remain in tool descriptions and schemas because MCP prompts are not automatically consumed.

## Consequences

Presentation layers can evolve without re-running an operation or parsing human text. Public result changes are now schema changes. MCP clients may consume both text and structure, so response-cost evaluation must count both when they do. Writes, SDK v2 migration, ranking changes, and a CLI-to-MCP transport remain separate work.

## Verification

The affected TypeScript project type-checks. Focused contract, MCP, prompt, renderer, and session tests pass (49 tests). Package verification and the full regression suite are recorded in the implementation handoff rather than predicted here.
