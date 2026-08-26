import 'server-only';

import {
  decidedRun,
  isLive,
  isRefusal,
  isWorkAnchor,
  type Task,
} from '@agent-lcars/orchestrator';
import {
  itemsContract,
  workPayloadSchema,
  type WorkSpec,
  workSpecSchema,
} from '@agent-lcars/work';
import {
  deriveItemState,
  type ItemSessionView,
  type ItemView,
  toItemView,
} from '@agent-lcars/work/derive';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import { isControlPlaneRepository } from './deployment';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import type { WorkPrincipal } from './work-auth';

/** How long a caller turned away by the live-run cap should wait. Sent both
 *  as the error payload the contract declares and as a `Retry-After`
 *  response header (see `createWorkHandler`). */
const RETRY_AFTER_SECONDS = 60;

export interface WorkContext {
  /** Resolved by the route from the request's bearer token or session;
   *  `undefined` means "no recognized principal", which every procedure
   *  turns into a 401 through the `operator` gate below. */
  principal?: WorkPrincipal;
  runtime: OrchestratorRouteDeps;
  sessionsFor: (runIds: string[]) => Promise<ItemSessionView[]>;
  maxLiveRuns: number;
}

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

async function view(
  context: WorkContext,
  workId: string,
  task: Task,
): Promise<ItemView> {
  const runs = await context.runtime.store.listRuns({ workId });
  const sessions = await context.sessionsFor(runs.map((run) => run.runId));
  return toItemView({ workId, task, runs, sessions });
}

/** The cap is a fleet-wide budget on *native* work, not on the orchestrator:
 *  GitHub-anchored runs are driven by issues someone already opened and are
 *  not this API's to throttle. */
async function liveNativeRunCount(context: WorkContext): Promise<number> {
  const live = await context.runtime.store.listLiveRuns();
  return live.filter((run) => isWorkAnchor(run.task)).length;
}

function assertPipelineGranted(
  principal: WorkPrincipal,
  pipeline: string,
): void {
  if (!principal.pipelines.includes(pipeline)) {
    throw new ORPCError('FORBIDDEN', {
      message: `${principal.principal} may not request pipeline ${pipeline}`,
    });
  }
}

/** Both sides go through the same schema first, so the comparison is over
 *  normalized values (identical key order, coercions applied) rather than
 *  over whatever shape the caller happened to send. */
function sameSpec(a: WorkSpec, b: WorkSpec): boolean {
  return (
    JSON.stringify(workSpecSchema.parse(a)) ===
    JSON.stringify(workSpecSchema.parse(b))
  );
}

export const workRouter = os.router({
  create: operator.create.handler(async ({ input, context, errors }) => {
    const { principal } = context;
    assertPipelineGranted(principal, input.spec.pipeline);
    if (!isControlPlaneRepository(input.spec.target.repo)) {
      throw errors.FORBIDDEN({
        message: `${input.spec.target.repo} is not a control-plane repository`,
      });
    }

    // Idempotency by client ULID: the same id and spec replays to the item
    // that already exists (still 201 -- see the contract's successStatus),
    // a different spec is a client bug and is refused rather than silently
    // ignored.
    const existing = await context.runtime.store.readTask({
      workId: input.id,
    });
    if (existing !== undefined) {
      const stored = workPayloadSchema.parse(existing.task.work);
      if (!sameSpec(stored.spec, input.spec)) {
        throw errors.CONFLICT({
          message: `item ${input.id} already exists with a different spec`,
        });
      }
      return view(context, input.id, existing.task);
    }

    if ((await liveNativeRunCount(context)) >= context.maxLiveRuns) {
      throw errors.TOO_MANY_REQUESTS({
        data: { retryAfterSeconds: RETRY_AFTER_SECONDS },
      });
    }

    const outcome = await context.runtime.orchestrator.request({
      taskId: { workId: input.id },
      requestId: input.id,
      pipeline: input.spec.pipeline,
      work: {
        origin: {
          principal: principal.principal,
          channel: principal.via === 'session' ? 'console' : 'api',
        },
        spec: input.spec,
      },
    });
    if (isRefusal(outcome)) {
      throw errors.CONFLICT({ message: outcome.reason });
    }
    await context.runtime.drain();
    return view(context, input.id, outcome.task);
  }),

  get: operator.get.handler(async ({ input, context, errors }) => {
    const task = await context.runtime.store.readTask({ workId: input.id });
    if (task === undefined) throw errors.NOT_FOUND();
    return view(context, input.id, task.task);
  }),

  list: operator.list.handler(async ({ input, context }) => {
    const tasks = await context.runtime.store.listNativeTasks();
    const native = tasks.flatMap(({ task }) =>
      isWorkAnchor(task.task) ? [{ workId: task.task.workId, task }] : [],
    );

    // Two passes on purpose. Filtering needs derived state, which needs
    // each item's runs -- but the session join reads a *different*
    // database, so it runs only over the items that survive the filters
    // and the limit rather than over every native task ever created.
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

      // The item's declared pipeline, not the last run's: the spec is what
      // the operator asked for, and a run's pipeline is only ever a copy of
      // it. Re-checked against the grant because invoking a pipeline is a
      // capability -- redispatch mints a fresh run, so it needs the same
      // permission `create` did, and the principal here need not be the one
      // that created the item.
      const { spec } = workPayloadSchema.parse(task.task.work);
      assertPipelineGranted(context.principal, spec.pipeline);

      if ((await liveNativeRunCount(context)) >= context.maxLiveRuns) {
        throw errors.TOO_MANY_REQUESTS({
          data: { retryAfterSeconds: RETRY_AFTER_SECONDS },
        });
      }

      const outcome = await context.runtime.orchestrator.request({
        taskId: { workId: input.id },
        requestId: `${input.id}:${task.task.runCount + 1}`,
        pipeline: spec.pipeline,
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
 * The OpenAPI (RESTful) adapter for {@link workRouter}. Error codes map to
 * HTTP status through oRPC's own `COMMON_ERROR_STATUS_MAP`
 * (`UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409,
 * `TOO_MANY_REQUESTS` 429), which is exactly what this API wants -- so no
 * `errorStatusMap` override.
 */
export function createWorkHandler(): OpenAPIHandler<WorkContext> {
  return new OpenAPIHandler(workRouter, {
    routingInterceptors: [
      // `Retry-After` is the standard way to say what the 429 body's
      // `retryAfterSeconds` says, and generic HTTP clients honour it.
      // A routing interceptor is the only hook that sees the *encoded*
      // error response: `interceptors` run inside the try block, before
      // the codec turns a thrown ORPCError into a status and body.
      async (options) => {
        const result = await options.next();
        if (result.matched && result.response.status === 429) {
          result.response.headers['retry-after'] = String(RETRY_AFTER_SECONDS);
        }
        return result;
      },
    ],
  });
}
