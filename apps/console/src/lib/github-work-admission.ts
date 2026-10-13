import 'server-only';

import { AGENT_LABELS, REVIEW_LABELS } from '@agent-lcars/dispatch-contracts';
import {
  decidedRun,
  isRefusal,
  isWorkAnchor,
  type RequestBinding,
  type TaskId,
  taskIdSchema,
} from '@agent-lcars/orchestrator';
import { type WorkPayload, workPayloadSchema } from '@agent-lcars/work';

import { isAdminGithubLogin } from './deployment';
import {
  checkGithubLabelRouting,
  type GithubLabelRouting,
  type RoutingLabelConflict,
} from './github-routing-labels';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import { normalizeGithubWorkPayload } from './work-from-github';
import { forbiddenReason, type GrantsPrincipal, sameSpec } from './work-mint';
import { authorizeProviderFallback } from './work-provider-fallback';

/** The one internal admission boundary for a GitHub issue or pull-request
 * anchor. HTTP, webhook, and console callers prepare their own identity and
 * user-facing response, but none may make an independent request/drain
 * decision. */
export interface GithubWorkAdmissionInput {
  anchor: TaskId;
  requestId: string;
  /** Optional opaque source-to-canonical binding resolved atomically with
   * this admission's history lookup and Run decision. */
  requestBinding?: RequestBinding;
  params: Record<string, string>;
  /** Always passed, including a Retry of an existing task: a GitHub anchor
   * never relies on a caller default for its target or pipeline. */
  work: WorkPayload;
  /** Present only for label-triggered requests; validate again at the one
   * admission boundary before any durable request or executor dispatch. */
  labelRouting?: GithubLabelRouting;
  /** Console reply guard: this is an expectation, never a provider switch. */
  expectedEffectivePipeline?: string;
  /** A retry inherits execution intent; explicit API/reply selections do not. */
  followEffectivePipeline?: boolean;
  /** Work API callers are additionally constrained by their signed GitHub
   * Actions repository and their ordinary Work grant. Webhook and console
   * callers have already established their own admission identity. */
  authorization?: {
    sourceRepository?: string;
    grantsPrincipal?: GrantsPrincipal;
  };
}

export interface GithubWorkRedispatchInput {
  anchor: TaskId;
  requestId: string;
  params: Record<string, string>;
  fallbackPipelines?: readonly string[];
  authorization: {
    sourceRepository?: string;
    grantsPrincipal: GrantsPrincipal;
  };
}

export type GithubWorkAdmissionOutcome =
  | { kind: 'accepted'; runId: string; dispatched: boolean }
  | { kind: 'busy'; runId: string }
  | { kind: 'duplicate'; runId: string }
  | {
      kind: 'conflict';
      message: string;
      providerRouting?: NonNullable<
        import('@agent-lcars/orchestrator').Task['providerRouting']
      >;
    }
  | RoutingLabelConflict
  | { kind: 'invalid'; message: string }
  | { kind: 'forbidden'; message: string };

export type GithubWorkRedispatchOutcome =
  | Exclude<GithubWorkAdmissionOutcome, { kind: 'conflict' }>
  | { kind: 'not-found' }
  | { kind: 'conflict'; message: string };

/**
 * Normalizes, validates, idempotently requests, and drains one GitHub-anchor
 * run. This deliberately takes runtime dependencies directly instead of
 * POSTing to the Work API, so webhook and console admission cannot acquire a
 * second HTTP/auth boundary or drift from the public API's durable decision.
 */
export async function admitGithubWork(
  runtime: Pick<OrchestratorRouteDeps, 'orchestrator' | 'drain'>,
  input: GithubWorkAdmissionInput,
): Promise<GithubWorkAdmissionOutcome> {
  const parsedAnchor = taskIdSchema.safeParse(input.anchor);
  if (!parsedAnchor.success || isWorkAnchor(parsedAnchor.data)) {
    return {
      kind: 'invalid',
      message: 'A GitHub issue or pull-request anchor is required',
    };
  }
  const anchor = parsedAnchor.data;

  let work: WorkPayload;
  try {
    work = normalizeGithubWorkPayload(input.work);
  } catch {
    return { kind: 'invalid', message: 'GitHub Work payload is invalid' };
  }
  if (work.spec.target.repo !== anchor.repo) {
    return {
      kind: 'invalid',
      message: 'GitHub Work target must match its anchor repository',
    };
  }
  if (
    input.authorization?.sourceRepository !== undefined &&
    input.authorization.sourceRepository !== anchor.repo
  ) {
    return {
      kind: 'forbidden',
      message: 'GitHub Actions principal may only dispatch its own repository',
    };
  }
  if (
    input.labelRouting !== undefined &&
    input.authorization?.grantsPrincipal !== undefined
  ) {
    const forbidden = forbiddenReason(
      input.authorization.grantsPrincipal,
      work.spec,
    );
    if (forbidden !== undefined)
      return { kind: 'forbidden', message: forbidden };
  }
  if (
    work.spec.fallbackPipelines?.length &&
    input.authorization?.grantsPrincipal === undefined
  )
    return {
      kind: 'forbidden',
      message:
        'Explicit provider fallback requires an authenticated Work grant',
    };

  if (input.labelRouting !== undefined) {
    const conflict = checkGithubLabelRouting(input.labelRouting);
    if (conflict !== undefined) return conflict;
    const choices =
      input.labelRouting.mode === 'implement' ? AGENT_LABELS : REVIEW_LABELS;
    if (
      choices.get(input.labelRouting.trigger) !== work.spec.pipeline ||
      input.labelRouting.mode !== input.params['mode']
    ) {
      return {
        kind: 'invalid',
        message: 'Label routing must match requested Work and mode',
      };
    }
  }

  const routing = input.labelRouting;
  const principal = input.authorization?.grantsPrincipal;
  const labelProviderRequest =
    routing?.mode === 'implement' &&
    routing.requestedAt !== undefined &&
    typeof routing.actor === 'string'
      ? {
          requestedAt: routing.requestedAt,
          actor: routing.actor,
          allowProviderChange: isAdminGithubLogin(routing.actor),
        }
      : undefined;

  const outcome = await runtime.orchestrator.request({
    taskId: anchor,
    requestId: input.requestId,
    ...(input.requestBinding === undefined
      ? {}
      : { requestBinding: input.requestBinding }),
    labelProviderRequest,
    pipelineForStoredTask: (task) =>
      workPayloadSchema.parse(task.work).spec.pipeline,
    useEffectivePipeline:
      input.followEffectivePipeline === true ||
      input.expectedEffectivePipeline !== undefined,
    expectedEffectivePipeline: input.expectedEffectivePipeline,
    isPipelineAuthorized:
      principal === undefined
        ? undefined
        : (pipeline) =>
            forbiddenReason(principal, {
              ...work.spec,
              pipeline: pipeline as WorkPayload['spec']['pipeline'],
            }) === undefined,
    pipeline: work.spec.pipeline,
    priority: work.spec.priority,
    providerFallbackForPipeline: (pipeline) =>
      input.authorization?.grantsPrincipal === undefined
        ? undefined
        : authorizeProviderFallback(
            {
              ...input.authorization.grantsPrincipal,
              sourceRepository: input.authorization.sourceRepository,
            },
            pipeline,
            work.spec.fallbackPipelines,
          ),
    params: input.params,
    work,
    // This comparison must execute in the store transaction. A standalone
    // read can race another first admission: its Work wins the Task write,
    // but this request would otherwise mint a Run for a different pipeline.
    isStoredWorkCompatible: (stored, task) => {
      if (
        input.labelRouting?.mode === 'implement' &&
        task.providerRouting !== undefined &&
        labelProviderRequest === undefined
      )
        return false;
      const spec = workPayloadSchema.parse(stored).spec;
      // Authorization changes only execution intent, never the admitted payload.
      return sameSpec(
        spec,
        labelProviderRequest === undefined
          ? work.spec
          : { ...work.spec, pipeline: spec.pipeline },
      );
    },
  });
  if (isRefusal(outcome)) {
    if (outcome.reason === 'pipeline-forbidden') {
      return {
        kind: 'forbidden',
        message: 'Current authority does not grant the effective provider',
      };
    }
    if (outcome.reason === 'stale-provider-request') {
      return { kind: 'conflict', message: 'stale-provider-request' };
    }
    if (outcome.reason === 'work-spec-mismatch') {
      return {
        kind: 'conflict',
        message: 'GitHub Work specification is immutable once admitted',
      };
    }
    const runId = outcome.existingRun?.runId;
    if (runId === undefined) {
      return {
        kind: 'invalid',
        message: 'GitHub Work refusal had no existing run',
      };
    }
    if (outcome.reason === 'duplicate-request') {
      return { kind: 'duplicate', runId };
    }
    if (outcome.reason === 'task-busy') return { kind: 'busy', runId };
    return {
      kind: 'invalid',
      message: `Unexpected GitHub Work refusal: ${outcome.reason}`,
    };
  }

  if (outcome.run === undefined && outcome.task.providerRouting !== undefined) {
    return {
      kind: 'conflict',
      message: 'Provider handoff refused',
      providerRouting: outcome.task.providerRouting,
    };
  }
  const { runId } = decidedRun(outcome);
  const drained = await runtime.drain();
  return {
    kind: 'accepted',
    runId,
    dispatched: drained.dispatched.includes(runId),
  };
}

/** Requests another run without accepting a replacement Work specification. */
export async function redispatchGithubWork(
  runtime: Pick<OrchestratorRouteDeps, 'orchestrator' | 'store' | 'drain'>,
  input: GithubWorkRedispatchInput,
): Promise<GithubWorkRedispatchOutcome> {
  const parsedAnchor = taskIdSchema.safeParse(input.anchor);
  if (!parsedAnchor.success || isWorkAnchor(parsedAnchor.data)) {
    return {
      kind: 'invalid',
      message: 'A GitHub issue or pull-request anchor is required',
    };
  }
  const anchor = parsedAnchor.data;

  if (
    input.authorization.sourceRepository !== undefined &&
    input.authorization.sourceRepository !== anchor.repo
  ) {
    return {
      kind: 'forbidden',
      message: 'GitHub Actions principal may only dispatch its own repository',
    };
  }

  const task = await runtime.store.readTask(anchor);
  if (task === undefined) return { kind: 'not-found' };
  const work = workPayloadSchema.parse(task.task.work);
  if (work.spec.target.repo !== anchor.repo) {
    return {
      kind: 'invalid',
      message: 'Stored GitHub Work target does not match its anchor repository',
    };
  }
  const outcome = await runtime.orchestrator.request({
    taskId: anchor,
    requestId: input.requestId,
    useEffectivePipeline: true,
    pipelineForStoredTask: (task) =>
      workPayloadSchema.parse(task.work).spec.pipeline,
    isPipelineAuthorized: (pipeline) =>
      forbiddenReason(input.authorization.grantsPrincipal, {
        ...work.spec,
        pipeline: pipeline as WorkPayload['spec']['pipeline'],
      }) === undefined,
    pipeline: work.spec.pipeline,
    priority: work.spec.priority,
    providerFallbackForPipeline: (pipeline) =>
      authorizeProviderFallback(
        {
          ...input.authorization.grantsPrincipal,
          sourceRepository: input.authorization.sourceRepository,
        },
        pipeline,
        input.fallbackPipelines ?? work.spec.fallbackPipelines,
      ),
    params: input.params,
  });
  if (isRefusal(outcome)) {
    if (outcome.reason === 'pipeline-forbidden')
      return {
        kind: 'forbidden',
        message: 'Current authority does not grant the effective provider',
      };
    const runId = outcome.existingRun?.runId;
    if (outcome.reason === 'duplicate-request' && runId !== undefined) {
      return { kind: 'duplicate', runId };
    }
    if (outcome.reason === 'task-busy' && runId !== undefined) {
      return { kind: 'busy', runId };
    }
    return {
      kind: 'conflict',
      message: `GitHub Work cannot be redispatched: ${outcome.reason}`,
    };
  }

  const { runId } = decidedRun(outcome);
  const drained = await runtime.drain();
  return {
    kind: 'accepted',
    runId,
    dispatched: drained.dispatched.includes(runId),
  };
}
