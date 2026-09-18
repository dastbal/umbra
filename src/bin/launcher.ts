#!/usr/bin/env node

/**
 * Emits the only liveness signal that can exist before the MCP handshake.
 *
 * The full CLI imports LangChain, the agent runtime, and provider adapters.
 * On a freshly installed Windows package Defender can inspect that dependency
 * tree before Node reaches `startMcpServer`, so an MCP notification is
 * physically impossible at this point. This tiny executable loads first and
 * writes only to stderr; stdout remains reserved for JSON-RPC once the server
 * starts.
 */
if (process.argv[2] === 'mcp') {
  process.stderr.write(
    '[umbra mcp] Starting Umbra. The first launch after an update may take a minute while Windows scans new files.\n',
  );
}

// Keep the public binary behaviour in cli.ts. Delaying this import is the
// point: it lets the operator distinguish "starting" from "unresponsive".
// Dynamic `require` preserves CommonJS package output without making the
// launcher load the CLI until after the signal above has been flushed.
void Promise.resolve().then(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./cli');
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[umbra] Startup failed: ${message}\n`);
  process.exitCode = 1;
});
