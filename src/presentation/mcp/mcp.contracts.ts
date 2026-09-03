/**
 * The outward-facing shapes of Umbra's MCP server (ADR-024).
 *
 * Pure interfaces and closed unions, mirroring `agent-http.contracts.ts`: a
 * presentation layer publishes DTOs, never internals. Nothing here imports from
 * `src/core/`, so a change to a tool's return string cannot silently change the
 * protocol surface.
 */

/**
 * MCP protocol revision this server implements.
 *
 * Fixed rather than negotiated upward: the server answers a client's requested
 * version with this one, and a client that requires something newer can refuse.
 * Claiming support for a revision that has not been implemented is the failure
 * mode this constant exists to prevent.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC 2.0 version tag; the only value permitted by the spec. */
export const JSONRPC_VERSION = '2.0';

/** Identifier of a JSON-RPC request. Notifications carry none. */
export type JsonRpcId = string | number;

/** An inbound JSON-RPC request or notification. */
export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  /** Absent for notifications, which must not be answered. */
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

/** A successful JSON-RPC response. */
export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

/** A JSON-RPC error response. */
export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  error: {
    code: JsonRpcErrorCode;
    message: string;
  };
}

/** Anything this server may write to the wire. */
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/**
 * The JSON-RPC error codes this server uses.
 *
 * A closed set on purpose: an invented code is indistinguishable to a client
 * from a protocol violation.
 */
export const JsonRpcErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** One of {@link JsonRpcErrorCodes}. */
export type JsonRpcErrorCode = (typeof JsonRpcErrorCodes)[keyof typeof JsonRpcErrorCodes];

/**
 * A JSON Schema for a tool's arguments, as MCP requires it.
 *
 * Written by hand for the four published tools rather than generated. Their
 * schemas are one string, one string plus an enum, an empty object, and one
 * optional boolean — a code generator for that is more moving parts than the
 * thing it generates, and `zod-to-json-schema` is not a dependency of this
 * project.
 */
export interface McpToolSchema {
  type: 'object';
  properties: Record<string, McpSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

/** One property of a tool's argument schema. */
export interface McpSchemaProperty {
  type: 'string' | 'boolean' | 'number';
  description?: string;
  enum?: readonly string[];
  default?: string | boolean | number;
}

/** A tool as advertised by `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: McpToolSchema;
}

/** A single block of tool output. Only text is produced by this server. */
export interface McpTextContent {
  type: 'text';
  text: string;
}

/** The result of `tools/call`. */
export interface McpToolResult {
  content: McpTextContent[];
  /** True when the tool declined or failed. Never omitted on a failure. */
  isError?: boolean;
}

/** A resource as advertised by `resources/list`. */
export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/** The body of one resource, as returned by `resources/read`. */
export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

/** A prompt as advertised by `prompts/list`. */
export interface McpPromptDescriptor {
  name: string;
  description: string;
}

/** The body of one prompt, as returned by `prompts/get`. */
export interface McpPromptResult {
  description: string;
  messages: {
    role: 'user';
    content: McpTextContent;
  }[];
}

/**
 * What this server declares it can do.
 *
 * `sampling` and `listChanged` are absent by decision, not omission:
 *
 * - **sampling** would let this server ask the client to run a model call,
 *   spending the client's budget on a prompt nobody audited.
 * - **listChanged** would make the tool list dynamic, recreating the
 *   prompt/tool drift ADR-013 documents with an external process as the cause.
 */
export interface McpServerCapabilities {
  tools: Record<string, never>;
  resources: Record<string, never>;
  prompts: Record<string, never>;
}

/** The `initialize` result. */
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
  /** Free-text guidance a client may show or prepend. */
  instructions?: string;
}
