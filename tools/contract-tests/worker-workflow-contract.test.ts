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
  steps?: Array<{
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, string | number | boolean>;
  }>;
  uses?: string;
  with?: Record<string, string | number | boolean>;
  secrets?: Record<string, string>;
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

/** The published reusable lane shim each thin caller must delegate to
 * (#1312 U1): the caller keeps run-name/dispatch inputs/permissions, the
 * shim keeps the published `workflow_call` surface. Same-repo relative
 * `uses:` so a dispatched ref stays coherent with its own lane bytes. */
function laneWorkflowFile(pipeline: string): string {
  return `agent-lane-${pipeline}.yml`;
}

/** The single parameterized worker lane every shim delegates to
 * (#1340 A-R1), carrying the one worker job (`jobs.agent`) behind a
 * required `pipeline` input. */
const UNIFIED_LANE_FILE = 'agent-lane.yml';

/** Resolve a raw expression string from agent-lane.yml's job `env:` block
 * for one pipeline. The unified lane keys its per-pipeline identity
 * values off `inputs.pipeline` with exactly two expression shapes:
 * `fromJSON('<map>')[inputs.pipeline]` and the claude-vs-bot ternary for
 * AGENT_GIT_LOGIN. Anything else passes through verbatim, so a new
 * expression shape fails the equality assertions loudly instead of being
 * silently "resolved". */
function resolveLaneExpression(
  raw: string | number | boolean | undefined,
  pipeline: string,
): string | undefined {
  if (typeof raw !== 'string') {
    return raw === undefined ? undefined : String(raw);
  }
  const fromJsonMap = raw.match(
    /^\$\{\{\s*fromJSON\('(?<map>.+)'\)\[inputs\.pipeline\]\s*\}\}$/u,
  );
  if (fromJsonMap?.groups) {
    const map = JSON.parse(fromJsonMap.groups.map) as Record<string, string>;
    expect(
      Object.keys(map).sort(),
      `agent-lane.yml env map "${raw}" covers exactly the registry pipelines`,
    ).toEqual([...DISPATCH_PIPELINES].sort());
    return map[pipeline];
  }
  const pipelineTernary = raw.match(
    /^\$\{\{\s*inputs\.pipeline == '(?<pipeline>[a-z]+)' && inputs\.(?<input>[a-z-]+) \|\| '(?<fallback>[^']+)'\s*\}\}$/u,
  );
  if (pipelineTernary?.groups) {
    return pipeline === pipelineTernary.groups.pipeline
      ? `\${{ inputs.${pipelineTernary.groups.input} }}`
      : pipelineTernary.groups.fallback;
  }
  return raw;
}

/** Resolve a pipeline's worker job through both layers of `uses:`
 * indirection: the caller declares `jobs.<pipeline>` as a reusable call
 * of the published shim, the shim declares `jobs.<pipeline>` as a call of
 * the unified lane with `pipeline: <pipeline>`, and the unified lane
 * declares the one worker job (`jobs.agent`) whose `env:` block resolves
 * the lane-data values from `inputs.pipeline`. */
function resolveWorkerLane(pipeline: string): {
  callerSource: string;
  laneSource: string;
  laneDoc: WorkflowDoc;
  env: Record<string, string | undefined>;
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

  const { source: shimSource, doc: shimDoc } = loadWorkflow(
    laneWorkflowFile(pipeline),
  );
  const shimJob = shimDoc.jobs?.[pipeline];
  if (!shimJob) {
    throw new Error(
      `${laneWorkflowFile(pipeline)} must declare its delegating job under ` +
        `the pipeline id "${pipeline}" (jobs.${pipeline})`,
    );
  }
  expect(shimJob.uses).toBe(`./.github/workflows/${UNIFIED_LANE_FILE}`);
  expect(shimJob.with?.pipeline).toBe(pipeline);

  const { source: unifiedSource, doc: unifiedDoc } =
    loadWorkflow(UNIFIED_LANE_FILE);
  const unifiedJob = unifiedDoc.jobs?.agent;
  if (!unifiedJob) {
    throw new Error(
      `${UNIFIED_LANE_FILE} must declare its worker job as jobs.agent`,
    );
  }
  const env = Object.fromEntries(
    Object.entries(unifiedJob.env ?? {}).map(([name, raw]) => [
      name,
      resolveLaneExpression(raw, pipeline),
    ]),
  );
  return {
    callerSource,
    laneSource: shimSource + unifiedSource,
    laneDoc: unifiedDoc,
    env,
  };
}

describe('worker workflow <-> dispatch-contracts registry', () => {
  it('registers exactly the lane workflow files that exist on disk', () => {
    for (const pipeline of DISPATCH_PIPELINES) {
      const { workflowFile } = PIPELINE_CONTRACTS[pipeline];
      expect(WORKER_WORKFLOW_FILES.has(workflowFile)).toBe(true);
      // Throws ENOENT — with the missing path in the message — if the
      // registry names a workflow file that does not exist.
      readFileSync(path.join(workflowsDirectory, workflowFile), 'utf8');
      // The reusable lane shim the thin caller delegates to must exist too.
      readFileSync(
        path.join(workflowsDirectory, laneWorkflowFile(pipeline)),
        'utf8',
      );
    }
    // As must the single parameterized lane the shims delegate to.
    readFileSync(path.join(workflowsDirectory, UNIFIED_LANE_FILE), 'utf8');
  });

  it.each(DISPATCH_PIPELINES)(
    '%s: run-name carries the issue join key, the registry run-name label, and the dispatch marker',
    (pipeline) => {
      const contract = PIPELINE_CONTRACTS[pipeline];
      const { doc } = loadWorkflow(contract.workflowFile);

      // The exact template GitHub renders into display_title. The leading
      // ternary renders `#<issue>: ` for an issue-anchored dispatch or a
      // plain `native work: ` fallback for a native `work` dispatch
      // (Plan 3 native-lane task 2 - GitHub expressions can't `fromJSON`
      // an empty string safely, so the fallback is a literal, not the
      // work item's parsed id); run-name-console-join.test.ts proves both
      // render/parse directions. The trailing marker is rendered by the
      // same formatDispatchMarker the orchestrator uses to rebind a run
      // after a lost dispatch response — marker.ts accepts the literal
      // `${{ ... }}` expression strings for exactly this assertion.
      const expectedRunName =
        "${{ inputs.issue != '' && format('#{0}', inputs.issue) || 'native work' }}: " +
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
    const files = new Set<string>([UNIFIED_LANE_FILE]);
    for (const pipeline of DISPATCH_PIPELINES) {
      const { workflowFile } = PIPELINE_CONTRACTS[pipeline];
      files.add(workflowFile);
      files.add(laneWorkflowFile(pipeline));
    }
    for (const file of files) {
      const { source } = loadWorkflow(file);
      const literals = new Set(
        [...source.matchAll(/[A-Za-z0-9-]+\[bot\]/gu)].map((match) => match[0]),
      );
      for (const login of literals) {
        if (!registered.has(login)) {
          unregistered.push(`${file}: ${login}`);
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

  it('agent-automerge retries missed events and reconciles ready bot PRs without promoting drafts', () => {
    const caller = loadWorkflow('agent-automerge.yml');
    expect(caller.source).toMatch(
      /types:\s*\[opened, reopened, synchronize, ready_for_review, labeled\]/u,
    );

    const { source, doc } = loadWorkflow('agent-automerge-reusable.yml');
    expect(doc.jobs?.automerge?.if).toContain(
      'github.event.pull_request.draft == false',
    );
    expect(doc.jobs?.automerge?.if).toContain(
      "!contains(github.event.pull_request.labels.*.name, 'status:needs-human')",
    );
    expect(doc.jobs?.['restore-main-checks']?.if).toContain(
      'github.event.pull_request.draft == false',
    );
    expect(source).not.toContain('gh pr ready "$PR"');

    const cancelParked = doc.jobs?.['cancel-parked-automerge'];
    expect(cancelParked?.if).toContain("github.event.action == 'labeled'");
    expect(cancelParked?.if).toContain(
      "github.event.label.name == 'status:needs-human'",
    );
    const cancelScript = cancelParked?.steps?.find(
      (step) => step.name === 'Disable auto-merge for the parked agent PR',
    )?.run;
    expect(cancelScript).toContain('--disable-auto');
    expect(cancelScript).toContain('.autoMergeRequest == null');

    const reconcile = doc.jobs?.['reconcile-automerge'];
    expect(reconcile?.if).toContain("github.event_name == 'schedule'");
    expect(reconcile?.if).toContain("github.event_name == 'workflow_dispatch'");
    const reconcileScript = reconcile?.steps?.find(
      (step) =>
        step.name === 'Arm ready open agent PRs missed by event delivery',
    )?.run;
    expect(reconcileScript).toContain('AGENT_BOT_LOGINS');
    expect(reconcileScript).toContain('if [ "$DRAFT" = true ]');
    expect(reconcileScript).toContain('[ "$PARKED" = true ]');
    expect(reconcileScript).toContain('--disable-auto');
    expect(reconcileScript).toContain('.autoMergeRequest == null');
    expect(reconcileScript).toContain('>"$OPEN_PRS_FILE"');
    expect(reconcileScript).toContain(
      'gh pr merge "$PR" --repo "$REPO" --auto --squash',
    );
    expect(reconcileScript).toContain('--json state,autoMergeRequest');

    const clearRequests = doc.jobs?.automerge?.steps?.find(
      (step) => step.name === 'Clear outstanding review requests',
    )?.run;
    for (const script of [clearRequests, reconcileScript]) {
      expect(script).toContain('pulls/$PR/requested_reviewers');
      expect(script).toContain('--method DELETE --input -');
      expect(script).toContain('(.users | length) == 0');
      expect(script).toContain('(.teams | length) == 0');
    }
    expect(
      reconcileScript?.indexOf('pulls/$PR/requested_reviewers'),
    ).toBeLessThan(
      reconcileScript?.indexOf(
        'gh pr merge "$PR" --repo "$REPO" --auto --squash',
      ) ?? -1,
    );
  });

  it('headless handoff forbids review requests and requires verified auto-merge', () => {
    const protocol = readFileSync(
      path.join(
        repoRoot,
        '.agents/skills/agent-protocol/reference/agent-protocol.md',
      ),
      'utf8',
    );
    expect(protocol).not.toContain(
      'Request review from `jlapenna` on every pull request you open.',
    );
    expect(protocol).toMatch(/\*\*do not request\s+human\s+review\*\*/u);
    expect(protocol).toContain(
      'gh pr merge <N> --repo <owner/repo> --auto --squash',
    );
    expect(protocol).toContain('--json state,autoMergeRequest');
    expect(protocol).toContain('.state == "MERGED"');
    expect(protocol).toMatch(
      /Leave a human-authored PR's merge\s+state\s+unchanged/u,
    );
    const localPrGuide = readFileSync(
      path.join(repoRoot, '.agents/skills/agent-lcars-dev/references/pr.md'),
      'utf8',
    );
    expect(localPrGuide).toContain('interactive, human-driven change');
    expect(localPrGuide).toContain('they do not request human');
  });

  it('§1-4 state the native rules unconditionally, with no legacy subsection (agent-lcars#1544/#1557)', () => {
    const protocol = readFileSync(
      path.join(
        repoRoot,
        '.agents/skills/agent-protocol/reference/agent-protocol.md',
      ),
      'utf8',
    );
    // The runtime.projections/anchor.type gate and the "Legacy (projections
    // off)" branch it pointed to are gone: the console claims every
    // GitHub-anchored dispatch itself now that a hand-run workflow_dispatch
    // is a retired escape hatch, so §1-4 apply to every dispatch, always.
    expect(protocol).not.toContain('runtime.projections');
    expect(protocol).not.toContain('## Legacy (projections off)');
    expect(protocol).not.toContain('## 5a. Native work items');
    expect(protocol).toContain('## 1. Takeover — your first action');
    expect(protocol).toMatch(/Skip — post nothing\./u);
    // The "Dispatch mode" table and reply-trigger recognition text used to
    // live only inside the deleted Legacy section; both still apply
    // unconditionally, so they were folded into §5 rather than deleted.
    const section5 = protocol.slice(
      protocol.indexOf('## 5. Deliverable rule'),
      protocol.indexOf('## 6. Push early'),
    );
    expect(section5).toContain('### Dispatch mode');
    expect(section5).toContain(
      '| `implement` | issue        | open a PR on a new branch',
    );
    expect(section5).toContain('`/codex`, `/opencode`, and `/oc`');
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
  work: { required: false, type: 'string', default: '' },
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
  prompt: { required: false, type: 'string', default: '' },
  'protocol-note': { required: false, type: 'string', default: '' },
  'no-deliverable-reason': { required: false, type: 'string', default: '' },
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
      'claude-token-secret': {
        required: false,
        type: 'string',
        default:
          'projects/agent-lcars/secrets/CLAUDE_CODE_OAUTH_TOKEN/versions/latest',
      },
      'claude-token-wif-provider': {
        required: false,
        type: 'string',
        default:
          'projects/611425338852/locations/global/workloadIdentityPools/github/providers/github',
      },
      'claude-token-service-account': {
        required: false,
        type: 'string',
        default: 'claude-token-reader@agent-lcars.iam.gserviceaccount.com',
      },
    },
    // No CLAUDE_CODE_OAUTH_TOKEN: the subscription token is read from
    // Secret Manager at run time (#1350), never carried by a consumer.
    secrets: { ...COMMON_LANE_SECRETS },
  },
  codex: {
    inputs: {
      ...COMMON_LANE_INPUTS,
      'queue-drain': { required: false, type: 'boolean', default: false },
      'codex-shared-lease': {
        required: false,
        type: 'boolean',
        default: true,
      },
      'gcp-workload-identity-provider': { required: true, type: 'string' },
      'gcp-service-account': { required: true, type: 'string' },
      'gcp-project-id': { required: true, type: 'string' },
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

  it('agent-lane.yml: control-plane-projections stays deleted (agent-lcars#1544/#1557)', () => {
    const { doc } = loadWorkflow(UNIFIED_LANE_FILE);
    expect(
      doc.on?.workflow_call?.inputs?.['control-plane-projections'],
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shim -> unified lane forwarding (#1340 A-R1). The three published shims
// above delegate to one parameterized lane, .github/workflows/agent-lane.yml.
// These pins prove the delegation is lossless: every input and secret a shim
// declares is forwarded verbatim into the unified lane, the unified lane
// declares exactly the union of the three shim surfaces (plus `pipeline`),
// and the values a shim requires but the union relaxes are enforced by the
// lane's own per-pipeline assertion step instead of silently defaulting.

describe('shim -> unified lane forwarding (#1340 A-R1)', () => {
  const unified = loadWorkflow(UNIFIED_LANE_FILE);
  const unifiedInputs = unified.doc.on?.workflow_call?.inputs ?? {};
  const unifiedSecrets = unified.doc.on?.workflow_call?.secrets ?? {};

  it.each(DISPATCH_PIPELINES)(
    'agent-lane-%s.yml forwards its whole declared surface, dropping nothing',
    (pipeline) => {
      const { doc } = loadWorkflow(laneWorkflowFile(pipeline));
      const declaredInputs = doc.on?.workflow_call?.inputs ?? {};
      const declaredSecrets = doc.on?.workflow_call?.secrets ?? {};
      const job = doc.jobs?.[pipeline];
      expect(job?.uses).toBe(`./.github/workflows/${UNIFIED_LANE_FILE}`);

      const withBlock = job?.with ?? {};
      expect(withBlock.pipeline).toBe(pipeline);
      for (const [name, spec] of Object.entries(declaredInputs)) {
        expect(
          withBlock[name],
          `agent-lane-${pipeline}.yml must forward input "${name}"`,
        ).toBe(`\${{ inputs.${name} }}`);
        expect(
          unifiedInputs[name]?.type,
          `${UNIFIED_LANE_FILE} must declare input "${name}" with the shim's type`,
        ).toBe(spec.type);
      }
      // Where a shim declares a default, the unified lane's default must
      // match it, so calling the unified lane directly can never behave
      // differently from calling through the shim.
      const defaultDrift = Object.entries(declaredInputs)
        .filter(([, spec]) => spec.default !== undefined)
        .filter(
          ([name, spec]) =>
            !Object.is(unifiedInputs[name]?.default, spec.default),
        )
        .map(
          ([name, spec]) =>
            `${name}: shim ${JSON.stringify(spec.default)} != ` +
            `unified ${JSON.stringify(unifiedInputs[name]?.default)}`,
        );
      expect(defaultDrift).toEqual([]);
      expect(Object.keys(withBlock).sort()).toEqual(
        ['pipeline', ...Object.keys(declaredInputs)].sort(),
      );

      const secretsBlock = job?.secrets ?? {};
      for (const name of Object.keys(declaredSecrets)) {
        expect(
          secretsBlock[name],
          `agent-lane-${pipeline}.yml must forward secret "${name}"`,
        ).toBe(`\${{ secrets.${name} }}`);
        expect(
          unifiedSecrets[name],
          `${UNIFIED_LANE_FILE} must declare secret "${name}"`,
        ).toBeDefined();
      }
      expect(Object.keys(secretsBlock).sort()).toEqual(
        Object.keys(declaredSecrets).sort(),
      );
    },
  );

  it('agent-lane.yml declares exactly the union of the shim surfaces plus pipeline', () => {
    const unionInputs = new Set(['pipeline']);
    const unionSecrets = new Set<string>();
    for (const pipeline of DISPATCH_PIPELINES) {
      const { doc } = loadWorkflow(laneWorkflowFile(pipeline));
      for (const name of Object.keys(doc.on?.workflow_call?.inputs ?? {})) {
        unionInputs.add(name);
      }
      for (const name of Object.keys(doc.on?.workflow_call?.secrets ?? {})) {
        unionSecrets.add(name);
      }
    }
    expect(Object.keys(unifiedInputs).sort()).toEqual([...unionInputs].sort());
    expect(Object.keys(unifiedSecrets).sort()).toEqual(
      [...unionSecrets].sort(),
    );
    expect(unifiedInputs.pipeline).toMatchObject({
      required: true,
      type: 'string',
    });
  });

  it('one-shim-required values stay optional at the union layer and are asserted per pipeline', () => {
    // codex's WIF trio and opencode's model are required by their own shim
    // but optional (empty default) in the union; the unified lane's
    // "Assert pipeline lane configuration" step enforces them for the
    // active pipeline, together with the per-pipeline secrets that the
    // union layer cannot mark required.
    for (const name of [
      'gcp-workload-identity-provider',
      'gcp-service-account',
      'gcp-project-id',
      'opencode-model',
    ]) {
      expect(
        {
          name,
          required: unifiedInputs[name]?.required ?? false,
          default: unifiedInputs[name]?.default,
        },
        `agent-lane.yml input "${name}"`,
      ).toEqual({ name, required: false, default: '' });
    }
    expect(unifiedSecrets.AGENT_LCARS_PRIVATE_KEY?.required).toBe(true);
    expect(unifiedSecrets.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(unifiedSecrets.OPENCODE_LLM_API_KEY?.required ?? false).toBe(false);
    expect(unified.source).toContain('Assert pipeline lane configuration');
    for (const value of [
      'input gcp-workload-identity-provider',
      'input gcp-service-account',
      'input gcp-project-id',
      'input opencode-model',
      'input claude-token-secret',
      'input claude-token-wif-provider',
      'input claude-token-service-account',
      'secret OPENCODE_LLM_API_KEY',
    ]) {
      expect(unified.source, `assert step must name "${value}"`).toContain(
        value,
      );
    }
  });

  it('uses the canonical telemetry identity when a caller omits or empties repo variables', () => {
    const job = unified.doc.jobs?.agent;
    expect(job?.env).toMatchObject({
      FLEET_TELEMETRY_WIF_PROVIDER:
        'projects/611425338852/locations/global/workloadIdentityPools/github/providers/github',
      FLEET_TELEMETRY_SERVICE_ACCOUNT:
        'telemetry-writer@agent-lcars.iam.gserviceaccount.com',
    });

    const local = job?.steps?.find(
      (step) => step.name === 'Start telemetry sidecar',
    );
    const published = job?.steps?.find(
      (step) => step.name === 'Start telemetry sidecar (published)',
    );
    for (const step of [local, published]) {
      expect(step?.with?.['workload-identity-provider']).toBe(
        '${{ inputs.telemetry-workload-identity-provider || env.FLEET_TELEMETRY_WIF_PROVIDER }}',
      );
      expect(step?.with?.['service-account']).toBe(
        '${{ inputs.telemetry-service-account || env.FLEET_TELEMETRY_SERVICE_ACCOUNT }}',
      );
    }
    expect(published?.if).toBe('always() && !inputs.dispatch-bootstrap');
  });

  it.each(DISPATCH_PIPELINES)(
    '%s.yml: opts into the dispatch-bootstrap era, with control-plane-projections gone (agent-lcars#1544/#1557)',
    (pipeline) => {
      const contract = PIPELINE_CONTRACTS[pipeline];
      const { doc } = loadWorkflow(contract.workflowFile);
      const callerJob = doc.jobs?.[pipeline];
      expect(
        callerJob?.with?.['dispatch-bootstrap'],
        `${contract.workflowFile} must pass dispatch-bootstrap: true to its shim`,
      ).toBe(true);
      // The provenance-derivation rule this test used to pin
      // (jlapenna/homelab#906: `work` != '' as proof the console made this
      // dispatch, not a hand-run workflow_dispatch) is moot now that the
      // input itself is gone: a hand-run dispatch is a retired escape
      // hatch by policy, and the console claims every GitHub-anchored
      // dispatch itself regardless of how it got triggered.
      expect(
        callerJob?.with?.['control-plane-projections'],
        `${contract.workflowFile} must not pass control-plane-projections (legacy claim path removed)`,
      ).toBeUndefined();
    },
  );
});
