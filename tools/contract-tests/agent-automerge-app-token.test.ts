import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface Step {
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface Workflow {
  jobs: Record<string, { if?: string; steps?: Step[] }>;
}

const readReusable = async () =>
  parseYaml(
    await readFile('.github/workflows/agent-automerge-reusable.yml', 'utf8'),
  ) as Workflow;

describe('agent auto-merge App identity trust boundary', () => {
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
