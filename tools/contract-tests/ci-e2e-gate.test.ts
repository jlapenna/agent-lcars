import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface Workflow {
  jobs?: Record<
    string,
    { if?: string; name?: string; steps?: Array<{ name?: string }> }
  >;
}

describe('CI E2E operational gate', () => {
  it('uses the E2E_ENABLED repository variable', async () => {
    const workflow = parseYaml(
      await readFile('.github/workflows/ci.yml', 'utf8'),
    ) as Workflow;

    expect(workflow.jobs?.e2e?.if).toBe("${{ vars.E2E_ENABLED == 'true' }}");
    expect(workflow.jobs?.e2e?.name).toBe('E2E');
    expect(workflow.jobs?.e2e?.steps).toContainEqual(
      expect.objectContaining({
        name: 'Run console e2e suite [full-suite]',
      }),
    );
  });
});
