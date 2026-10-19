import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface Step {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface Workflow {
  jobs: Record<string, { if?: string; needs?: string; steps?: Step[] }>;
}

const readReusable = async () =>
  parseYaml(
    await readFile('.github/workflows/agent-automerge-reusable.yml', 'utf8'),
  ) as Workflow;

describe('agent auto-merge App identity trust boundary', () => {
  it('rejects false or omitted App mode before any mutation job can run', async () => {
    const workflow = await readReusable();
    const validation = workflow.jobs['validate-configuration'];
    const script = validation.steps?.find(
      (step) => step.name === 'Require explicit App merge identity',
    )?.run;
    if (script === undefined) throw new Error('App identity gate not found');
    expect(validation.steps?.[0].env?.APP_TOKEN_ENABLED).toBe(
      '${{ inputs.app-token-enabled }}',
    );
    for (const enabled of ['', 'false', 'true']) {
      const result = spawnSync('bash', ['-e', '-c', script], {
        env: { ...process.env, APP_TOKEN_ENABLED: enabled },
        encoding: 'utf8',
      });
      expect(result.status).toBe(enabled === 'true' ? 0 : 1);
      if (enabled !== 'true') {
        expect(result.stdout).toContain(
          'Legacy GITHUB_TOKEN merge mode is retired',
        );
      }
    }
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== 'validate-configuration') {
        expect(job.needs).toBe('validate-configuration');
      }
    }
    expect(workflow.jobs['automerge'].if).toContain(
      "github.event_name == 'pull_request_target'",
    );
    for (const name of ['automerge', 'reconcile-automerge']) {
      const mint = workflow.jobs[name].steps?.find((step) => step.uses);
      expect(mint?.with?.['private-key']).toBe(
        '${{ secrets.APP_PRIVATE_KEY }}',
      );
      for (const step of workflow.jobs[name].steps ?? []) {
        if (step.env?.GH_TOKEN !== undefined) {
          expect(step.env.GH_TOKEN).toBe(
            '${{ steps.mint-app-token.outputs.token }}',
          );
        }
      }
    }
  });

  it('admits only successful same-repository PR runs to the App private key', async () => {
    const reconcileIf =
      (await readReusable()).jobs['reconcile-automerge'].if ?? '';
    // Every workflow_run branch carries every guard, so no later `||`
    // branch can admit a fork-originated run to the App private key.
    const workflowRunClauses = reconcileIf
      .split('||')
      .filter((clause) =>
        clause.includes("github.event_name == 'workflow_run'"),
      );
    expect(workflowRunClauses).not.toHaveLength(0);
    for (const clause of workflowRunClauses) {
      for (const guard of [
        'inputs.app-token-enabled',
        "github.event.workflow_run.event == 'pull_request'",
        "github.event.workflow_run.conclusion == 'success'",
        'github.event.workflow_run.head_repository.full_name == github.repository',
      ]) {
        expect(clause).toContain(guard);
      }
    }
  });

  it('never runs PR content in any job, and mints only repository-scoped tokens', async () => {
    for (const job of Object.values((await readReusable()).jobs)) {
      const steps = job.steps ?? [];
      const actions = steps.flatMap((step) => (step.uses ? [step] : []));
      // The only action is the pinned, repository-scoped App token mint.
      expect(actions.map((step) => step.uses)).toEqual(
        actions.map(() =>
          expect.stringMatching(
            /^actions\/create-github-app-token@[0-9a-f]{40}$/,
          ),
        ),
      );
      for (const mint of actions) {
        expect(mint.with?.repositories).toBe(
          '${{ github.event.repository.name }}',
        );
        expect(
          Object.keys(mint.with ?? {}).filter((key) =>
            key.startsWith('permission-'),
          ),
        ).not.toHaveLength(0);
      }
      const scripts = steps.map((step) => step.run ?? '');
      // Event values reach scripts only through env, never `${{ }}`, and no
      // script fetches or checks out repository content.
      expect(scripts.filter((run) => run.includes('${{'))).toEqual([]);
      expect(
        scripts.filter((run) =>
          /\bgh (pr checkout|repo clone)\b|\bgit (clone|fetch|checkout|switch)\b/.test(
            run,
          ),
        ),
      ).toEqual([]);
    }
  });
});

describe('published App token permission admission', () => {
  it('requires explicit permissions before native token issuance', async () => {
    const action = parseYaml(
      await readFile('.github/actions/mint-agent-token/action.yml', 'utf8'),
    ) as { runs: { steps: Step[] } };
    const [guard, mint] = action.runs.steps;
    expect(guard.run).toContain('require-explicit-permissions.sh');
    expect(guard.env).toEqual(
      Object.fromEntries(
        [
          'issues',
          'contents',
          'pull-requests',
          'actions',
          'metadata',
          'workflows',
        ].map((name) => [
          `PERMISSION_${name.toUpperCase().replaceAll('-', '_')}`,
          `\${{ inputs.permission-${name} }}`,
        ]),
      ),
    );
    expect(mint.uses).toMatch(
      /^actions\/create-github-app-token@[0-9a-f]{40}$/,
    );
    expect(mint.with?.repositories).toBe('${{ inputs.repositories }}');
    expect(mint.with?.owner).toBe('${{ inputs.owner }}');
  });
});
