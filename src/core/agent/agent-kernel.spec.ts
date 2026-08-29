import { z } from 'zod';
import {
  KERNEL_API_VERSION,
  buildSubagentFromProfile,
  composeRolePrompt,
  describeRoleRuntime,
  resolveCapabilityTools,
  type AgentRuntimeContext,
  type RoleProfile,
  validateRoleExtensions,
} from './agent-kernel';
import { parseAgentConfig } from '../config/agent-config';

const context: AgentRuntimeContext = {
  rootDir: 'C:\\project',
  agentConfig: parseAgentConfig({}),
};

function advisory(id = 'security-reviewer'): RoleProfile {
  return {
    id,
    displayName: 'Security Reviewer',
    description: 'Reviews the supplied scope without changing files.',
    kernelApiVersion: KERNEL_API_VERSION,
    workflowRole: 'advisory',
    rolePrompt: 'You are a security reviewer. Return evidence only.',
    capabilities: ['read_code', 'read_adrs'],
    model: 'gemini-2.5-flash-lite' as never,
    responseFormat: z.object({ status: z.string() }) as never,
  };
}

describe('AgentKernel', () => {
  it('composes the common education before a role soul', () => {
    const prompt = composeRolePrompt(context, 'You are a specialist.');

    expect(prompt).toContain(`Umbra Agent Kernel v${KERNEL_API_VERSION}`);
    expect(prompt.indexOf('Umbra Agent Kernel')).toBeLessThan(prompt.indexOf('You are a specialist.'));
  });

  it('resolves a capability once even when more than one capability references a tool family', () => {
    const names = resolveCapabilityTools(['read_code', 'read_adrs']).map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(['safe_read_file', 'list_files', 'list_adrs']));
    expect(new Set(names).size).toBe(names.length);
  });

  it('builds an advisory subagent with kernel instructions and only declared tools', () => {
    const role = advisory();
    const subagent = buildSubagentFromProfile(role, context);

    expect(subagent.systemPrompt).toContain(`Umbra Agent Kernel v${KERNEL_API_VERSION}`);
    expect(subagent.tools?.map((tool) => (tool as { name: string }).name))
      .toEqual(['safe_read_file', 'list_files', 'list_adrs']);
  });

  it('accepts a compatible external advisory role and describes it without prompts', () => {
    const role = advisory();

    expect(() => validateRoleExtensions([{ kernelApiVersion: KERNEL_API_VERSION, roles: [role] }], ['deep']))
      .not.toThrow();
    expect(describeRoleRuntime(role)).toEqual({
      kernelVersion: KERNEL_API_VERSION,
      roleId: 'security-reviewer',
      capabilities: ['read_code', 'read_adrs'],
      workflowRole: 'advisory',
    });
  });

  it.each([
    ['a duplicate id', { ...advisory('deep') }],
    ['an incompatible kernel', { ...advisory(), kernelApiVersion: 2 }],
    ['a writer', { ...advisory(), capabilities: ['write_code'] }],
    ['a lifecycle replacement', { ...advisory(), workflowRole: 'coder' }],
    ['a role without a model', { ...advisory(), model: undefined }],
  ] as const)('rejects %s from an external role library', (_label, role) => {
    expect(() => validateRoleExtensions(
      [{ kernelApiVersion: role.kernelApiVersion, roles: [role] } as never],
      ['deep'],
    )).toThrow();
  });
});
