import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface Step {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface Job {
  if?: string;
  steps?: Step[];
  with?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

interface Workflow {
  on: {
    workflow_call: {
      inputs: Record<string, Record<string, unknown>>;
      secrets: Record<string, Record<string, unknown>>;
    };
  };
  jobs: Record<string, Job>;
}

describe('agent auto-merge App identity', () => {
  it('mints least-privilege repository tokens for arm and reconcile jobs', async () => {
    const workflow = parseYaml(
      await readFile('.github/workflows/agent-automerge-reusable.yml', 'utf8'),
    ) as Workflow;

    expect(workflow.on.workflow_call.inputs['app-token-enabled']).toMatchObject(
      {
        default: false,
        required: false,
        type: 'boolean',
      },
    );
    expect(workflow.on.workflow_call.secrets.APP_PRIVATE_KEY).toMatchObject({
      required: false,
    });

    const armSteps = workflow.jobs.automerge.steps ?? [];
    const armMint = armSteps.find((step) => step.id === 'mint-app-token');
    expect(armMint).toMatchObject({
      if: 'inputs.app-token-enabled',
      uses: 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
      with: {
        owner: '${{ github.repository_owner }}',
        repositories: '${{ github.event.repository.name }}',
        'permission-contents': 'write',
        'permission-issues': 'write',
        'permission-pull-requests': 'write',
      },
    });
    for (const name of [
      'Claim the PR as the fleet login',
      'Clear outstanding review requests',
      'Enable squash auto-merge',
    ]) {
      expect(armSteps.find((step) => step.name === name)?.env?.GH_TOKEN).toBe(
        '${{ steps.mint-app-token.outputs.token || github.token }}',
      );
    }

    const reconcileSteps = workflow.jobs['reconcile-automerge'].steps ?? [];
    const reconcileMint = reconcileSteps.find(
      (step) => step.id === 'mint-app-token',
    );
    expect(reconcileMint?.with).toMatchObject({
      'permission-actions': 'read',
      'permission-checks': 'read',
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
    });
    expect(
      reconcileSteps
        .filter((step) => step.env?.GH_TOKEN)
        .every(
          (step) =>
            step.env?.GH_TOKEN ===
            '${{ steps.mint-app-token.outputs.token || github.token }}',
        ),
    ).toBe(true);
  });

  it('retires restore jobs and triggers for an opted-in caller', async () => {
    const reusable = parseYaml(
      await readFile('.github/workflows/agent-automerge-reusable.yml', 'utf8'),
    ) as Workflow;
    expect(reusable.jobs['restore-main-checks'].if).toContain(
      'inputs.app-token-enabled == false',
    );
    expect(reusable.jobs['close-orphaned-anchors'].if).toContain(
      'inputs.app-token-enabled == false',
    );

    const caller = parseYaml(
      await readFile('.github/workflows/agent-automerge.yml', 'utf8'),
    ) as Workflow;
    expect(caller.on).not.toHaveProperty('workflow_run');
    expect(caller.jobs.automerge.with).toMatchObject({
      'app-token-enabled': true,
      'app-client-id': '${{ vars.AGENT_LCARS_CLIENT_ID }}',
    });
    expect(caller.jobs.automerge.with).not.toHaveProperty('ci-workflow');
    expect(caller.jobs.automerge.with).not.toHaveProperty('deploy-workflow');
    expect(caller.jobs.automerge.secrets).toMatchObject({
      APP_PRIVATE_KEY: '${{ secrets.AGENT_LCARS_PRIVATE_KEY }}',
    });
  });
});
