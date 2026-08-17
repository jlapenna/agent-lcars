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
  uses?: string;
}

interface WorkflowCallInput {
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  type?: string;
}

interface WorkflowDoc {
  name?: string;
  'run-name'?: string;
  on?: {
    workflow_call?: {
      inputs?: Record<string, WorkflowCallInput>;
      secrets?: Record<string, { required?: boolean }>;
    };
  };
  jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(file: string): { source: string; doc: WorkflowDoc } {
  const source = readFileSync(path.join(workflowsDirectory, file), 'utf8');
  return { source, doc: parseYaml(source) as WorkflowDoc };
}

/** The reusable lane workflow file each thin caller must delegate to
 * (#1312 U1): the caller keeps run-name/dispatch inputs/permissions, the
 * lane keeps the worker job. Same-repo relative `uses:` so a dispatched
 * ref stays coherent with its own lane bytes. */
function laneWorkflowFile(pipeline: string): string {
  return `agent-lane-${pipeline}.yml`;
}

/** Resolve a pipeline's worker job through the thin caller's `uses:`
 * indirection: the caller declares `jobs.<pipeline>` as a reusable call of
 * the lane workflow, and the lane declares the worker job under the same
 * pipeline id with the lane-data `env:` block. */
function resolveWorkerLane(pipeline: string): {
  callerSource: string;
  laneSource: string;
  laneDoc: WorkflowDoc;
  env: Record<string, string | number | boolean>;
} {
  const contract =
    PIPELINE_CONTRACTS[pipeline as keyof typeof PIPELINE_CONTRACTS];
  const { source: callerSource, doc: callerDoc } = loadWorkflow(
    contract.workflowFile,
  );
  const callerJob = callerDoc.jobs?.[pipeline];
  if (!callerJob) {
    throw new Error(
      `${contract.workflowFile} must declare its worker job under the ` +
        `pipeline id "${pipeline}" (jobs.${pipeline}) — this contract test ` +
        `addresses the worker job by that name`,
    );
  }
  expect(callerJob.uses).toBe(
    `./.github/workflows/${laneWorkflowFile(pipeline)}`,
  );

  const { source: laneSource, doc: laneDoc } = loadWorkflow(
    laneWorkflowFile(pipeline),
  );
  const laneJob = laneDoc.jobs?.[pipeline];
  if (!laneJob) {
    throw new Error(
      `${laneWorkflowFile(pipeline)} must declare its worker job under the ` +
        `pipeline id "${pipeline}" (jobs.${pipeline})`,
    );
  }
  return { callerSource, laneSource, laneDoc, env: laneJob.env ?? {} };
}

describe('worker workflow <-> dispatch-contracts registry', () => {
  it('registers exactly the lane workflow files that exist on disk', () => {
    for (const pipeline of DISPATCH_PIPELINES) {
      const { workflowFile } = PIPELINE_CONTRACTS[pipeline];
      expect(WORKER_WORKFLOW_FILES.has(workflowFile)).toBe(true);
      // Throws ENOENT — with the missing path in the message — if the
      // registry names a workflow file that does not exist.
      readFileSync(path.join(workflowsDirectory, workflowFile), 'utf8');
      // The reusable lane the thin caller delegates to must exist too.
      readFileSync(
        path.join(workflowsDirectory, laneWorkflowFile(pipeline)),
        'utf8',
      );
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
      const { env } = resolveWorkerLane(pipeline);

      expect(doc.name).toBe(`${contract.displayName} Issue Agent`);
      expect(env.AGENT_NAME).toBe(contract.displayName);
      expect(env.WORKER_WORKFLOW).toBe(contract.workflowFile);
      expect(env.AGENT_LABEL).toBe(contract.label);
      expect(env.REDISPATCH_COMMAND).toBe(contract.redispatchCommand);
    },
  );

  it.each(DISPATCH_PIPELINES)(
    '%s: git/bot identity is the registry botLogin or the fleet login',
    (pipeline) => {
      const contract = PIPELINE_CONTRACTS[pipeline];
      const { env, callerSource, laneSource } = resolveWorkerLane(pipeline);

      // A lane pushes either under its own registered bot login (codex and
      // opencode inline `agent-lcars[bot]`) or under the fleet App identity
      // — resolved through the reusable lane's `agent-fleet-login` input,
      // which every caller fills from its own AGENT_FLEET_LOGIN repo
      // variable (claude). Any other literal here is an unregistered
      // identity.
      expect(['${{ inputs.agent-fleet-login }}', contract.botLogin]).toContain(
        env.AGENT_GIT_LOGIN,
      );

      // The registered botLogin must appear on the workflow side — in the
      // reusable lane (AGENT_GIT_LOGIN for the app-token lanes, and
      // claude's `allowed_bots:` actor allowlist) or the thin caller.
      expect(callerSource + laneSource).toContain(contract.botLogin);
    },
  );

  it('lane workflows name no bot identity the registry does not declare', () => {
    // REST-shaped `x[bot]` literals anywhere in a lane workflow or its
    // reusable lane (env values, allowlists, even doc comments) must be
    // identities the registry knows: a lane's own botLogin
    // (AGENT_BOT_LOGINS) or github-actions[bot], the platform actor of
    // workflow_dispatch runs. This is the drift guard for adding a lane or
    // rotating an identity without updating libs/dispatch-contracts.
    const registered = new Set([...AGENT_BOT_LOGINS, 'github-actions[bot]']);
    const unregistered: string[] = [];
    for (const pipeline of DISPATCH_PIPELINES) {
      const { workflowFile } = PIPELINE_CONTRACTS[pipeline];
      for (const file of [workflowFile, laneWorkflowFile(pipeline)]) {
        const { source } = loadWorkflow(file);
        const literals = new Set(
          [...source.matchAll(/[A-Za-z0-9-]+\[bot\]/gu)].map(
            (match) => match[0],
          ),
        );
        for (const login of literals) {
          if (!registered.has(login)) {
            unregistered.push(`${file}: ${login}`);
          }
        }
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('agent-automerge admits PR authors by AGENT_BOT_LOGINS membership through the reusable', () => {
    // The AGENT_BOT_LOGINS *repo variable* is deployment configuration that
    // cannot import the registry; pipelines.spec.ts pins the code-side
    // array's exact value, and this pins the consumption points across the
    // #1312 U4 split: the thin caller (agent-automerge.yml) feeds the repo
    // variable into the published reusable's bot-logins input, and inside
    // the reusable both automerge jobs gate on JSON-array membership of
    // the PR author, with the shell-side author gates receiving the same
    // list.
    const caller = loadWorkflow('agent-automerge.yml');
    expect(caller.source).toContain(
      'uses: ./.github/workflows/agent-automerge-reusable.yml',
    );
    expect(caller.source).toMatch(
      /bot-logins:\s+\$\{\{ vars\.AGENT_BOT_LOGINS \}\}/u,
    );

    const { source, doc } = loadWorkflow('agent-automerge-reusable.yml');
    const membership =
      'contains(fromJSON(inputs.bot-logins), github.event.pull_request.user.login)';
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
      /AGENT_BOT_LOGINS:\s+\$\{\{ inputs\.bot-logins \}\}/u,
    );
  });
});

// ---------------------------------------------------------------------------
// Published reusable lane surface (#1312 U1). These three workflows are
// consumed cross-repo (homelab, sprinkles) the way the published composite
// actions are, so their `on.workflow_call` input/secret surface is guarded
// exactly like published-actions.contract.test.mjs guards action.yml
// surfaces: removing/renaming an input or secret, flipping optional ->
// required, or changing a default is a breaking change for consumers and
// must be a deliberate edit to this manifest, called out in review.

interface InputSpec {
  required: boolean;
  type: string;
  default?: string | number | boolean;
}

/** Inputs shared by all three lanes. */
const COMMON_LANE_INPUTS: Record<string, InputSpec> = {
  issue: { required: true, type: 'string' },
  mode: { required: true, type: 'string' },
  reply: { required: false, type: 'string', default: '' },
  runbook: { required: false, type: 'string', default: '' },
  context: { required: false, type: 'string', default: '' },
  'broker-generation': { required: false, type: 'string', default: '' },
  'broker-intent-id': { required: false, type: 'string', default: '' },
  'runs-on-label': { required: true, type: 'string' },
  'job-timeout-minutes': { required: false, type: 'number', default: 90 },
  'agent-timeout-minutes': { required: false, type: 'number', default: 60 },
  'dispatch-bootstrap': { required: false, type: 'boolean', default: false },
  'protected-snapshot': { required: false, type: 'boolean', default: false },
  'install-workspace-deps': {
    required: false,
    type: 'boolean',
    default: false,
  },
  'telemetry-workload-identity-provider': {
    required: false,
    type: 'string',
    default: '',
  },
  'telemetry-service-account': { required: false, type: 'string', default: '' },
  'agent-fleet-login': { required: true, type: 'string' },
  'maintainer-login': { required: true, type: 'string' },
  'agent-lcars-client-id': { required: true, type: 'string' },
  'nx-cache-url': { required: false, type: 'string', default: '' },
  'pnpm-store-dir': { required: false, type: 'string', default: '' },
  'brief-budget-minutes': { required: false, type: 'string', default: '60' },
  'brief-artifact-checkpoint-minutes': {
    required: false,
    type: 'string',
    default: '25',
  },
  'brief-finalize-checkpoint-minutes': {
    required: false,
    type: 'string',
    default: '45',
  },
  prompt: { required: true, type: 'string' },
  'no-deliverable-reason': { required: true, type: 'string' },
  'message-prefix': { required: false, type: 'string', default: '' },
};

const COMMON_LANE_SECRETS: Record<string, { required: boolean }> = {
  AGENT_LCARS_PRIVATE_KEY: { required: true },
  NX_CACHE_TOKEN: { required: false },
  AGENT_CI_RERUN_TOKEN: { required: false },
};

const LANE_SURFACES: Record<
  string,
  {
    inputs: Record<string, InputSpec>;
    secrets: Record<string, { required: boolean }>;
  }
> = {
  claude: {
    inputs: {
      ...COMMON_LANE_INPUTS,
      'max-turns': { required: false, type: 'number', default: 200 },
      'long-run-budget': { required: false, type: 'boolean', default: false },
      'gcp-auth': { required: false, type: 'boolean', default: false },
      'gcp-workload-identity-provider': {
        required: false,
        type: 'string',
        default: '',
      },
      'gcp-service-account': { required: false, type: 'string', default: '' },
    },
    secrets: {
      ...COMMON_LANE_SECRETS,
      CLAUDE_CODE_OAUTH_TOKEN: { required: true },
    },
  },
  codex: {
    inputs: {
      ...COMMON_LANE_INPUTS,
      'queue-drain': { required: false, type: 'boolean', default: false },
      'gcp-workload-identity-provider': { required: true, type: 'string' },
      'gcp-service-account': { required: true, type: 'string' },
      'gcp-project-id': { required: true, type: 'string' },
      'codex-auth-secret-name': {
        required: false,
        type: 'string',
        default: 'CODEX_AUTH_JSON',
      },
      'gcp-access-verify-projects': {
        required: false,
        type: 'string',
        default: '',
      },
    },
    secrets: { ...COMMON_LANE_SECRETS },
  },
  opencode: {
    inputs: {
      ...COMMON_LANE_INPUTS,
      'trajectory-export': { required: false, type: 'boolean', default: false },
      'gcp-auth': { required: false, type: 'boolean', default: false },
      'gcp-workload-identity-provider': {
        required: false,
        type: 'string',
        default: '',
      },
      'gcp-service-account': { required: false, type: 'string', default: '' },
      'opencode-model': { required: true, type: 'string' },
    },
    secrets: {
      ...COMMON_LANE_SECRETS,
      OPENCODE_LLM_API_KEY: { required: true },
    },
  },
};

describe('published reusable lane workflow surface (#1312)', () => {
  it.each(DISPATCH_PIPELINES)(
    'agent-lane-%s.yml: workflow_call input surface matches the manifest',
    (pipeline) => {
      const { doc } = loadWorkflow(laneWorkflowFile(pipeline));
      const declared = doc.on?.workflow_call?.inputs ?? {};
      const expected = LANE_SURFACES[pipeline].inputs;

      expect(Object.keys(declared).sort()).toEqual(
        Object.keys(expected).sort(),
      );
      for (const [name, spec] of Object.entries(expected)) {
        const input = declared[name];
        expect(
          {
            name,
            required: input.required ?? false,
            type: input.type,
            default: input.default,
          },
          `agent-lane-${pipeline}.yml input "${name}"`,
        ).toEqual({
          name,
          required: spec.required,
          type: spec.type,
          default: spec.default,
        });
      }
    },
  );

  it.each(DISPATCH_PIPELINES)(
    'agent-lane-%s.yml: workflow_call secret surface matches the manifest',
    (pipeline) => {
      const { doc } = loadWorkflow(laneWorkflowFile(pipeline));
      const declared = doc.on?.workflow_call?.secrets ?? {};
      const expected = LANE_SURFACES[pipeline].secrets;

      expect(Object.keys(declared).sort()).toEqual(
        Object.keys(expected).sort(),
      );
      for (const [name, spec] of Object.entries(expected)) {
        expect(
          declared[name].required ?? false,
          `agent-lane-${pipeline}.yml secret "${name}" requiredness`,
        ).toBe(spec.required);
      }
    },
  );
});
