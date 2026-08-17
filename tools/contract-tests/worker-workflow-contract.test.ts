import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// Imported, not re-derived: `libs/dispatch-contracts` is the fleet's one
// definition of how each agent lane is named (pipelines.ts) and of the
// dispatch marker the orchestrator uses to rebind a run to its attempt
// (marker.ts). The worker workflow YAMLs cannot import that registry, so
// this test pins the two together the way the deleted broker's
// workflow-contract.spec.ts used to (#1298): every expected value below is
// computed from the registry, never hand-copied from the YAML.
import { formatDispatchMarker } from '../../libs/dispatch-contracts/src/marker';
import {
  AGENT_BOT_LOGINS,
  DISPATCH_PIPELINES,
  PIPELINE_CONTRACTS,
  WORKER_WORKFLOW_FILES,
} from '../../libs/dispatch-contracts/src/pipelines';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowsDirectory = path.join(repoRoot, '.github/workflows');

interface WorkflowJob {
  if?: string;
  env?: Record<string, string | number | boolean>;
}

interface WorkflowDoc {
  name?: string;
  'run-name'?: string;
  jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(file: string): { source: string; doc: WorkflowDoc } {
  const source = readFileSync(path.join(workflowsDirectory, file), 'utf8');
  return { source, doc: parseYaml(source) as WorkflowDoc };
}

/** The worker job's lane-data `env:` block, keyed by the pipeline's own id —
 * each lane workflow declares exactly one worker job named after its
 * pipeline (`jobs.claude`, `jobs.codex`, `jobs.opencode`). */
function laneEnv(
  doc: WorkflowDoc,
  pipeline: string,
  workflowFile: string,
): Record<string, string | number | boolean> {
  const job = doc.jobs?.[pipeline];
  if (!job) {
    throw new Error(
      `${workflowFile} must declare its worker job under the pipeline id ` +
        `"${pipeline}" (jobs.${pipeline}) — this contract test addresses ` +
        `the worker job by that name`,
    );
  }
  return job.env ?? {};
}

describe('worker workflow <-> dispatch-contracts registry', () => {
  it('registers exactly the lane workflow files that exist on disk', () => {
    for (const pipeline of DISPATCH_PIPELINES) {
      const { workflowFile } = PIPELINE_CONTRACTS[pipeline];
      expect(WORKER_WORKFLOW_FILES.has(workflowFile)).toBe(true);
      // Throws ENOENT — with the missing path in the message — if the
      // registry names a workflow file that does not exist.
      readFileSync(path.join(workflowsDirectory, workflowFile), 'utf8');
    }
  });

  it.each(DISPATCH_PIPELINES)(
    '%s: run-name carries the issue join key, the registry run-name label, and the dispatch marker',
    (pipeline) => {
      const contract = PIPELINE_CONTRACTS[pipeline];
      const { doc } = loadWorkflow(contract.workflowFile);

      // The exact template GitHub renders into display_title. The leading
      // `#<issue>: ` is the console's issue join key
      // (run-name-console-join.test.ts proves the parse direction); the
      // trailing marker is rendered by the same formatDispatchMarker the
      // orchestrator uses to rebind a run after a lost dispatch response —
      // marker.ts accepts the literal `${{ ... }}` expression strings for
      // exactly this assertion.
      const expectedRunName =
        '#${{ inputs.issue }}: ' +
        contract.runNameLabel +
        ' ' +
        formatDispatchMarker({
          generation: '${{ inputs.broker_generation }}',
          intentId: '${{ inputs.broker_intent_id }}',
        });
      expect(doc['run-name']).toBe(expectedRunName);
    },
  );

  it.each(DISPATCH_PIPELINES)(
    '%s: lane env block restates the registry contract values',
    (pipeline) => {
      const contract = PIPELINE_CONTRACTS[pipeline];
      const { doc } = loadWorkflow(contract.workflowFile);
      const env = laneEnv(doc, pipeline, contract.workflowFile);

      expect(doc.name).toBe(`${contract.displayName} Issue Agent`);
      expect(env.AGENT_NAME).toBe(contract.displayName);
      expect(env.WORKER_WORKFLOW).toBe(contract.workflowFile);
      expect(env.AGENT_LABEL).toBe(contract.label);
      expect(env.REDISPATCH_COMMAND).toBe(contract.redispatchCommand);
    },
  );

  it.each(DISPATCH_PIPELINES)(
    '%s: git/bot identity is the registry botLogin or the fleet login variable',
    (pipeline) => {
      const contract = PIPELINE_CONTRACTS[pipeline];
      const { source, doc } = loadWorkflow(contract.workflowFile);
      const env = laneEnv(doc, pipeline, contract.workflowFile);

      // A lane pushes either under its own registered bot login (codex and
      // opencode inline `agent-lcars[bot]`) or under the fleet App identity
      // resolved from the AGENT_FLEET_LOGIN repo variable (claude). Any
      // other literal here is an unregistered identity.
      expect(['${{ vars.AGENT_FLEET_LOGIN }}', contract.botLogin]).toContain(
        env.AGENT_GIT_LOGIN,
      );

      // The registered botLogin must appear in the lane's own workflow —
      // as AGENT_GIT_LOGIN for the app-token lanes, and in claude.yml's
      // `allowed_bots:` actor allowlist (its AGENT_GIT_LOGIN is the fleet
      // variable, so without this the claude botLogin would be pinned
      // nowhere on the workflow side).
      expect(source).toContain(contract.botLogin);
    },
  );

  it('lane workflows name no bot identity the registry does not declare', () => {
    // REST-shaped `x[bot]` literals anywhere in a lane workflow (env
    // values, allowlists, even doc comments) must be identities the
    // registry knows: a lane's own botLogin (AGENT_BOT_LOGINS) or
    // github-actions[bot], the platform actor of workflow_dispatch runs.
    // This is the drift guard for adding a lane or rotating an identity
    // without updating libs/dispatch-contracts.
    const registered = new Set([...AGENT_BOT_LOGINS, 'github-actions[bot]']);
    const unregistered: string[] = [];
    for (const pipeline of DISPATCH_PIPELINES) {
      const { workflowFile } = PIPELINE_CONTRACTS[pipeline];
      const { source } = loadWorkflow(workflowFile);
      const literals = new Set(
        [...source.matchAll(/[A-Za-z0-9-]+\[bot\]/gu)].map((match) => match[0]),
      );
      for (const login of literals) {
        if (!registered.has(login)) {
          unregistered.push(`${workflowFile}: ${login}`);
        }
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('agent-automerge.yml admits PR authors by AGENT_BOT_LOGINS membership', () => {
    // The AGENT_BOT_LOGINS *repo variable* is deployment configuration that
    // cannot import the registry; pipelines.spec.ts pins the code-side
    // array's exact value, and this pins the consumption points: both
    // automerge jobs gate on JSON-array membership of the PR author, and
    // the shell-side author gate receives the same variable.
    const { source, doc } = loadWorkflow('agent-automerge.yml');
    const membership =
      'contains(fromJSON(vars.AGENT_BOT_LOGINS), github.event.pull_request.user.login)';
    const admissionGates = Object.fromEntries(
      ['automerge', 'restore-main-checks'].map((job) => [
        job,
        doc.jobs?.[job]?.if?.includes(membership) ?? false,
      ]),
    );
    expect(admissionGates).toEqual({
      automerge: true,
      'restore-main-checks': true,
    });
    expect(source).toMatch(
      /AGENT_BOT_LOGINS:\s+\$\{\{ vars\.AGENT_BOT_LOGINS \}\}/u,
    );
  });
});
