// src/ai-agent.module.ts
import { Module, Global } from "@nestjs/common";
import { AgentFactory } from "./core/agent/factory";

import { InteractionService } from "./core/interaction";

@Global()
@Module({
  providers: [
    InteractionService,
    {
      provide: "AI_AGENT",
      useFactory: async (interaction: InteractionService) => {
        return await AgentFactory.create("nestjs-instance", interaction);
      },
      inject: [InteractionService],
    },
  ],
  exports: ["AI_AGENT", InteractionService],
})
export class AiAgentModule {}
