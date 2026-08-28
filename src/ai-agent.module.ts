import { DynamicModule, Global, Module } from '@nestjs/common';
import { DeepAgentFactory, type DeepAgentFactoryConfig } from './core/agent/deep-agent-factory';
import { InteractionService } from './core/interaction';
import { AI_AGENT } from './core/agent/tokens';

export { AI_AGENT } from './core/agent/tokens';

/** Options required to create a hardened NestJS agent integration. */
export interface AiAgentModuleOptions extends DeepAgentFactoryConfig {
  /** Optional interaction adapter used by the factory during bootstrapping. */
  interaction?: InteractionService;
}

/**
 * NestJS integration for the hardened Deep agent.
 *
 * Version 2 intentionally requires `forRoot()`: importing the module without
 * explicit options can no longer silently construct the permissive classic
 * agent.
 */
@Global()
@Module({})
export class AiAgentModule {
  /** Registers the hardened Deep agent as the `AI_AGENT` provider. */
  public static forRoot(options: AiAgentModuleOptions = {}): DynamicModule {
    return {
      module: AiAgentModule,
      providers: [
        InteractionService,
        {
          provide: AI_AGENT,
          useFactory: async (interaction: InteractionService) => DeepAgentFactory.create(
            options,
            options.interaction ?? interaction,
          ),
          inject: [InteractionService],
        },
      ],
      exports: [AI_AGENT, InteractionService],
    };
  }
}
