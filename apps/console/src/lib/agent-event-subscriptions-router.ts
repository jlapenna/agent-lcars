import 'server-only';

import { createHash } from 'node:crypto';

import { displayLiveness, type SessionDoc } from '@agent-lcars/telemetry';
import {
  agentEventsContract,
  type AgentEventSubscription,
  type AgentEventSubscriptionView,
  validateSubscriptionRequest,
} from '@agent-lcars/work';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement, ORPCError } from '@orpc/server';

import type { AgentEventSubscriptionStore } from './agent-event-store';
import type { WorkPrincipal } from './work-auth';

export interface AgentEventsContext {
  principal?: WorkPrincipal;
  store: AgentEventSubscriptionStore;
  /** One telemetry session document, or `undefined` when it cannot be read. */
  getSessionDoc: (sessionId: string) => Promise<SessionDoc | undefined>;
  now: () => Date;
}

/** At most this many subscriptions per session; a runaway loop in one
 * session cannot fill the collection. */
export const MAX_SUBSCRIPTIONS_PER_SESSION = 64;

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
): AgentEventSubscriptionView {
  return {
    id: subscription.id,
    key: subscription.key,
    source: subscription.source,
    ...(subscription.kinds === undefined
      ? {}
      : { kinds: [...subscription.kinds] }),
    ...(subscription.until === undefined ? {} : { until: subscription.until }),
    target: subscription.target,
    createdAt: subscription.createdAt,
  };
}

const os = implement(agentEventsContract).$context<AgentEventsContext>();

/** Every procedure is built from `delivery`: the caller must hold
 * `events.deliver` and be a host's delivery identity. It runs before input
 * validation, like the Work API's other scope gates. */
const delivery = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (!principal?.scopes.has('events.deliver'))
    throw new ORPCError('UNAUTHORIZED', {
      message: 'events.deliver scope required',
    });
  const host = deliveryHost(principal);
  // A grant carrying the scope for any other subject is a configuration
  // error; it confers nothing.
  if (host === undefined)
    throw new ORPCError('UNAUTHORIZED', {
      message: 'Only a host delivery identity may manage event subscriptions',
    });
  return next({ context: { host } });
});

export const agentEventsRouter = os.router({
  subscribe: delivery.subscribe.handler(async ({ input, context, errors }) => {
    if (input.workId !== undefined)
      throw errors.BAD_REQUEST({
        message:
          'Work targets are not supported yet (#3570); subscribe a session with sessionId',
      });
    if (input.sessionId === undefined)
      throw errors.BAD_REQUEST({ message: 'sessionId is required' });
    const validated = validateSubscriptionRequest({
      key: input.key,
      ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
      ...(input.until === undefined ? {} : { until: input.until }),
    });
    if (!validated.ok) throw errors.BAD_REQUEST({ message: validated.error });
    const { host } = context;
    const now = context.now();
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
    if (existing !== undefined) return view(existing);
    if (
      (await context.store.countForSession(input.sessionId)) >=
      MAX_SUBSCRIPTIONS_PER_SESSION
    )
      throw errors.CONFLICT({
        message: `Session ${input.sessionId} already has ${MAX_SUBSCRIPTIONS_PER_SESSION} subscriptions`,
      });
    return view((await context.store.create(subscription)).subscription);
  }),
  list: delivery.list.handler(async ({ input, context }) => {
    const subscriptions = await context.store.listForHost(
      context.host,
      input.sessionId,
    );
    return {
      subscriptions: subscriptions
        .map(view)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    };
  }),
  unsubscribe: delivery.unsubscribe.handler(
    async ({ input, context, errors }) => {
      const existing = await context.store.get(input.id);
      // Another host's subscription reads as absent.
      if (
        existing?.target.type !== 'session' ||
        existing.target.host !== context.host
      )
        throw errors.NOT_FOUND();
      if (!(await context.store.delete(input.id))) throw errors.NOT_FOUND();
      return { id: input.id, deleted: true as const };
    },
  ),
});

/** Served under the Work API's prefix beside the items and runs handlers. */
export function createAgentEventsHandler(): OpenAPIHandler<AgentEventsContext> {
  return new OpenAPIHandler(agentEventsRouter);
}
