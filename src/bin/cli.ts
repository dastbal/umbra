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
  .description("🚀 Deep Agent mode — full createDeepAgent with write_todos, SafeFilesystem, and built-in HITL")
  .argument("<instruction>", "Technical instruction for the agent")
  .action(async (instruction: string) => {
    try {
      if (!instruction || instruction.trim().length === 0) {
        log.error("Provide a valid instruction.");
        return;
      }

      log.sys("Initializing Agent in DEEP mode (createDeepAgent)...");
      const threadId = "deep-agent-session";
      const config = { configurable: { thread_id: threadId }, recursionLimit: 50 };
      const agent = await DeepAgentFactory.create({ threadId });

      log.ai(`Processing (Deep): "${instruction}"`);

      let result = await (agent as any).invoke(
        { messages: [{ role: "human", content: instruction }] },
        config,
      );

      // 🎓 NATIVE HITL LOOP — DeepAgents style
      // createDeepAgent uses __interrupt__ + Command.resume instead of dangerous_actor nodes.
      while (result.__interrupt__) {
        const interrupts = result.__interrupt__[0].value;
        const actionRequests = interrupts.actionRequests ?? [];
        const reviewConfigs = interrupts.reviewConfigs ?? [];

        console.log(chalk.yellow("\n✋ [HITL — AGENT PAUSED FOR APPROVAL]"));

        const decisions: any[] = [];

        for (let i = 0; i < actionRequests.length; i++) {
          const action = actionRequests[i];
          const reviewConfig = reviewConfigs[i];
          const allowed: string[] = reviewConfig?.allowedDecisions ?? ["approve", "reject"];

          console.log(chalk.white(`\n   Tool: ${chalk.bold(action.name)}`));
          console.log(chalk.gray(`   Args: ${JSON.stringify(action.args, null, 2)}`));
          console.log(chalk.gray(`   Allowed: ${allowed.join(", ")}`));

          const confirmed = await askConfirmation("Do you approve this action?");

          if (confirmed) {
            log.sys("Approved ✅");
            decisions.push({ type: "approve" });
          } else {
            log.error("Rejected ❌");
            decisions.push({
              type: "reject",
              message: "User rejected this action. Do not retry. Ask the user what to do next.",
            });
          }
        }

        // Resume agent with human decisions
        result = await (agent as any).invoke(
          new LangGraphCommand({ resume: { decisions } }),
          config,
        );
      }

      // DISPLAY FINAL RESPONSE
      const lastMessage = result.messages?.[result.messages.length - 1];
      if (lastMessage?.content) {
        console.log("\n" + chalk.cyan("--- 🤖 DEEP AGENT RESPONSE ---"));
        console.log(lastMessage.content);
        console.log(chalk.cyan("------------------------------\n"));
      }

      log.sys("Task completed (Deep Agent).");
    } catch (error: any) {
      log.error("Error in deep agent:");
      log.error(error?.message || "Unknown error");
    }
  });

program.parse(process.argv);

