#!/usr/bin/env node
import * as dotenv from "dotenv";
dotenv.config({ quiet: true }); // Load .env variables silently

// ── LangSmith Observability ──────────────────────────────────────────────────
// Must be imported AFTER dotenv.config() and BEFORE any @langchain/* imports.
// This triggers the auto-patch that hooks LangSmith into LangChain's callback system.
// When LANGCHAIN_TRACING_V2=false or LANGCHAIN_API_KEY is missing, this is a no-op.
import "langsmith/langchain";

import { Command } from "commander";
import chalk from "chalk";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import * as readline from "readline";
import * as path from "path";
import { AgentFactory } from "../core/agent/factory";
import { GraphAgentFactory } from "../core/agent/graph-factory";
import { DeepAgentFactory } from "../core/agent/deep-agent-factory";
import { StreamRenderer, ChatSession } from "../presentation/cli";
import { resolveModelForSession } from "../core/config/model-resolver";
import { Command as LangGraphCommand } from "@langchain/langgraph";
import { AgentDB } from "../core/state/db";
import { ensureAgentConfig, loadAgentConfig } from "../core/config/agent-config";
import { hasIncompleteToolTurn } from '../presentation/cli/incomplete-tool-turn';

const program = new Command();

// Styled logs
const log = {
  ai: (msg: string) => console.log(chalk.blue("🤖 [AI]: ") + msg),
  sys: (msg: string) => console.log(chalk.gray("⚙️  [SYS]: ") + msg),
  error: (msg: string) => console.log(chalk.red("❌ [ERR]: ") + msg),
  hitl: (msg: string) => console.log(chalk.yellow("✋ [WAITING FOR APPROVAL]: ") + msg),
};

/**
 * Ensures clean exit and database closing
 */
const cleanupAndExit = () => {
  log.sys("Shutting down... Closing DB connections.");
  AgentDB.close();
  process.exit(0);
};

process.on("SIGINT", cleanupAndExit);
process.on("SIGTERM", cleanupAndExit);

/**
 * Helper to ask for user confirmation in the CLI.
 */
const askConfirmation = (query: string): Promise<boolean> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(chalk.yellowBright(`${query} (y/n): `), (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
};

/**
 * Resets a named Deep session only when its checkpoint stopped after a tool
 * result and therefore cannot accept a new human message safely.
 *
 * @param agent - The newly created Deep agent for the requested session.
 * @param threadId - Persistent LangGraph thread identifier.
 * @param model - Optional explicit model override for the recreated agent.
 * @returns The original agent when its checkpoint is complete, otherwise a
 * fresh agent bound to the reset session.
 */
async function recoverIncompleteDeepSession(
  agent: any,
  threadId: string,
  model?: string,
): Promise<any> {
  try {
    const state = await agent.getState({ configurable: { thread_id: threadId } });
    const messages: unknown[] = state?.values?.messages ?? [];

    if (!hasIncompleteToolTurn(messages)) {
      return agent;
    }

    const cleared = DeepAgentFactory.clearCorruptedCheckpoint(
      process.cwd(),
      threadId,
      'simple',
    );

    if (!cleared) {
      return agent;
    }

    process.stderr.write(
      chalk.yellow(
        `\n⚠️  Session "${threadId.replace(/^deep-/, '')}" stopped after a tool result. ` +
        'Its incomplete checkpoint was cleared before accepting a new message.\n',
      ),
    );
    return DeepAgentFactory.create({ model, threadId });
  } catch {
    // Checkpoint inspection is best effort. A healthy session must still start
    // when an older deepagents version does not expose getState().
    return agent;
  }
}

program
  .name("agent")
  .description("Autonomous Engineering Agent for NestJS (Graph-based with HITL)")
  .argument("<instruction>", "Technical instruction for the agent")
  .action(async (instruction: string) => {
    try {
      if (!instruction || instruction.trim().length === 0) {
        log.error("Provide a valid instruction.");
        return;
      }

      // log.sys("Initializing Agent in GRAPH mode (LangGraph)...");

      const threadId = "cli-user-graph";
      const config = { configurable: { thread_id: threadId }, recursionLimit: 50 };
      const agent = await GraphAgentFactory.create({ threadId });

      log.ai(`Processing (Graph): "${instruction}"`);

      // 🎓 INITIAL INVOCATION
      if (!agent || typeof (agent as any).invoke !== "function") {
        log.error(`Compiled Agent is missing .invoke(). Type: ${typeof agent}`);
        console.log("Agent keys:", Object.keys(agent || {}));
        process.exit(1);
      }
      let response = await (agent as any).invoke(
        { messages: [new HumanMessage(instruction)] },
        config,
      );

      // 🎓 INTERACTIVE HITL & PROACTIVE LOOP
      // We loop until the graph truly reaches 'END'.
      while (true) {
        const state = await agent.getState(config);
        
        if (!state.next || state.next.length === 0) {
          break;
        }

        // Check for 'dangerous_actor' node interrupt (Breakpoint)
        if (state.next.includes("dangerous_actor")) {
          const lastMessage = state.values.messages[state.values.messages.length - 1] as AIMessage;
          
          if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
            const toolCall = lastMessage.tool_calls[0];

            // 🛑 CASE 1: PROACTIVE QUESTION (ask_human)
            if (toolCall.name === "ask_human") {
              console.log(chalk.magenta("\n❓ [AGENT NEEDS HELP]:"));
              console.log(chalk.white(`   "${toolCall.args.question}"`));
              
              const userResponse = await new Promise<string>((resolve) => {
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                rl.question(chalk.magentaBright("\nYour response: "), (answer) => {
                  rl.close();
                  resolve(answer);
                });
              });

              log.sys("Sending response to agent...");
              
              const toolMessage = new ToolMessage({
                tool_call_id: toolCall.id!,
                content: userResponse,
              });

              await agent.updateState(config, { messages: [toolMessage] });
              response = await agent.invoke(null, config);
            } 
            
            // ✅ CASE 2: STANDARD ACTION APPROVAL (y/n)
            else {
              console.log(chalk.yellow("\n⚠️  [HITL] The Agent wants to take the following actions:"));
              lastMessage.tool_calls.forEach(call => {
                console.log(chalk.white(`   - Tool: ${chalk.bold(call.name)}`));
                console.group();
                console.log(chalk.gray(`Arguments: ${JSON.stringify(call.args, null, 2)}`));
                console.groupEnd();
              });

              const confirmed = await askConfirmation("Do you approve these actions?");
              
              if (confirmed) {
                log.sys("Approval received. Resuming execution...");
                
                const toolMessages = lastMessage.tool_calls.map(tc => new ToolMessage({
                   tool_call_id: tc.id!,
                   content: "✅ Approved by user. Executing now..."
                }));
                
                await agent.updateState(config, { messages: toolMessages });
                response = await agent.invoke(null, config);
              } else {
                log.error("Action denied by user. Task aborted.");
                return;
              }
            }
          }
        } else {
          response = await agent.invoke(null, config);
        }
      }

      // DISPLAY FINAL RESPONSE
      const lastMessage = response.messages[response.messages.length - 1];
      if (lastMessage && lastMessage.content) {
        console.log("\n" + chalk.cyan("--- RESPUESTA DEL AGENTE (GRAFO) ---"));
        console.log(lastMessage.content);
        console.log(chalk.cyan("------------------------------------\n"));
      }

      // log.sys("Tarea completada (Grafo).");
    } catch (error: any) {
      log.error("Error in graph agent:");
      log.error(error?.message || "Unknown error");
    }
  });

program
  .command("init")
  .description("Create the idempotent project-local multi-agent policy")
  .action(() => {
    try {
      const result = ensureAgentConfig(process.cwd());
      const state = result.created ? "created" : "already exists";
      log.sys(`Agent policy ${state}: ${result.path}`);
      log.sys(
        `Roles: supervisor=${result.config.models.supervisor}, ` +
          `researcher=${result.config.models.researcher}, ` +
          `coder=${result.config.models.coder}, verifier=${result.config.models.verifier}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Could not initialize agent policy: ${message}`);
    }
  });

program
  .command("analyze")
  .description("Evidence-gated, read-only project analysis with cited paths")
  .argument("<instruction>", "Question or audit to answer from the current repository")
  .option("-s, --session <name>", "Optional analysis session name")
  .option("-m, --model <model>", "Explicit model for this analysis only (for example: gemini-2.5-pro)")
  .action(async (instruction: string, options: { session?: string; model?: string }) => {
    try {
      const policy = loadAgentConfig(process.cwd());
      const model = resolveModelForSession(policy.models.researcher, options.model);
      const threadId = options.session
        ? `analysis-${options.session}`
        : `analysis-ephemeral-${Date.now()}`;
      const agent = await DeepAgentFactory.createAnalysis({ model: options.model, threadId });
      const result = await agent.invoke(
        { messages: [new HumanMessage(instruction)] },
        { configurable: { thread_id: threadId }, recursionLimit: policy.limits.maxAgentTurns },
      );
      const structured: unknown = result?.structuredResponse;
      console.log("\n" + chalk.cyan("--- EVIDENCE-GATED ANALYSIS ---"));
      console.log(
        typeof structured === "string"
          ? structured
          : JSON.stringify(
              structured ?? result?.messages?.[result.messages.length - 1]?.content ?? null,
              null,
              2,
            ),
      );
      console.log(chalk.cyan("--------------------------------\n"));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Analysis failed: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("classic")
  .description("Autonomous Engineering Agent for NestJS (Legacy/Classic Mode)")
  .argument("<instruction>", "Technical instruction for the agent")
  .action(async (instruction: string) => {
    try {
      if (!instruction || instruction.trim().length === 0) {
        log.error("Provide a valid instruction.");
        return;
      }
      log.sys("Initializing Agent in CLI mode (Classic)...");
      const threadId = "cli-user";
      const agent = await AgentFactory.create(threadId);
      log.ai(`Procesando: "${instruction}"`);
      const response = await agent.invoke(
        { messages: [new HumanMessage(instruction)] },
        { configurable: { thread_id: threadId }, recursionLimit: 50 },
      );
      const lastMessage = response.messages[response.messages.length - 1];
      if (lastMessage && lastMessage.content) {
        console.log("\n" + chalk.green("--- RESPUESTA DEL AGENTE ---"));
        console.log(lastMessage.content);
        console.log(chalk.green("----------------------------\n"));
      }
      log.sys("Tarea completada.");
    } catch (error: any) {
      log.error("Error in agent:");
      log.error(error?.message || "Unknown error");
    }
  });

program
  .command("graph")
  .description("Same as default: use the Graph-based agent")
  .argument("<instruction>", "Technical instruction for the agent")
  .action(async (instruction: string) => {
    program.parse([process.argv[0], process.argv[1], instruction]);
  });

program
  .command("chat")
  .description("Inicia un chat interactivo continuo con el agente")
  .action(async () => {
    try {
      log.sys("Initializing Agent in GRAPH mode (Interactive Chat)...");
      const threadId = "cli-user-chat";
      const config = { configurable: { thread_id: threadId }, recursionLimit: 50 };
      const agent = await GraphAgentFactory.create({ threadId });

      console.log(chalk.cyan("======================================="));
      console.log(chalk.cyan(" 🤖 NestJS AI Agent - Chat Interactivo"));
      console.log(chalk.cyan("======================================="));
      console.log(chalk.gray("Escribe 'exit' o 'quit' para salir.\n"));

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      const askLoop = () => {
        rl.question(chalk.blueBright("Tú: "), async (input) => {
          if (!input || input.trim().length === 0) {
            return askLoop();
          }
          if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
            rl.close();
            cleanupAndExit();
          }

          try {
            let response = await (agent as any).invoke(
              { messages: [new HumanMessage(input)] },
              config,
            );

            while (true) {
              const state = await agent.getState(config);
              if (!state.next || state.next.length === 0) break;
              
              if (state.next.includes("dangerous_actor")) {
                 const lastMessage = state.values.messages[state.values.messages.length - 1] as AIMessage;
                 if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
                    const toolCall = lastMessage.tool_calls[0];
                    if (toolCall.name === "ask_human") {
                      console.log(chalk.magenta("\n❓ [AGENT NEEDS HELP]:"));
                      console.log(chalk.white(`   "${toolCall.args.question}"`));
                      
                      const userResponse = await new Promise<string>((resolve) => {
                        rl.question(chalk.magentaBright("\nYour response: "), resolve);
                      });

                      const toolMessage = new ToolMessage({
                        tool_call_id: toolCall.id!,
                        content: userResponse,
                      });
                      await agent.updateState(config, { messages: [toolMessage] });
                      response = await agent.invoke(null, config);
                    } else {
                      console.log(chalk.yellow("\n⚠️  [HITL] The Agent wants to take the following actions:"));
                      lastMessage.tool_calls.forEach(call => {
                        console.log(chalk.white(`   - Tool: ${chalk.bold(call.name)}`));
                        console.group();
                        console.log(chalk.gray(`Arguments: ${JSON.stringify(call.args, null, 2)}`));
                        console.groupEnd();
                      });

                      const confirmed = await new Promise<boolean>((resolve) => {
                        rl.question(chalk.yellowBright("Do you approve these actions? (y/n): "), (ans) => {
                          resolve(ans.toLowerCase() === "y" || ans.toLowerCase() === "yes");
                        });
                      });
                      
                      if (confirmed) {
                        const toolMessages = lastMessage.tool_calls.map(tc => new ToolMessage({
                           tool_call_id: tc.id!,
                           content: "✅ Approved by user. Executing now..."
                        }));
                        await agent.updateState(config, { messages: toolMessages });
                        response = await agent.invoke(null, config);
                      } else {
                        log.error("Action denied by user. Task aborted.");
                        break;
                      }
                    }
                 }
              } else {
                 response = await agent.invoke(null, config);
              }
            }

            const lastMessage = response.messages[response.messages.length - 1];
            if (lastMessage && lastMessage.content) {
              console.log("\n" + chalk.green("🤖 Agente: ") + lastMessage.content + "\n");
            }
          } catch (error: any) {
             log.error("Error in chat loop: " + (error?.message || "Unknown error"));
          }

          askLoop();
        });
      };

      askLoop();

    } catch (error: any) {
      log.error("Error starting chat:");
      log.error(error?.message || "Unknown error");
    }
  });


program
  .command("deep")
  .description("⭐ Deep Agent — streaming session, stays open like Claude/Gemini CLI")
  .argument("[instruction]", "Optional first task (session stays open after)")
  .option("-s, --session <name>", "Named session to persist and reopen across runs")
  .option("-m, --model <model>", "Explicit model for this session only")
  .action(async (instruction: string | undefined, options: { session?: string; model?: string }) => {
    try {
      const agentConfig = loadAgentConfig(process.cwd());
      const model = resolveModelForSession(agentConfig.models.supervisor, options.model);
      // With --session <name>: always reopens the same named context (persistent).
      // Without --session: ephemeral — fresh thread every run, nothing accumulates.
      const threadId = options.session
        ? `deep-${options.session}`
        : `deep-ephemeral-${Date.now()}`;
      let agent = await DeepAgentFactory.create({ model: options.model, threadId });
      if (options.session) {
        agent = await recoverIncompleteDeepSession(agent, threadId, options.model);
      }
      const renderer = new StreamRenderer('deep');
      const session = new ChatSession(agent, renderer, {
        mode: 'deep',
        model,
        threadId,
        sessionName: options.session,
        recursionLimit: agentConfig.limits.maxAgentTurns,
        envFilePath: path.join(process.cwd(), '.env'),
        // agentFactory: called by /model to hot-swap the agent without losing session
        agentFactory: async (newModel: string) =>
          DeepAgentFactory.create({ model: newModel, threadId }),
        sessionRecovery: options.session
          ? async () => DeepAgentFactory.clearCorruptedCheckpoint(process.cwd(), threadId, 'simple')
          : undefined,
      });
      await session.start(instruction);
    } catch (error: any) {
      const isCorruptedSession = error?.message?.includes('at least one parts field');

      if (isCorruptedSession && options.session) {
        // Auto-recovery: clear the corrupted checkpoint and retry once
        const threadId = `deep-${options.session}`;
        process.stderr.write(
          chalk.yellow('\n⚠️  Session history corrupted (empty message in checkpoint).\n') +
          chalk.yellow(`   Auto-clearing session "${options.session}" and retrying...\n`)
        );

        const cleared = DeepAgentFactory.clearCorruptedCheckpoint(process.cwd(), threadId, 'simple');
        if (cleared) {
          try {
            const recoveryConfig = loadAgentConfig(process.cwd());
            const model = resolveModelForSession(recoveryConfig.models.supervisor, options.model);
            const agent = await DeepAgentFactory.create({ model: options.model, threadId });
            const renderer = new StreamRenderer('deep');
            const session = new ChatSession(agent, renderer, {
              mode: 'deep', model, threadId, sessionName: options.session,
              recursionLimit: loadAgentConfig(process.cwd()).limits.maxAgentTurns,
            });
            process.stderr.write(chalk.green('   ✅ Session recovered. Starting fresh for this session.\n\n'));
            await session.start(instruction);
            return;
          } catch (retryError: any) {
            process.stderr.write(chalk.red('   ✗ Recovery failed: ') + retryError?.message + '\n');
          }
        }
      }

      console.error(chalk.red('\n✗ Failed to start deep session:'), error?.message);
      process.exit(1);
    }
  });

program
  .command("orchestrate")
  .description("🎯 Orchestrator — Researcher + Coder + Verifier subagents, streaming session")
  .argument("[instruction]", "Optional first task (session stays open after)")
  .option("-s, --session <name>", "Named session to persist and reopen across runs")
  .option("-m, --model <model>", "Explicit Supervisor model for this session only")
  .action(async (instruction: string | undefined, options: { session?: string; model?: string }) => {
    try {
      const agentConfig = loadAgentConfig(process.cwd());
      const model = resolveModelForSession(agentConfig.models.supervisor, options.model);
      // With --session <name>: always reopens the same named context (persistent).
      // Without --session: ephemeral — fresh thread every run, nothing accumulates.
      const threadId = options.session
        ? `orchestrate-${options.session}`
        : `orchestrate-ephemeral-${Date.now()}`;
      const agent = await DeepAgentFactory.createOrchestrator({ model: options.model, threadId });
      const renderer = new StreamRenderer('orchestrate');
      const session = new ChatSession(agent, renderer, {
        mode: 'orchestrate',
        model,
        threadId,
        sessionName: options.session,
        recursionLimit: agentConfig.limits.maxAgentTurns,
        envFilePath: path.join(process.cwd(), '.env'),
        // agentFactory: called by /model to hot-swap the orchestrator agent
        agentFactory: async (newModel: string) =>
          DeepAgentFactory.createOrchestrator({ model: newModel, threadId }),
      });
      await session.start(instruction);
    } catch (error: any) {
      console.error(chalk.red("\n✗ Failed to start orchestrator session:"), error?.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

