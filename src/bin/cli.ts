#!/usr/bin/env node
import * as dotenv from "dotenv";
dotenv.config({ quiet: true }); // Load .env variables silently
import { Command } from "commander";
import chalk from "chalk";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import * as readline from "readline";
import { AgentFactory } from "../core/agent/factory";
import { GraphAgentFactory } from "../core/agent/graph-factory";
import { DeepAgentFactory } from "../core/agent/deep-agent-factory";
import { StreamRenderer, ChatSession } from "../presentation/cli";
import { resolveModel } from "../core/config/model-resolver";
import { Command as LangGraphCommand } from "@langchain/langgraph";
import { AgentDB } from "../core/state/db";

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
  .action(async (instruction: string | undefined, options: { session?: string }) => {
    try {
      const model = resolveModel();
      // With --session <name>: always reopens the same named context (persistent).
      // Without --session: ephemeral — fresh thread every run, nothing accumulates.
      const threadId = options.session
        ? `deep-${options.session}`
        : `deep-ephemeral-${Date.now()}`;
      const agent = await DeepAgentFactory.create({ model, threadId });
      const renderer = new StreamRenderer('deep');
      const session = new ChatSession(agent, renderer, {
        mode: 'deep',
        model,
        threadId,
        sessionName: options.session,
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
            const model = resolveModel();
            const agent = await DeepAgentFactory.create({ model, threadId });
            const renderer = new StreamRenderer('deep');
            const session = new ChatSession(agent, renderer, {
              mode: 'deep', model, threadId, sessionName: options.session,
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
  .description("🎯 Orchestrator — Researcher + Coder subagents, streaming session")
  .argument("[instruction]", "Optional first task (session stays open after)")
  .option("-s, --session <name>", "Named session to persist and reopen across runs")
  .action(async (instruction: string | undefined, options: { session?: string }) => {
    try {
      const model = resolveModel();
      // With --session <name>: always reopens the same named context (persistent).
      // Without --session: ephemeral — fresh thread every run, nothing accumulates.
      const threadId = options.session
        ? `orchestrate-${options.session}`
        : `orchestrate-ephemeral-${Date.now()}`;
      const agent = await DeepAgentFactory.createOrchestrator({ model, threadId });
      const renderer = new StreamRenderer('orchestrate');
      const session = new ChatSession(agent, renderer, {
        mode: 'orchestrate',
        model,
        threadId,
        sessionName: options.session,
        recursionLimit: 100,
      });
      await session.start(instruction);
    } catch (error: any) {
      console.error(chalk.red("\n✗ Failed to start orchestrator session:"), error?.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

