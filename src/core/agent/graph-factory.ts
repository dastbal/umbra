import { InteractionService } from "../interaction";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { IndexerService } from "../rag/indexer";
import * as path from "path";
import * as fs from "fs";
import { SupervisorConfig } from "./graph/types";
import { createResearcherGraph } from "./graph/researcher.graph";
import { createCoderGraph } from "./graph/coder.graph";
import { createSupervisorGraph } from "./graph/supervisor.graph";
import { agentPath } from '../config/agent-directory';

/**
 * Factory class to instantiate the LangGraph Multi-Agent implementation.
 * It coordinates the database savers and mounts the sub-graphs.
 */
export class GraphAgentFactory {
  public static async create(config: SupervisorConfig = {}, interaction?: InteractionService) {
    const interactor = interaction || new InteractionService();
    const threadId = config.threadId || "cli-session";
    const rootDir = process.cwd();
    const agentDir = agentPath(rootDir);
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

    // isolation of history databases
    const mainDb = path.join(agentDir, "history_supervisor.db");
    const researcherDb = path.join(agentDir, "history_researcher.db");
    const coderDb = path.join(agentDir, "history_coder.db");

    const mainCheckpointer = SqliteSaver.fromConnString(mainDb);
    const researcherCheckpointer = SqliteSaver.fromConnString(researcherDb);
    const coderCheckpointer = SqliteSaver.fromConnString(coderDb);

    // 1. Instanciar Sub-grafos
    const researcherApp = createResearcherGraph(researcherCheckpointer, interactor, config.researcherContext);
    const coderApp = createCoderGraph(coderCheckpointer, interactor, config.coderContext);

    // 2. Instanciar Grafo Supervisor Principal
    const supervisorApp = createSupervisorGraph(
      mainCheckpointer, 
      interactor, 
      researcherApp, 
      coderApp, 
      threadId, 
      config.supervisorContext
    );

    // 3. Sincronizar un índice RAG antes de arrancar todo
    const indexerTask = interactor.startTask("Syncing codebase index...");
    await new IndexerService().indexProject();
    indexerTask.succeed("Codebase index synced");

    // Retorna la app del supervisor ya que es la puerta de entrada.
    return supervisorApp;
  }
}
