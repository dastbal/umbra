// Exportamos el Módulo para NestJS
export * from "./ai-agent.module";

// Exportamos la Factory y los tipos por si alguien quiere uso manual
export * from "./core/agent/factory";
export * from "./core/agent/deep-agent-factory";
export * from "./core/agent/contracts";
export * from "./core/agent/agent-kernel";
export * from './core/agent/tokens';
export * from "./core/agent/evidence-protocol";
export * from "./core/agent/workspace-evidence";
export * from "./core/config/agent-config";
export * from "./core/llm/provider";
export * from './core/security';
export * from './core/observability';
export * from './core/rag/embeddings';
export * from './presentation/http';
export * from './presentation/mcp';

// Exportamos las herramientas por si el usuario quiere crear su propio agente
export * from "./core/tools";
