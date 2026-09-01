import 'server-only';

import {
  decidedRun,
  isRefusal,
  isWorkAnchor,
  type TaskId,
  taskIdSchema,
} from '@agent-lcars/orchestrator';
import { type WorkPayload, workPayloadSchema } from '@agent-lcars/work';

import type { OrchestratorRouteDeps } from './orchestrator-routes';
import { normalizeGithubWorkPayload } from './work-from-github';
import { forbiddenReason, type GrantsPrincipal, sameSpec } from './work-mint';

/** The one internal admission boundary for a GitHub issue or pull-request
 * anchor. HTTP, webhook, and console callers prepare their own identity and
 * user-facing response, but none may make an independent request/drain
 * decision. */
export interface GithubWorkAdmissionInput {
  anchor: TaskId;
  requestId: string;
  params: Record<string, string>;
  /** Always passed, including a Retry of an existing task: a GitHub anchor
   * never relies on a caller default for its target or pipeline. */
  work: WorkPayload;
  /** Work API callers are additionally constrained by their signed GitHub
   * Actions repository and their ordinary Work grant. Webhook and console
   * callers have already established their own admission identity. */
  authorization?: {
    sourceRepository?: string;
    grantsPrincipal?: GrantsPrincipal;
  };
}

export type GithubWorkAdmissionOutcome =
  | { kind: 'accepted'; runId: string; dispatched: boolean }
  | { kind: 'busy'; runId: string }
  | { kind: 'duplicate'; runId: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'forbidden'; message: string };

/**
 * Normalizes, validates, idempotently requests, and drains one GitHub-anchor
 * run. This deliberately takes runtime dependencies directly instead of
 * POSTing to the Work API, so webhook and console admission cannot acquire a
 * second HTTP/auth boundary or drift from the public API's durable decision.
 */
export async function admitGithubWork(
  runtime: Pick<OrchestratorRouteDeps, 'store' | 'orchestrator' | 'drain'>,
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
  if (input.authorization?.grantsPrincipal !== undefined) {
    const forbidden = forbiddenReason(
      input.authorization.grantsPrincipal,
      work.spec,
    );
    if (forbidden !== undefined)
      return { kind: 'forbidden', message: forbidden };
  }

  // The orchestrator writes Work exactly once when it first creates a Task.
  // Re-check the durable spec before asking it for another run: otherwise a
  // later webhook label or API call could mint (say) a Codex Run while the
  // Task's immutable Work still said Claude. That would recreate Reassign as
  // an admission side effect instead of making the conflict explicit.
  const existing = await runtime.store.readTask(anchor);
  if (existing !== undefined) {
    const stored = workPayloadSchema.parse(existing.task.work);
    if (!sameSpec(stored.spec, work.spec)) {
      return {
        kind: 'conflict',
        message: 'GitHub Work specification is immutable once admitted',
      };
    }
  }

  const outcome = await runtime.orchestrator.request({
    taskId: anchor,
    requestId: input.requestId,
    pipeline: work.spec.pipeline,
    params: input.params,
    work,
  });
  if (isRefusal(outcome)) {
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

  const { runId } = decidedRun(outcome);
  const drained = await runtime.drain();
  return {
    kind: 'accepted',
    runId,
    dispatched: drained.dispatched.includes(runId),
  };
}
