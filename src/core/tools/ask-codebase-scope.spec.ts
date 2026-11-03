import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pinRuntimeRoot, resetRuntimeRoot } from '../config/runtime-root';
import { executeCodebaseSearch } from './read-only-executions';

describe('ask_codebase scope', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-scope-'));
    pinRuntimeRoot(root);
  });

  afterEach(() => {
    resetRuntimeRoot();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('abstains before retrieval for a path in another repository', async () => {
    const { result } = await executeCodebaseSearch({ query: 'Where is /home/david/.agents/skills/akatsuki/SKILL.md configured?' });
    expect(result).toMatchObject({
      status: 'abstained', code: 'CODEBASE_SCOPE_UNSUPPORTED',
      data: { coverage: { root, markdownIndexed: false, sourceKinds: ['typescript', 'prisma-schema'] } },
    });
    expect(result.summary).toContain(root);
    expect(result.nextAction).toContain('another');
  });

  it('abstains for a Markdown file in the served repository', async () => {
    const { result } = await executeCodebaseSearch({ query: 'What does docs/adr/ADR-001.md decide?' });
    expect(result.code).toBe('CODEBASE_SCOPE_UNSUPPORTED');
    expect(result.nextAction).toContain('search_workspace');
  });
});
