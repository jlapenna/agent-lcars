import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface Step {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface Job {
  if?: string;
  permissions?: Record<string, string>;
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
  permissions?: Record<string, string>;
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
    expect(workflow.jobs.automerge.if).toContain(
      "inputs.app-token-enabled && github.event_name == 'pull_request_target'",
    );
    expect(workflow.jobs.automerge.if).toContain(
      'inputs.app-token-enabled == false',
    );
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
    expect(reconcileMint?.with).not.toHaveProperty('permission-statuses');
    expect(workflow.jobs['reconcile-automerge'].permissions).toMatchObject({
      checks: 'read',
      statuses: 'read',
    });
    const reconcileArm = reconcileSteps.find(
      (step) =>
        step.name === 'Arm ready open agent PRs missed by event delivery',
    );
    expect(reconcileArm?.env?.APP_LOGIN).toContain(
      "format('app/{0}', steps.mint-app-token.outputs.app-slug)",
    );
    expect(reconcileArm?.env?.LEGACY_AUTOMERGE_LOGIN).toBe(
      'app/github-actions',
    );
    expect(reconcileArm?.run).toContain(
      '.autoMergeRequest.enabledBy.login == $login',
    );
    expect(reconcileArm?.run).toContain(
      '[ "$LEGACY_ACTOR" != "$LEGACY_AUTOMERGE_LOGIN" ]',
    );
    expect(reconcileArm?.run).toContain('preserving that explicit actor');
    expect(reconcileArm?.run).toContain('--disable-auto');
    for (const name of [
      'Dismiss stale bot CHANGES_REQUESTED reviews on armed green agent PRs',
      'Update behind branches of auto-merge-armed PRs',
    ]) {
      const step = reconcileSteps.find((candidate) => candidate.name === name);
      expect(step?.env?.GH_READ_TOKEN).toBe('${{ github.token }}');
      expect(step?.run).toContain('GH_TOKEN="$GH_READ_TOKEN" gh pr view');
    }
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
    expect(caller.on).toHaveProperty('pull_request_target');
    expect(caller.on).toHaveProperty('push');
    expect(caller.on).not.toHaveProperty('pull_request');
    expect(caller.on).not.toHaveProperty('pull_request_review');
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
    expect(reusable.jobs['reconcile-automerge']).toMatchObject({
      if: expect.stringContaining(
        "github.event_name == 'push' && inputs.app-token-enabled",
      ),
    });
    expect(reusable.jobs['restore-main-checks']).toMatchObject({
      if: expect.stringContaining('inputs.app-token-enabled == false'),
      permissions: expect.objectContaining({ statuses: 'read' }),
    });
    expect(caller.permissions).toMatchObject({ statuses: 'read' });
  });
});
