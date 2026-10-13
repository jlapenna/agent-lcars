import 'server-only';

import {
  decidedRun,
  isLive,
  isRefusal,
  isWorkAnchor,
  LIFECYCLE_METRICS_READ_LIMIT,
  LIFECYCLE_METRICS_WINDOW_SECONDS,
  lifecycleMetricSnapshot,
} from '@agent-lcars/orchestrator';
import {
  itemsContract,
  type MaintenanceTickOutput,
  type WorkSpec,
  workPayloadSchema,
} from '@agent-lcars/work';
import { deriveItemState, toItemView } from '@agent-lcars/work/derive';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import { readAnchorOwner } from './anchor-owner';
import { controlPlaneRepositories } from './deployment';
import { githubDispatchRouter } from './github-dispatch-router';
import { handleReconcile } from './orchestrator-routes';
import { grantForPrincipal } from './work-grants';
import { scheduleRouter } from './schedule-router';
import {
  forbiddenReason,
  isWorkOperatorPrincipal,
  mintItem,
  view,
  type WorkContext,
} from './work-mint';
import { authorizeProviderFallback } from './work-provider-fallback';
import { requestReply } from './work-reply';

export type { WorkContext } from './work-mint';

const os = implement(itemsContract).$context<WorkContext>();

/**
 * Router-level gate: every procedure below is built from `operator`, so
 * authorization is structural rather than something each handler has to
 * remember. Applied through the implementer's `.use`, which records the
 * middleware with no input schemas seen yet -- so it runs BEFORE input
 * validation, and a caller with no principal gets 401 rather than a 400
 * describing a body it was never entitled to have validated.
 *
 * `UNAUTHORIZED` is deliberately not in any procedure's `.errors` map: it
 * is not a per-procedure outcome a client can branch on, it is the gate.
 * oRPC still maps the bare `ORPCError` code to 401 through
 * `COMMON_ERROR_STATUS_MAP`.
 */
const operator = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (!isWorkOperatorPrincipal(principal)) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator scope required',
    });
  }
  return next({ context: { principal } });
});

const cron = os.use(async ({ context, next }) => {
  if (!context.principal?.scopes.has('work.cron')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.cron scope required',
    });
  }
  return next({ context });
});

const metricsReader = os.use(async ({ context, next }) => {
  if (
    !context.principal?.scopes.has('work.operator') &&
    !context.principal?.scopes.has('work.cron')
  ) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator or work.cron scope required',
    });
  }
  return next({ context });
});

/** `list`/`get` additionally accept `work.reaper` (the session-expiry
 *  workflow, a read-only caller) -- `create`/`cancel`/`redispatch`
 *  stay `operator`-only; a reaper-scoped principal must never mint or
 *  settle a run. */
const reader = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (
    principal === undefined ||
    (!principal.scopes.has('work.operator') &&
      !principal.scopes.has('work.reaper'))
  ) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator or work.reaper scope required',
    });
  }
  return next({ context: { principal } });
});

/** The issue-owner query alone also accepts `work.reader` (#2502): the
 *  read-only interactive-session identity, which no other gate admits.
 *  Deliberately not `work.reaper` -- that caller needs item reads for
 *  session expiry, never CLI session telemetry. */
const ownerReader = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (
    principal === undefined ||
    (!principal.scopes.has('work.operator') &&
      !principal.scopes.has('work.reader'))
  ) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator or work.reader scope required',
    });
  }
  return next({ context: { principal } });
});

export const workRouter = os.router({
  deliveryEvidence: operator.deliveryEvidence.handler(
    async ({ input, context, errors }) => {
      const run = await context.runtime.store.readRun(input.runId);
      const task =
        run === undefined
          ? undefined
          : (await context.runtime.store.readTask(run.task))?.task;
      const payload = workPayloadSchema.safeParse(task?.work);
      if (
        run === undefined ||
        !payload.success ||
        forbiddenReason(context.principal, {
          ...payload.data.spec,
          pipeline: run.pipeline as WorkSpec['pipeline'],
        }) !== undefined ||
        (context.principal.sourceRepository !== undefined &&
          context.principal.sourceRepository !== payload.data.spec.target.repo)
      )
        throw errors.FORBIDDEN();
      const decision = await context.runtime.orchestrator.observeDelivery(
        run.runId,
        {
          kind: 'runtime-evidence',
          head: input.head,
          mergeCommit: input.mergeCommit,
          principal: context.principal.principal,
          ref: input.ref,
        },
        (currentTask, currentRun) => {
          const currentWork = workPayloadSchema.safeParse(currentTask.work);
          if (
            !currentWork.success ||
            currentTask.delivery?.repo !== currentWork.data.spec.target.repo ||
            forbiddenReason(context.principal, {
              ...currentWork.data.spec,
              pipeline: currentRun.pipeline as WorkSpec['pipeline'],
            }) !== undefined ||
            (context.principal.sourceRepository !== undefined &&
              context.principal.sourceRepository !==
                currentWork.data.spec.target.repo)
          )
            return false;
          const grant = grantForPrincipal(context.principal.principal);
          return (
            grant?.scopes.includes('work.operator') === true &&
            grant.pipelines.includes(
              currentRun.pipeline as 'claude' | 'codex' | 'opencode',
            )
          );
        },
      );
      if (isRefusal(decision)) throw errors.CONFLICT();
      return { runId: run.runId, state: 'complete' as const };
    },
  ),
  lifecycleMetrics: metricsReader.lifecycleMetrics.handler(
    async ({ context }) => {
      const observedAt = context.now().toISOString();
      const records = await context.runtime.store.readLifecycleMetricRecords({
        since: new Date(
          Date.parse(observedAt) - LIFECYCLE_METRICS_WINDOW_SECONDS * 1_000,
        ).toISOString(),
        until: observedAt,
        limit: LIFECYCLE_METRICS_READ_LIMIT,
      });
      return lifecycleMetricSnapshot(records, observedAt);
    },
  ),
  maintenanceTick: cron.maintenanceTick.handler(async ({ context }) => {
    const result = await handleReconcile(context.runtime);
    if (result.status !== 200) {
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'maintenance tick failed',
      });
    }
    return result.body as MaintenanceTickOutput;
  }),
  create: operator.create.handler(async ({ input, context, errors }) => {
    const { principal } = context;
    const result = await mintItem(context, {
      id: input.id,
      spec: input.spec,
      origin: {
        principal: principal.principal,
        // The grant's declared channel wins when present; otherwise fall
        // back to the pre-existing derivation, unchanged. The channel is
        // never taken from `input` -- it selects an outbound delivery
        // target, so it must come from the authenticated identity, not the
        // request body (issue #1804).
        channel:
          principal.channel ??
          (principal.via === 'session' ? 'console' : 'api'),
        ...(input.thread === undefined ? {} : { thread: input.thread }),
      },
      grantsPrincipal: principal,
    });
    if (result.kind === 'forbidden') {
      throw errors.FORBIDDEN({ message: result.message });
    }
    if (result.kind === 'conflict') {
      throw errors.CONFLICT({ message: result.message });
    }
    return view(context, input.id, result.task);
  }),

  /** Read-only (#2502): who Console says is working a GitHub anchor.
   *  Least privilege: `ownerReader` (`work.operator` or `work.reader`), and
   *  only for a control-plane repository -- the same repository boundary
   *  GitHub-anchor admission applies, including binding a GitHub Actions
   *  OIDC principal to the repository its token named. */
  anchorOwner: ownerReader.anchorOwner.handler(
    async ({ input, context, errors }) => {
      // GitHub names are case-insensitive, but orchestrator task ids use the
      // configured spelling: resolve to it, or refuse.
      const repo = controlPlaneRepositories().find(
        (candidate) => candidate.toLowerCase() === input.repo.toLowerCase(),
      );
      const { sourceRepository } = context.principal;
      if (
        repo === undefined ||
        (sourceRepository !== undefined &&
          sourceRepository.toLowerCase() !== repo.toLowerCase())
      ) {
        throw errors.FORBIDDEN();
      }
      return readAnchorOwner(context, { repo, issue: input.issue });
    },
  ),

  get: reader.get.handler(async ({ input, context, errors }) => {
    const task = await context.runtime.store.readTask({ workId: input.id });
    if (task === undefined) throw errors.NOT_FOUND();
    return view(context, input.id, task.task);
  }),

  list: reader.list.handler(async ({ input, context }) => {
    const tasks = await context.runtime.store.listNativeTasks(
      input.limit,
      input.cursor,
    );
    const native = tasks.flatMap(({ task }) =>
      isWorkAnchor(task.task) ? [{ workId: task.task.workId, task }] : [],
    );
    // Cursor for the *next* raw store page, not the filtered one below:
    // walking pages by the store's own newest-first `workId` order is what
    // guarantees every native task is eventually visited exactly once,
    // regardless of how many of them survive the state/principal/repo
    // filters on any given page (issue #1546 -- the bug this replaces was
    // exactly a filter applied AFTER a single unpaginated, limit-bounded
    // read, which silently dropped anything past the newest `limit`
    // items). A full-length page (`=== input.limit`) may or may not have
    // more behind it; the boundary case where it doesn't costs one extra
    // page that comes back empty with no `nextCursor`, not an off-by-one.
    const nextCursor =
      tasks.length === input.limit
        ? native[native.length - 1]?.workId
        : undefined;

    // Two passes on purpose. Filtering needs derived state, which needs
    // each item's runs -- but the session join reads a *different*
    // database, so it runs only over the items that survive the filters
    // and the limit rather than over every native task ever created.
    //
    // Tasks are persisted in the current strict shape. A corrupt record is
    // a data-integrity failure, not a reason to silently omit work from a
    // control-plane response.
    const unjoined = await Promise.all(
      native.map(async ({ workId, task }) =>
        toItemView({
          workId,
          task,
          runs: await context.runtime.store.listRuns({ workId }),
        }),
      ),
    );
    const page = unjoined
      .filter((item) => input.state === undefined || item.state === input.state)
      .filter(
        (item) =>
          input.principal === undefined ||
          item.origin.principal === input.principal,
      )
      .filter(
        (item) =>
          input.repo === undefined || item.spec.target.repo === input.repo,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, input.limit);

    return {
      items: await Promise.all(
        page.map(async (item) => ({
          ...item,
          sessions: await context.sessionsFor(
            item.runs.map((run) => run.runId),
          ),
        })),
      ),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }),

  cancel: operator.cancel.handler(async ({ input, context, errors }) => {
    const task = await context.runtime.store.readTask({ workId: input.id });
    if (task === undefined) throw errors.NOT_FOUND();
    const runs = await context.runtime.store.listRuns({ workId: input.id });
    const state = deriveItemState(task.task, runs);
    if (state === 'done' || state === 'canceled') {
      throw errors.CONFLICT({
        message: `item ${input.id} is already ${state}`,
      });
    }

    // A live run holds the task's lock, so cancelling it is what settles
    // the item. With no live run there is nothing to stop -- the item is
    // parked -- and closing the task is what makes "canceled" stick.
    const live = runs.find((run) => isLive(run.state));
    const outcome =
      live === undefined
        ? await context.runtime.orchestrator.close({ workId: input.id })
        : await context.runtime.orchestrator.cancel(
            live.runId,
            `canceled by ${context.principal.principal}`,
          );
    if (isRefusal(outcome)) {
      throw errors.CONFLICT({ message: outcome.reason });
    }
    if (live === undefined) {
      // Closing a parked item settles no run, so no outbox outcome carries
      // the close; start its sessions' expiry here. Best effort: the item is
      // already canceled, and a failed dispatch only keeps its sessions
      // longer (the workflow can be re-run by item id).
      await context.runtime.expireItemSessions?.(input.id);
    }
    await context.runtime.drain();
    return view(context, input.id, outcome.task);
  }),

  update: operator.update.handler(async ({ input, context, errors }) => {
    const task = await context.runtime.store.readTask({ workId: input.id });
    if (task === undefined) throw errors.NOT_FOUND();
    const stored = workPayloadSchema.parse(task.task.work);
    // Only the prose is editable: pipeline and target are granted
    // capabilities, so changing them would need the re-authorization
    // `create` performs.
    const outcome = await context.runtime.orchestrator.updateWork(
      { workId: input.id },
      {
        ...task.task.work,
        spec: {
          ...stored.spec,
          title: input.title,
          description: input.description,
        },
      },
    );
    if (isRefusal(outcome)) {
      if (outcome.reason === 'unknown-task') throw errors.NOT_FOUND();
      throw errors.CONFLICT({ message: outcome.reason });
    }
    return view(context, input.id, outcome.task);
  }),

  redispatch: operator.redispatch.handler(
    async ({ input, context, errors }) => {
      const task = await context.runtime.store.readTask({ workId: input.id });
      if (task === undefined) throw errors.NOT_FOUND();
      const runs = await context.runtime.store.listRuns({ workId: input.id });
      const state = deriveItemState(task.task, runs);
      if (state !== 'parked' && state !== 'failed') {
        throw errors.CONFLICT({
          message: 'only a parked or failed item can be redispatched',
        });
      }

      // The item's declared pipeline and target, not the last run's: the
      // spec is what the operator asked for, and a run only ever copies it.
      // Re-checked in full because redispatch mints a fresh run, so it
      // needs everything `create` needed -- and neither the principal nor
      // the control-plane repository list need be what they were when the
      // item was created.
      const { spec } = workPayloadSchema.parse(task.task.work);
      const forbidden = forbiddenReason(context.principal, spec);
      if (forbidden !== undefined) {
        throw errors.FORBIDDEN({ message: forbidden });
      }

      // Sub-project 6: `resumeSessionId` names a session to resume, not just
      // reference -- so it must be validated for OWNERSHIP, not mere
      // existence: it has to be a claude-code session whose `intentId`
      // names a run of THIS item, and it has to carry an archived
      // transcript for the new run to actually resume from.
      let resumeParams: Record<string, string> | undefined;
      if (input.resumeSessionId !== undefined) {
        const session = await context.getSessionDoc(input.resumeSessionId);
        const runIds = new Set(runs.map((run) => run.runId));
        if (
          session === undefined ||
          session.source !== 'issue-agent' ||
          session.intentId === undefined ||
          !runIds.has(session.intentId) ||
          session.agent !== 'claude-code'
        ) {
          throw errors.BAD_REQUEST({
            message:
              'resumeSessionId must name a claude-code session belonging to a run of this item',
          });
        }
        if (session.transcriptGcsUri === undefined) {
          throw errors.CONFLICT({
            message: 'session has no archived transcript to resume from',
          });
        }
        resumeParams = {
          resumeSessionId: input.resumeSessionId,
          resumeTranscriptGcsUri: session.transcriptGcsUri,
        };
      }

      const outcome = await context.runtime.orchestrator.request({
        taskId: { workId: input.id },
        requestId: `${input.id}:${task.task.runCount + 1}`,
        pipeline: spec.pipeline,
        priority: spec.priority,
        providerFallback: authorizeProviderFallback(
          context.principal,
          spec.pipeline,
          input.fallbackPipelines ?? spec.fallbackPipelines,
        ),
        params: { mode: 'implement', ...resumeParams },
      });
      if (isRefusal(outcome)) {
        throw errors.CONFLICT({ message: outcome.reason });
      }
      // Invariant, not decoration: a granted request always mints a run.
      decidedRun(outcome);
      if (state === 'failed') {
        // Reopening a closed item clears the expiry its close stamped.
        await context.runtime.expireItemSessions?.(input.id);
      }
      await context.runtime.drain();
      return view(context, input.id, outcome.task);
    },
  ),

  reply: operator.reply.handler(async ({ input, context, errors }) => {
    const outcome = await requestReply(context, {
      task: { workId: input.id },
      text: input.text,
      // The console session and a service principal are the only two
      // callers this route has today; plan 2's GitHub ingest and plan 5's
      // Slack adapter call `requestReply` directly with their own channel.
      channel: context.principal.via === 'session' ? 'console' : 'api',
      principal: context.principal.principal,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      ...(input.pipeline === undefined ? {} : { pipeline: input.pipeline }),
      ...(input.fallbackPipelines === undefined
        ? {}
        : { fallbackPipelines: input.fallbackPipelines }),
    });
    if (!outcome.ok) {
      if (outcome.code === 'NOT_FOUND') throw errors.NOT_FOUND();
      if (outcome.code === 'FORBIDDEN')
        throw errors.FORBIDDEN({ message: outcome.message });
      throw errors.CONFLICT({ message: outcome.message });
    }
    // `requestReply`'s outcome carries only the minted run id, not a fresh
    // `Task` -- unlike `create`/`cancel`/`redispatch`, which get one back
    // from the orchestrator call they each make directly. Re-read it, the
    // same way `get` does.
    const task = await context.runtime.store.readTask({ workId: input.id });
    if (task === undefined) throw errors.NOT_FOUND();
    return {
      ...(await view(context, input.id, task.task)),
      admittedRunId: outcome.runId,
      resumed: outcome.resumed,
    };
  }),
});

/**
 * The OpenAPI (RESTful) adapter serving items, schedules, and GitHub-anchor
 * dispatches under one handler. Their contracts already carry the full path,
 * so nesting them
 * under organizational keys here is not a URL prefix. Error codes map to
 * HTTP status through oRPC's own `COMMON_ERROR_STATUS_MAP` (`UNAUTHORIZED`
 * 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409), so no
 * `errorStatusMap` override is needed.
 */
export function createWorkHandler(): OpenAPIHandler<WorkContext> {
  return new OpenAPIHandler({
    items: workRouter,
    schedules: scheduleRouter,
    dispatches: githubDispatchRouter,
  });
}
