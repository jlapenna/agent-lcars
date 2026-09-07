import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface WorkflowInput {
  default?: string;
  required?: boolean;
  type?: string;
}

interface WorkflowContract {
  on: {
    workflow_call: {
      inputs: Record<string, WorkflowInput>;
    };
  };
  jobs: Record<string, { 'runs-on'?: string }>;
}

describe('agent-automerge reusable runner pools', () => {
  it('lets the persistent check waiter run outside the short-lived glue pool', async () => {
    const workflow = parseYaml(
      await readFile('.github/workflows/agent-automerge-reusable.yml', 'utf8'),
    ) as WorkflowContract;

    expect(workflow.on.workflow_call.inputs['restore-runs-on']).toMatchObject({
      default: '',
      required: false,
      type: 'string',
    });

    const sharedPool = workflow.jobs.automerge['runs-on'];
    const restorePool = workflow.jobs['restore-main-checks']['runs-on'];

    expect(sharedPool).toContain('inputs.runs-on');
    expect(sharedPool).not.toContain('inputs.restore-runs-on');
    expect(restorePool).toContain('inputs.restore-runs-on');
    expect(restorePool).toContain('inputs.runs-on');
    expect(restorePool).not.toBe(sharedPool);
  });
});
