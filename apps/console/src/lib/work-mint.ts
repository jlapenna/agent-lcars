import 'server-only';

import {
  isRefusal,
  isWorkAnchor,
  type ScheduleStore,
  type Task,
} from '@agent-lcars/orchestrator';
import type { SessionDoc } from '@agent-lcars/telemetry';
import {
  type WorkOrigin,
  workPayloadSchema,
  type WorkSpec,
  workSpecSchema,
} from '@agent-lcars/work';
import {
  type ItemSessionView,
  type ItemView,
  toItemView,
} from '@agent-lcars/work/derive';

import { isControlPlaneRepository } from './deployment';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import type { WorkPrincipal } from './work-auth';
import type { WorkGrant } from './work-grants';

/** How long a caller turned away by the live-run cap should wait. Sent both
 *  as the error payload the contract declares and as a `Retry-After`
 *  response header (see `work-router.ts`'s `createWorkHandler`). */
export const RETRY_AFTER_SECONDS = 60;

export interface WorkContext {
  /** Resolved by the route from the request's bearer token or session;
   *  `undefined` means "no recognized principal", which every procedure
   *  turns into a 401 through its scope gate. */
  principal?: WorkPrincipal;
  runtime: OrchestratorRouteDeps;
  sessionsFor: (runIds: string[]) => Promise<ItemSessionView[]>;
  /** Reads one session doc by id, for `redispatch`'s `resumeSessionId`
   *  validation (sub-project 6) -- the same read-only telemetry accessor
   *  `sessionsFor` uses, scoped to a single session. */
  getSessionDoc: (sessionId: string) => Promise<SessionDoc | undefined>;
  maxLiveRuns: number;
  /** Schedule storage -- separate from `OrchestratorRouteDeps` on purpose:
   *  a schedule is not a `Task` (see `schedule-store.ts`). */
  scheduleStore: ScheduleStore;
  /** The grant list, injected the way `sessionsFor` is: the schedule tick
   *  handler re-resolves a schedule's `createdBy` principal against it
   *  directly (`grantForPrincipal`), independent of the tick caller's own
   *  principal (`cron:tick`, which has no grant). */
  grants: () => WorkGrant[];
  /** Injected clock: the tick handler's "latest due slot" computation must
   *  be deterministic under test, not tied to wall-clock `Date.now()`. */
  now: () => Date;
}

export async function view(
  context: WorkContext,
  workId: string,
  task: Task,
): Promise<ItemView> {
  const runs = await context.runtime.store.listRuns({ workId });
  const sessions = await context.sessionsFor(runs.map((run) => run.runId));
  return toItemView({ workId, task, runs, sessions });
}

/** The cap is a fleet-wide budget on *native* work, not on the
 *  orchestrator: GitHub-anchored runs are not this API's to throttle. */
export async function liveNativeRunCount(
  context: WorkContext,
): Promise<number> {
  const live = await context.runtime.store.listLiveRuns();
  return live.filter((run) => isWorkAnchor(run.task)).length;
}

/** Who a mint's grant is checked against: the caller for `items.create`,
 *  a schedule's `createdBy` for `schedules.tick`. */
export interface GrantsPrincipal {
  principal: string;
  pipelines: readonly string[];
}

/**
 * The two capability checks every run-minting call must clear: invoking a
 * pipeline is granted per principal, and the target repository must be one
 * this control plane admits. Both evaluated against the grants and the
 * repository list **as they stand now** -- see the design spec's
 * `redispatch` rationale, which applies identically to a tick.
 *
 * The repo check is `isControlPlaneRepository()` -- the full
 * `AGENT_LCARS_CONTROL_PLANE_REPOSITORIES` allow-list, not the single
 * `controlPlaneRepository()` entry. Wave 1 of #1544 landed a `work`
 * `workflow_dispatch` input, forwarded from a `control-plane-projections`
 * flag, on every consumer repo's `claude/codex/opencode.yml` (six repos,
 * all merged); a native (work-anchored) item targeting any admitted repo
 * can now actually be delivered, so this narrowed from the single-repo
 * equality check wave 1's own doc comment predicted it would. A target
 * repo that is *not* on the allow-list at all still cannot be dispatched
 * to -- refuse it at creation instead of minting a run that can never be
 * delivered.
 */
export function forbiddenReason(
  principal: GrantsPrincipal,
  spec: WorkSpec,
): string | undefined {
  if (!principal.pipelines.includes(spec.pipeline)) {
    return `${principal.principal} may not request pipeline ${spec.pipeline}`;
  }
  if (!isControlPlaneRepository(spec.target.repo)) {
    return (
      `native work items can only target a control-plane repository ` +
      `(${spec.target.repo} is not admitted)`
    );
  }
  return undefined;
}

/** Both sides go through the same schema first, so the comparison is over
 *  normalized values rather than whatever shape the caller happened to
 *  send. */
export function sameSpec(a: WorkSpec, b: WorkSpec): boolean {
  return (
    JSON.stringify(workSpecSchema.parse(a)) ===
    JSON.stringify(workSpecSchema.parse(b))
  );
}

export type MintOutcome =
  | { kind: 'forbidden'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'cap' }
  | { kind: 'existing'; task: Task }
  | { kind: 'minted'; task: Task };

/**
 * Shared by `items.create` and `schedules.tick` (extracted from
 * `items.create`'s body, #1502 sub-project 3): read-or-create-by-id,
 * grant-checked, cap-checked. `id` is the work item id (a client ULID for
 * `create`, `slotItemId(scheduleId, slot)` for a tick); `grantsPrincipal`
 * is who the pipeline/repo grant is checked against.
 */
export async function mintItem(
  context: WorkContext,
  input: {
    id: string;
    spec: WorkSpec;
    origin: WorkOrigin;
    grantsPrincipal: GrantsPrincipal;
  },
): Promise<MintOutcome> {
  const forbidden = forbiddenReason(input.grantsPrincipal, input.spec);
  if (forbidden !== undefined) return { kind: 'forbidden', message: forbidden };

  const existing = await context.runtime.store.readTask({ workId: input.id });
  if (existing !== undefined) {
    const stored = workPayloadSchema.parse(existing.task.work);
    if (!sameSpec(stored.spec, input.spec)) {
      return {
        kind: 'conflict',
        message: `item ${input.id} already exists with a different spec`,
      };
    }
    return { kind: 'existing', task: existing.task };
  }

  if ((await liveNativeRunCount(context)) >= context.maxLiveRuns) {
    return { kind: 'cap' };
  }

  const outcome = await context.runtime.orchestrator.request({
    taskId: { workId: input.id },
    requestId: input.id,
    pipeline: input.spec.pipeline,
    work: { origin: input.origin, spec: input.spec },
    ...(context.runtime.dispatchExecutor?.(input.spec.pipeline) === undefined
      ? {}
      : { executor: context.runtime.dispatchExecutor(input.spec.pipeline) }),
  });
  if (isRefusal(outcome)) {
    return { kind: 'conflict', message: outcome.reason };
  }
  await context.runtime.drain();
  return { kind: 'minted', task: outcome.task };
}
