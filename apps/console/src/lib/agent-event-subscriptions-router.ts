import 'server-only';

import { createHash } from 'node:crypto';

import {
  isLive,
  isWorkAnchor,
  type Run,
  runRecoveryDeadline,
} from '@agent-lcars/orchestrator';
import { displayLiveness, type SessionDoc } from '@agent-lcars/telemetry';
import {
  type AgentEvent,
  agentEventsContract,
  type AgentEventSubscription,
  type AgentEventSubscriptionView,
  GITHUB_STREAM_KINDS,
  MAX_AGENT_EVENT_CLOCK_SKEW_MS,
  parseAgentEventKey,
  validateSubscriptionRequest,
} from '@agent-lcars/work';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import type { AgentEventSubscriptionStore } from './agent-event-store';
import { runTokenMatches } from './run-token';
import type { WorkPrincipal } from './work-auth';

export interface AgentEventsContext {
  /** Repositories whose App webhooks this console consumes. */
  githubRepositories: readonly string[];
  principal?: WorkPrincipal;
  /** The raw `Authorization: Bearer` value, checked as a run token only
   * when it did not verify as a principal. */
  bearerToken?: string;
  /** One run document, for a run-token caller (#3570). */
  readRun: (runId: string) => Promise<Run | undefined>;
  store: AgentEventSubscriptionStore;
  /** One telemetry session document, or `undefined` when it cannot be read. */
  getSessionDoc: (sessionId: string) => Promise<SessionDoc | undefined>;
  now: () => Date;
  /** Routes one event to its subscriptions (`routeAgentEvent`). */
  routeEvent: (
    event: AgentEvent,
  ) => Promise<{ eventId: string; deliveries: readonly { outcome: string }[] }>;
  routeGithubEvent: (
    event: AgentEvent,
    host: string,
  ) => Promise<{ eventId: string; deliveries: readonly { outcome: string }[] }>;
}

/** At most this many subscriptions per session; a runaway loop in one
 * session cannot fill the collection. */
export const MAX_SUBSCRIPTIONS_PER_SESSION = 64;

/** At most this many subscriptions per native Work, made by its runs. */
export const MAX_SUBSCRIPTIONS_PER_WORK = 16;

/** Pipelines whose runs an event can resume: the agent CLIs the direct
 * runner starts in `event` mode. Recipes and claw agents run their own
 * modes and cannot be resumed this way. */
const EVENT_RESUMABLE_PIPELINES: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'opencode',
  'agy',
]);
const EVENT_RESUMABLE_MODES: ReadonlySet<string> = new Set([
  'implement',
  'reply',
  'event',
]);

/** The host a delivery agent's verified service-account email names:
 * `agent-events-<host>@<project>.iam.gserviceaccount.com`. The account ids
 * come from `infra/terraform/agent_events.tf`. */
const DELIVERY_SUBJECT =
  /^agent-events-([a-z][a-z0-9-]{0,16})@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u;

export function deliveryHost(
  principal: Pick<WorkPrincipal, 'subject' | 'via'>,
): string | undefined {
  if (principal.via !== 'google') return undefined;
  return DELIVERY_SUBJECT.exec(principal.subject.toLowerCase())?.[1];
}

/** Whether the session telemetry says this session is running on `host`:
 * an interactive CLI session, reported by that host, that has not ended.
 * A stored `live` that has gone quiet decays the way the console shows it. */
export function sessionLiveOnHost(
  doc: SessionDoc | undefined,
  host: string,
  now: Date,
): boolean {
  if (doc?.source !== 'cli' || doc.host?.toLowerCase() !== host) return false;
  if (doc.liveness === 'ended' || doc.liveness === 'stale') return false;
  const shown = displayLiveness(
    doc.liveness,
    doc.lastActivityAt,
    now.toISOString(),
    doc.observedAt,
  );
  return shown === 'live' || shown === 'idle';
}

/** Whether the session telemetry names `host` as the session's own, live
 * or not: an `ended` report arrives after the session stopped. */
export function sessionReportedByHost(
  doc: SessionDoc | undefined,
  host: string,
): boolean {
  return doc?.source === 'cli' && doc.host?.toLowerCase() === host;
}

/** A host's clock may run a little ahead; a report from further ahead is
 * malformed. */
export const MAX_REPORT_CLOCK_SKEW_MS = MAX_AGENT_EVENT_CLOCK_SKEW_MS;

/** One id per session, kind and moment, so a report the host repeats after
 * a lost answer routes as a duplicate. */
export function sessionEventId(
  sessionId: string,
  kind: string,
  occurredAt: string,
): string {
  return `session.${sessionId}.${kind}.${occurredAt}`;
}

/** The same session, key, kinds and until always get the same id, so a
 * retried subscribe returns what the first one created. */
export function agentEventSubscriptionId(
  subscription: Pick<
    AgentEventSubscription,
    'key' | 'kinds' | 'until' | 'target'
  >,
): string {
  const kinds = subscription.kinds ? [...subscription.kinds].sort() : null;
  return createHash('sha256')
    .update(
      JSON.stringify([
        subscription.target,
        subscription.key,
        kinds,
        subscription.until ?? null,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

function view(
  subscription: AgentEventSubscription,
  context: AgentEventsContext,
): AgentEventSubscriptionView {
  const native =
    subscription.target.type === 'session' &&
    subscription.source === 'github:pr' &&
    !isAppRepository(subscription.key, subscription.source, context);
  const kinds =
    subscription.kinds ?? (native ? GITHUB_STREAM_KINDS : undefined);
  return {
    ...(native ? { githubStream: true } : {}),
    id: subscription.id,
    key: subscription.key,
    source: subscription.source,
    ...(kinds === undefined ? {} : { kinds: [...kinds] }),
    ...(subscription.until === undefined ? {} : { until: subscription.until }),
    target: subscription.target,
    createdAt: subscription.createdAt,
  };
}

const os = implement(agentEventsContract).$context<AgentEventsContext>();

/** Who is calling: a host's delivery identity, or a dispatched run whose
 * token is checked against the run named in the request. */
type Caller =
  | { readonly kind: 'host'; readonly host: string }
  | { readonly kind: 'run'; readonly token: string };

/** Every procedure is built from `authenticated`: the caller holds
 * `events.deliver` as a host's delivery identity, or presents a bearer that
 * verified as no principal at all, which each handler then checks as the
 * token of the run its input names. It runs before input validation, like
 * the Work API's other scope gates. */
const authenticated = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (principal === undefined && context.bearerToken !== undefined)
    return next({
      context: {
        caller: { kind: 'run', token: context.bearerToken } as Caller,
      },
    });
  if (!principal?.scopes.has('events.deliver'))
    throw new ORPCError('UNAUTHORIZED', {
      message: 'events.deliver scope or a run token required',
    });
  const host = deliveryHost(principal);
  // A grant carrying the scope for any other subject is a configuration
  // error; it confers nothing.
  if (host === undefined)
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Only a host delivery identity may manage event subscriptions',
    });
  return next({ context: { caller: { kind: 'host', host } as Caller } });
});

/** The run a run-token caller acts as: its token must match the run's
 * claim, and the run must still be live within its lease -- the same checks
 * every run-token route makes. One answer for each failure. */
async function runCaller(
  context: AgentEventsContext & { caller: Caller },
  runId: string | undefined,
): Promise<Run> {
  if (context.caller.kind !== 'run')
    throw new ORPCError('BAD_REQUEST', {
      message: 'runId is only for a dispatched run calling with its run token',
    });
  // A bearer that verified as no principal and names no run is judged as
  // an unauthenticated caller, so a host whose ID token failed verification
  // reads 401, not a request-shape error.
  if (runId === undefined)
    throw new ORPCError('UNAUTHORIZED', {
      message: 'events.deliver scope, or a run token with its runId, required',
    });
  const run = await context.readRun(runId);
  if (
    run?.queue?.tokenHash === undefined ||
    !runTokenMatches(context.caller.token, run.queue.tokenHash) ||
    !isLive(run.state) ||
    Date.parse(runRecoveryDeadline(run) ?? run.leaseExpiresAt) <=
      context.now().getTime()
  )
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Invalid or expired run token',
    });
  return run;
}

function requireHost(caller: Caller): string {
  if (caller.kind !== 'host')
    throw new ORPCError('UNAUTHORIZED', {
      message: 'events.deliver scope required',
    });
  return caller.host;
}

/** A run's own native Work, if an event can resume it. */
function resumableWorkId(run: Run): string | undefined {
  if (!isWorkAnchor(run.task)) return undefined;
  if (!EVENT_RESUMABLE_PIPELINES.has(run.pipeline)) return undefined;
  if (!EVENT_RESUMABLE_MODES.has(run.params?.['mode'] ?? '')) return undefined;
  return run.task.workId;
}

/** The Work a run caller's subscriptions belong to; any run of the Work
 * may see and remove them. */
function ownWorkId(run: Run): string | undefined {
  return isWorkAnchor(run.task) ? run.task.workId : undefined;
}

/** A registration is a wakeup contract, not just a syntactically valid key.
 * Reject sources without a deployed producer so callers can use their fallback.
 * Keep this at the source owner; clients must not copy the fleet inventory. */
function isAppRepository(
  key: string,
  source: string,
  context: AgentEventsContext,
): boolean {
  const repository = key
    .slice(source.length + 1)
    .split(/[/#]/u)
    .slice(0, 2)
    .join('/');
  return context.githubRepositories.some(
    (repo) => repo.toLowerCase() === repository,
  );
}

function requireAvailableSource(
  value: Extract<
    ReturnType<typeof validateSubscriptionRequest>,
    { ok: true }
  >['value'],
  context: AgentEventsContext,
  githubStream = false,
): void {
  if (value.source === 'outline:doc')
    throw new ORPCError('FORBIDDEN', {
      message: 'Outline event delivery is not available yet',
    });
  if (value.source.startsWith('github:')) {
    const repository = value.key
      .slice(value.source.length + 1)
      .split(/[/#]/u)
      .slice(0, 2)
      .join('/');
    if (!isAppRepository(value.key, value.source, context)) {
      if (githubStream && value.source === 'github:pr') {
        const supported: readonly string[] = GITHUB_STREAM_KINDS;
        const requested = value.kinds ?? supported;
        if (
          requested.every((kind) => supported.includes(kind)) &&
          (!value.until || supported.includes(value.until))
        )
          return;
        throw new ORPCError('FORBIDDEN', {
          message: `GitHub preview streams support only ${supported.join(', ')}`,
        });
      }
      throw new ORPCError('FORBIDDEN', {
        message: `GitHub event delivery is not available for ${repository}: the App source does not watch this repository`,
      });
    }
  }
}

export const agentEventsRouter = os.router({
  subscribe: authenticated.subscribe.handler(
    async ({ input, context, errors }) => {
      const validated = validateSubscriptionRequest({
        key: input.key,
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        ...(input.until === undefined ? {} : { until: input.until }),
      });
      const now = context.now();
      if (context.caller.kind === 'run') {
        const run = await runCaller(context, input.runId);
        if (input.githubStream)
          throw errors.BAD_REQUEST({
            message: 'Native Work cannot use a host GitHub stream',
          });
        if (input.sessionId !== undefined)
          throw errors.BAD_REQUEST({
            message: 'A run subscribes its Work, not a session',
          });
        const workId = resumableWorkId(run);
        if (workId === undefined)
          throw errors.FORBIDDEN({
            message: isWorkAnchor(run.task)
              ? 'This run’s Work cannot be resumed by an event: only agent runs (claude, codex, opencode, agy) of coding Work can'
              : 'Only a run of native Work can subscribe; LCARS already resumes issue and pull-request work on reviews and CI',
          });
        if (input.workId !== undefined && input.workId !== workId)
          throw errors.FORBIDDEN({
            message: 'A run may subscribe only its own Work',
          });
        if (!validated.ok)
          throw errors.BAD_REQUEST({ message: validated.error });
        if (validated.value.key === `lcars:work:${workId}`)
          throw errors.BAD_REQUEST({
            message: 'A Work cannot subscribe to its own state',
          });
        requireAvailableSource(validated.value, context);
        const target = { type: 'work' as const, workId };
        const subscription: AgentEventSubscription = {
          ...validated.value,
          id: agentEventSubscriptionId({ ...validated.value, target }),
          target,
          createdAt: now.toISOString(),
        };
        const existing = await context.store.get(subscription.id);
        if (existing !== undefined) return view(existing, context);
        if (
          (await context.store.listForWork(workId)).length >=
          MAX_SUBSCRIPTIONS_PER_WORK
        )
          throw errors.CONFLICT({
            message: `Work ${workId} already has ${MAX_SUBSCRIPTIONS_PER_WORK} subscriptions`,
          });
        return view(
          (await context.store.create(subscription)).subscription,
          context,
        );
      }
      const host = requireHost(context.caller);
      if (input.runId !== undefined || input.workId !== undefined)
        throw errors.BAD_REQUEST({
          message:
            'Work targets are subscribed by a dispatched run with its run token; subscribe a session with sessionId',
        });
      if (input.sessionId === undefined)
        throw errors.BAD_REQUEST({ message: 'sessionId is required' });
      if (!validated.ok) throw errors.BAD_REQUEST({ message: validated.error });
      // One answer for a missing session, a session on another host, and an
      // ended one: a host learns nothing about sessions it does not run.
      if (
        !sessionLiveOnHost(
          await context.getSessionDoc(input.sessionId),
          host,
          now,
        )
      )
        throw errors.FORBIDDEN({
          message: `Session ${input.sessionId} is not a live session reported by ${host}`,
        });
      requireAvailableSource(
        validated.value,
        context,
        input.githubStream === true,
      );
      const target = {
        type: 'session' as const,
        sessionId: input.sessionId,
        host,
      };
      const subscription: AgentEventSubscription = {
        ...validated.value,
        id: agentEventSubscriptionId({ ...validated.value, target }),
        target,
        createdAt: now.toISOString(),
      };
      const existing = await context.store.get(subscription.id);
      if (existing !== undefined) return view(existing, context);
      if (
        (await context.store.countForSession(input.sessionId)) >=
        MAX_SUBSCRIPTIONS_PER_SESSION
      )
        throw errors.CONFLICT({
          message: `Session ${input.sessionId} already has ${MAX_SUBSCRIPTIONS_PER_SESSION} subscriptions`,
        });
      return view(
        (await context.store.create(subscription)).subscription,
        context,
      );
    },
  ),
  list: authenticated.list.handler(async ({ input, context }) => {
    let subscriptions: AgentEventSubscription[];
    if (context.caller.kind === 'run') {
      const workId = ownWorkId(await runCaller(context, input.runId));
      subscriptions =
        workId === undefined ? [] : await context.store.listForWork(workId);
    } else {
      if (input.runId !== undefined)
        throw new ORPCError('BAD_REQUEST', {
          message:
            'runId is only for a dispatched run calling with its run token',
        });
      subscriptions = await context.store.listForHost(
        context.caller.host,
        input.sessionId,
      );
    }
    return {
      subscriptions: subscriptions
        .map((subscription) => view(subscription, context))
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    };
  }),
  reportGithub: authenticated.reportGithub.handler(
    async ({ input, context, errors }) => {
      const host = requireHost(context.caller);
      const event = input.event;
      const parsed = parseAgentEventKey(event.key);
      const supported: readonly string[] = GITHUB_STREAM_KINDS;
      if (
        !parsed.ok ||
        parsed.value.source !== 'github:pr' ||
        isAppRepository(event.key, 'github:pr', context) ||
        !supported.includes(event.kind)
      ) {
        throw errors.FORBIDDEN({
          message: 'Host GitHub events are only for non-App PR preview streams',
        });
      }
      if (
        Date.parse(event.occurredAt) - context.now().getTime() >
        MAX_REPORT_CLOCK_SKEW_MS
      )
        throw errors.BAD_REQUEST({ message: 'occurredAt is in the future' });
      const [repository, number] = parsed.value.id.split('#');
      // The link is always generated here, never supplied by an external payload.
      const routed = await context.routeGithubEvent(
        { ...event, link: `https://github.com/${repository}/pull/${number}` },
        host,
      );
      return {
        eventId: routed.eventId,
        delivered: routed.deliveries.filter((d) => d.outcome === 'published')
          .length,
      };
    },
  ),
  reportSession: authenticated.reportSession.handler(
    async ({ input, context, errors }) => {
      const host = requireHost(context.caller);
      const now = context.now();
      if (
        Date.parse(input.occurredAt) - now.getTime() >
        MAX_REPORT_CLOCK_SKEW_MS
      )
        throw errors.BAD_REQUEST({ message: 'occurredAt is in the future' });
      const doc = await context.getSessionDoc(input.sessionId);
      // An idle session must still be live here; an ended one has stopped,
      // so only the host the telemetry names for it is checked. One answer
      // for every refusal, as with subscribe.
      const accepted =
        input.kind === 'ended'
          ? sessionReportedByHost(doc, host)
          : sessionLiveOnHost(doc, host, now);
      if (!accepted)
        throw errors.FORBIDDEN({
          message: `Session ${input.sessionId} is not a ${input.kind === 'ended' ? '' : 'live '}session reported by ${host}`,
        });
      const event: AgentEvent = {
        id: sessionEventId(input.sessionId, input.kind, input.occurredAt),
        key: `lcars:session:${input.sessionId}`,
        kind: input.kind,
        occurredAt: input.occurredAt,
      };
      const routed = await context.routeEvent(event);
      return {
        eventId: routed.eventId,
        delivered: routed.deliveries.filter(
          (delivery) => delivery.outcome === 'published',
        ).length,
      };
    },
  ),
  unsubscribe: authenticated.unsubscribe.handler(
    async ({ input, context, errors }) => {
      const existing = await context.store.get(input.id);
      if (context.caller.kind === 'run') {
        const workId = ownWorkId(await runCaller(context, input.runId));
        // Another Work's subscription reads as absent.
        if (
          workId === undefined ||
          existing?.target.type !== 'work' ||
          existing.target.workId !== workId
        )
          throw errors.NOT_FOUND();
      } else {
        if (input.runId !== undefined) throw errors.NOT_FOUND();
        // Another host's subscription reads as absent.
        if (
          existing?.target.type !== 'session' ||
          existing.target.host !== context.caller.host
        )
          throw errors.NOT_FOUND();
      }
      if (!(await context.store.delete(input.id))) throw errors.NOT_FOUND();
      return { id: input.id, deleted: true as const };
    },
  ),
});

/** Served under the Work API's prefix beside the items and runs handlers. */
export function createAgentEventsHandler(): OpenAPIHandler<AgentEventsContext> {
  return new OpenAPIHandler(agentEventsRouter);
}
