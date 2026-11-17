import 'server-only';

import { createHash } from 'node:crypto';

import {
  isRefusal,
  type Orchestrator,
  type OrchestratorStore,
  workRevisionSchema,
} from '@agent-lcars/orchestrator';
import {
  type AgentRunBrief,
  agentWorkSpecSchema,
  CLAW_RUNTIME_PIPELINE,
  storedWorkPayloadSchema,
  ulid,
  WORK_TITLE_MAX,
} from '@agent-lcars/work';
import { z } from 'zod';

import type { DispatchTokenProvider } from './github-app-tokens';
import {
  type AgentDefinition,
  agentDigest,
  agentId,
  agentKey,
} from './repository-agent-definition';
import type { AgentStore } from './repository-agent-store';
import { openRepositorySource } from './repository-source';

/** An operator-owned agent profile (docs/repository-agents.md). It names the
 * executor runtime that holds the agent's credentials and which repositories'
 * agents may use it. Repository content can never create one. */
export const agentProfileSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  runtime: z.string().regex(CLAW_RUNTIME_PIPELINE),
  repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/u)).min(1),
  /** Principals that may run these agents; omitted means any principal whose
   * grant covers the runtime. */
  principals: z.array(z.string().min(1)).optional(),
  /** Whether a dispatched run may invoke these agents with its run token
   * (`lcars investigate`), as `run:<runId>`. Off unless the operator opts in. */
  runCallers: z.boolean().optional(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/** The profile an agent without `profile` uses: the shared executor's
 * `claw-default` runtime, which mounts only a model key. */
export const DEFAULT_AGENT_PROFILE = 'default';
export const DEFAULT_AGENT_RUNTIME = 'claw-default';

export function agentProfiles(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentProfile[] {
  const profiles = z
    .array(agentProfileSchema)
    .parse(JSON.parse(env['AGENT_LCARS_AGENT_PROFILES'] ?? '[]'));
  if (new Set(profiles.map((profile) => profile.name)).size !== profiles.length)
    throw new Error('Agent profile names must be unique');
  if (profiles.some((profile) => profile.name === DEFAULT_AGENT_PROFILE))
    throw new Error('The default agent profile is built in');
  return profiles;
}

/** The round's pinned definition and message, stored as its revision input. */
const agentRoundSchema = z.strictObject({
  agent: z.string(),
  revision: z.string(),
  digest: z.string(),
  requireToolEvidence: z.boolean(),
  /** The admitted definition's retry policy, pinned with the round so a
   * coalesced successor runs under its own round's policy. */
  retry: z.enum(['finite', 'terminal']).optional(),
  message: z.string().min(1),
  requestId: z.string().optional(),
});
export type AgentRound = z.infer<typeof agentRoundSchema>;

/** Refusals a caller can act on. */
export class AgentAdmissionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

export interface AgentAdmissionDeps {
  store: OrchestratorStore;
  orchestrator: Orchestrator;
  agents: AgentStore;
  profiles: () => AgentProfile[];
  /** Whether the caller may admit work on the resolved runtime: a principal's
   * grant must list the pipeline; a dispatched run needs a profile that opts
   * in to run callers. */
  mayAdmit: (runtime: ResolvedAgentRuntime) => boolean;
}

export interface ResolvedAgentRuntime {
  pipeline: string;
  /** The profile admits dispatched runs as callers. */
  runCallers: boolean;
}

/** Resolve the runtime an agent runs on, refusing a profile that does not
 * admit its repository or the caller. */
export function resolveAgentRuntime(
  definition: AgentDefinition,
  principal: string,
  profiles: readonly AgentProfile[],
): ResolvedAgentRuntime {
  const name = definition.manifest.profile ?? DEFAULT_AGENT_PROFILE;
  if (name === DEFAULT_AGENT_PROFILE)
    return { pipeline: DEFAULT_AGENT_RUNTIME, runCallers: false };
  const profile = profiles.find((candidate) => candidate.name === name);
  if (!profile)
    throw new AgentAdmissionError('FORBIDDEN', `Unknown agent profile ${name}`);
  if (!profile.repositories.includes(definition.repository))
    throw new AgentAdmissionError(
      'FORBIDDEN',
      `Profile ${name} does not admit ${definition.repository}`,
    );
  if (profile.principals && !profile.principals.includes(principal))
    throw new AgentAdmissionError(
      'FORBIDDEN',
      `Profile ${name} does not admit ${principal}`,
    );
  return { pipeline: profile.runtime, runCallers: profile.runCallers === true };
}

/** Admit one round of a repository-owned agent. Like investigations, a
 * caller's `sourceKey` resolves to one stable Work item, the round's input is
 * immutable, the same input is the same round and a new one supersedes a
 * queued round. The round pins the enabled definition at admission, so a
 * later merge never changes an admitted round. */
export async function admitAgentRun(
  deps: AgentAdmissionDeps,
  request: {
    repository: string;
    name: string;
    message: string;
    requestId?: string;
    sourceKey?: string;
    principal: string;
  },
): Promise<{ workId: string; duplicate: boolean }> {
  const id = agentId(request.repository, request.name);
  const agent = await deps.agents.read(
    agentKey(request.repository, request.name),
  );
  if (!agent?.enabled || agent.definition === undefined)
    throw new AgentAdmissionError(
      'NOT_FOUND',
      agent?.error
        ? `Agent ${id} is disabled: ${agent.error}`
        : `No enabled agent ${id}`,
    );
  const definition = agent.definition;
  const runtime = resolveAgentRuntime(
    definition,
    request.principal,
    deps.profiles(),
  );
  const { pipeline } = runtime;
  if (!deps.mayAdmit(runtime))
    throw new AgentAdmissionError(
      'FORBIDDEN',
      `${request.principal} may not run agents on ${pipeline}`,
    );
  const sourceKey = request.sourceKey ?? `adhoc:${request.requestId ?? ulid()}`;
  // Keys are scoped to the agent and the caller: one caller's key never
  // resolves to, supersedes or reads another caller's work.
  const workId = await deps.store.resolveSourceWorkId(
    `agent:${id}:${request.principal}:${sourceKey}`,
    ulid(),
  );
  const round: AgentRound = agentRoundSchema.parse({
    agent: id,
    revision: definition.revision,
    digest: definition.digest,
    requireToolEvidence: definition.manifest.requireToolEvidence ?? false,
    retry: definition.manifest.retry ?? 'finite',
    message: request.message,
    ...(request.requestId === undefined
      ? {}
      : { requestId: request.requestId }),
  });
  // A request id is an idempotency key: it alone names the round, so a
  // replay returns the round it first admitted (even after the definition
  // changed) and a different message under it is a conflict. Without one, the
  // definition digest and message name the round, and a sourceKey coalesces.
  const key = createHash('sha256')
    .update(
      JSON.stringify(
        // The original key for rounds without a request id, so receipts
        // admitted before request ids became idempotency keys still replay.
        round.requestId === undefined
          ? [round.digest, round.message, null]
          : ['request', round.requestId],
      ),
    )
    .digest('hex');
  const revision = workRevisionSchema.parse({ key, input: round });
  const title = `${id}: ${request.message.split('\n')[0]}`;
  const spec = agentWorkSpecSchema.parse({
    title:
      title.length <= WORK_TITLE_MAX
        ? title
        : `${title.slice(0, WORK_TITLE_MAX - 1)}…`,
    description: `Run of repository-owned agent ${id}, source key ${sourceKey}. Each round's message and pinned definition are its revision input.`,
    priority: 'background',
    pipeline,
    agent: id,
    sourceKey,
  });
  const outcome = await deps.orchestrator.request({
    taskId: { workId },
    requestId: revision.key,
    pipeline,
    priority: spec.priority,
    params: { mode: 'claw' },
    work: {
      origin: { principal: request.principal, channel: 'console' },
      spec,
    },
    sourceRevision: revision,
    // The key (definition digest, message, request id) is the round's
    // identity. A repeat after an unrelated commit moved the revision of an
    // unchanged definition, or of a round coalesced away before it ran,
    // replays the admitted receipt instead of conflicting with it.
    isSameSourceRevision: (admitted, replay) =>
      admitted.key === replay.key &&
      admitted.input['message'] === replay.input['message'],
    isStoredWorkCompatible: (stored) => {
      const parsed = storedWorkPayloadSchema.safeParse(stored);
      if (!parsed.success) return false;
      if (parsed.data.origin?.principal !== request.principal) return false;
      const existing = agentWorkSpecSchema.safeParse(parsed.data.spec);
      return (
        existing.success &&
        existing.data.agent === id &&
        existing.data.sourceKey === sourceKey &&
        existing.data.pipeline === pipeline
      );
    },
  });
  if (isRefusal(outcome)) {
    if (outcome.reason === 'duplicate-request')
      return { workId, duplicate: true };
    if (
      outcome.reason === 'work-spec-mismatch' ||
      outcome.reason === 'task-closed'
    )
      throw new AgentAdmissionError(
        'CONFLICT',
        outcome.reason === 'task-closed'
          ? 'This work was canceled; use a new sourceKey'
          : 'sourceKey names incompatible Work',
      );
    throw new Error(`Agent run admission refused: ${outcome.reason}`);
  }
  return { workId, duplicate: false };
}

/** The brief for an agent round. The round pins only the revision and
 * digest, so the file list never counts against the Work payload: the
 * definition is re-read from that immutable commit, its digest must match,
 * and each file is read by blob SHA. */
export async function agentRunBrief(
  input: unknown,
  tokens: DispatchTokenProvider,
): Promise<AgentRunBrief> {
  const round = agentRoundSchema.parse(input);
  const [owner, repo, name] = round.agent.split('/');
  const repository = `${owner}/${repo}`;
  const source = await openRepositorySource(
    repository,
    await tokens.tokenFor(repository),
    AbortSignal.timeout(60000),
    { revision: round.revision },
  );
  const agentTree = await source.directory(
    await source.lcarsDirectory('agents'),
    name!,
  );
  if (agentTree === undefined)
    throw new Error(`${round.agent} is absent at ${round.revision}`);
  const files = (await source.readTree(agentTree, true))
    .filter((entry) => entry.type !== 'tree')
    .map(({ path, mode, sha }) => {
      if (mode !== '100644' && mode !== '100755')
        throw new Error(`Agent files must be regular files: ${path}`);
      return { path, mode: mode as '100644' | '100755', sha };
    });
  if (agentDigest(files) !== round.digest)
    throw new Error(`${round.agent} does not match its pinned digest`);
  return {
    agent: round.agent,
    revision: round.revision,
    digest: round.digest,
    requireToolEvidence: round.requireToolEvidence,
    message: round.message,
    files: await Promise.all(
      [...files]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(async (file) => ({
          ...file,
          content: (await source.readBlob(file.sha)).toString('base64'),
        })),
    ),
  };
}
