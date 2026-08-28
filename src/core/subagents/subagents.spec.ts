import {
  createCoderSubAgent,
} from './coder.subagent';
import {
  createResearcherSubAgent,
} from './researcher.subagent';
import {
  createVerifierSubAgent,
} from './verifier.subagent';

function toolNames(agent: { tools?: readonly { name: string }[] }): string[] {
  return (agent.tools ?? []).map((tool) => tool.name);
}

describe('specialized subagent specifications', () => {
  it('keeps Researcher read-only and returns a structured handoff', () => {
    const researcher = createResearcherSubAgent('gemini-2.5-flash-lite');

    expect(researcher.model).toBe('gemini-2.5-flash-lite');
    expect(researcher.responseFormat).toBeDefined();
    expect(toolNames(researcher)).not.toContain('safe_write_file');
  });

  it('keeps Coder as the only specialized writer', () => {
    const coder = createCoderSubAgent('gemini-2.5-pro');

    expect(coder.model).toBe('gemini-2.5-pro');
    expect(toolNames(coder)).toContain('safe_write_file');
  });

  it('keeps Verifier read-only while requiring tests and type-checks', () => {
    const verifier = createVerifierSubAgent('gemini-2.5-flash-lite');
    const names = toolNames(verifier);

    expect(verifier.responseFormat).toBeDefined();
    expect(names).toContain('run_tests');
    expect(names).toContain('run_integrity_check');
    expect(names).not.toContain('safe_write_file');
  });
});
