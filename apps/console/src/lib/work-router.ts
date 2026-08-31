import 'server-only';

import {
  decidedRun,
  isLive,
  isRefusal,
  isWorkAnchor,
} from '@agent-lcars/orchestrator';
import { sessionAgent } from '@agent-lcars/telemetry';
import { itemsContract, workPayloadSchema } from '@agent-lcars/work';
import type { ItemView } from '@agent-lcars/work/derive';
import { deriveItemState, toItemViewSafe } from '@agent-lcars/work/derive';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import { githubDispatchRouter } from './github-dispatch-router';
import { scheduleRouter } from './schedule-router';
import {
  forbiddenReason,
  liveNativeRunCount,
  mintItem,
  RETRY_AFTER_SECONDS,
  view,
  type WorkContext,
} from './work-mint';

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
  if (principal === undefined || !principal.scopes.has('work.operator')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator scope required',
    });
  }
  return next({ context: { principal } });
});

/** `list`/`get` additionally accept `work.reaper` (sub-project 6's
 *  session-pin tick, a read-only caller) -- `create`/`cancel`/`redispatch`
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

export const workRouter = os.router({
  create: operator.create.handler(async ({ input, context, errors }) => {
    const { principal } = context;
    const result = await mintItem(context, {
      id: input.id,
      spec: input.spec,
      origin: {
        principal: principal.principal,
        channel: principal.via === 'session' ? 'console' : 'api',
      },
      grantsPrincipal: principal,
    });
    if (result.kind === 'forbidden') {
      throw errors.FORBIDDEN({ message: result.message });
    }
    if (result.kind === 'conflict') {
      throw errors.CONFLICT({ message: result.message });
    }
    if (result.kind === 'cap') {
      throw errors.TOO_MANY_REQUESTS({
        data: { retryAfterSeconds: RETRY_AFTER_SECONDS },
      });
    }
    return view(context, input.id, result.task);
  }),

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
    // `toItemViewSafe` rather than `toItemView`: `Task.work` is stored as
    // an optional loose record, so one native task with an absent or
    // partial payload is a legal persisted state, not a bug. A strict
    // parse there would 500 the whole listing over a single bad item;
    // skipping it (and logging once) degrades the page instead.
    const unjoined = (
      await Promise.all(
        native.map(async ({ workId, task }) => {
          const view = toItemViewSafe({
            workId,
            task,
            runs: await context.runtime.store.listRuns({ workId }),
          });
          if (view === undefined) {
            console.warn(
              'agent-lcars: skipping native task with an invalid work payload',
              { workId },
            );
          }
          return view;
        }),
      )
    ).filter((item): item is ItemView => item !== undefined);
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
    await context.runtime.drain();
    return view(context, input.id, outcome.task);
  }),

  redispatch: operator.redispatch.handler(
    async ({ input, context, errors }) => {
      const task = await context.runtime.store.readTask({ workId: input.id });
      if (task === undefined) throw errors.NOT_FOUND();
      const runs = await context.runtime.store.listRuns({ workId: input.id });
      if (deriveItemState(task.task, runs) !== 'parked') {
        throw errors.CONFLICT({
          message: 'only a parked item can be redispatched',
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
          sessionAgent(session) !== 'claude-code'
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

      if ((await liveNativeRunCount(context)) >= context.maxLiveRuns) {
        throw errors.TOO_MANY_REQUESTS({
          data: { retryAfterSeconds: RETRY_AFTER_SECONDS },
        });
      }

      const outcome = await context.runtime.orchestrator.request({
        taskId: { workId: input.id },
        requestId: `${input.id}:${task.task.runCount + 1}`,
        pipeline: spec.pipeline,
        ...(resumeParams === undefined ? {} : { params: resumeParams }),
      });
      if (isRefusal(outcome)) {
        throw errors.CONFLICT({ message: outcome.reason });
      }
      // Invariant, not decoration: a granted request always mints a run.
      decidedRun(outcome);
      await context.runtime.drain();
      return view(context, input.id, outcome.task);
    },
  ),
});

/**
 * The OpenAPI (RESTful) adapter serving items, schedules, and GitHub-anchor
 * dispatches under one handler. Their contracts already carry the full path,
 * so nesting them under organizational keys here is not a URL prefix. Error
 * codes map to HTTP status through oRPC's own `COMMON_ERROR_STATUS_MAP`
 * (`UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409,
 * `TOO_MANY_REQUESTS` 429), which is exactly what this API wants -- so no
 * `errorStatusMap` override.
 */
export function createWorkHandler(): OpenAPIHandler<WorkContext> {
  return new OpenAPIHandler(
    {
      items: workRouter,
      schedules: scheduleRouter,
      dispatches: githubDispatchRouter,
    },
    {
      routingInterceptors: [
        // `Retry-After` is the standard way to say what the 429 body's
        // `retryAfterSeconds` says, and generic HTTP clients honour it.
        // A routing interceptor is the only hook that sees the *encoded*
        // error response: `interceptors` run inside the try block, before
        // the codec turns a thrown ORPCError into a status and body.
        async (options) => {
          const result = await options.next();
          if (result.matched && result.response.status === 429) {
            result.response.headers['retry-after'] =
              String(RETRY_AFTER_SECONDS);
          }
          return result;
        },
      ],
    },
  );
}
