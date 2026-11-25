import {
  type AgentEvent,
  agentEventDeliveryId,
  agentEventSchema,
  agentEventTargetSchema,
  renderAgentEventNotice,
} from '@agent-lcars/work';
import { z } from 'zod';

/**
 * One delivery the console's router published to this host's subscription
 * (#3538, #3568): Pub/Sub attributes `host` and `delivery_id`, and a JSON
 * body naming the event, its subscription and the session to notify.
 *
 * Nothing in the body is typed as it arrives. The event is validated again
 * and the notice rendered here from it, so a message that is malformed,
 * meant for another host, or carries text the renderer would not produce
 * never reaches a terminal.
 */
export interface AgentEventDelivery {
  readonly deliveryId: string;
  readonly subscriptionId: string;
  readonly event: AgentEvent;
  /** The subscription ends with this delivery. */
  readonly ended: boolean;
  readonly sessionId: string;
  readonly host: string;
  /** Rendered here; the text the session receives. */
  readonly notice: string;
  /** Whether the router's notice matched this rendering. A mismatch means
   * the two run different versions of the renderer; the local one is used. */
  readonly noticeMatches: boolean;
}

export const INVALID_DELIVERY_REASONS = [
  'too-large',
  'malformed-json',
  'malformed-body',
  'invalid-event',
  'not-a-session',
  'wrong-host',
  'delivery-id-mismatch',
] as const;
export type InvalidDeliveryReason = (typeof INVALID_DELIVERY_REASONS)[number];

export type ParsedAgentEventDelivery =
  | { readonly ok: true; readonly value: AgentEventDelivery }
  | { readonly ok: false; readonly reason: InvalidDeliveryReason };

/** Far larger than a delivery is; bounds what is parsed at all. */
export const MAX_DELIVERY_BYTES = 64 * 1024;

const subscriptionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Unknown fields are ignored, so the router can add one without breaking
 * agents that have not been updated yet. */
const deliveryBodySchema = z.object({
  deliveryId: z.string().min(1).max(512),
  subscriptionId: z.string().regex(subscriptionIdPattern),
  event: z.unknown(),
  ended: z.boolean(),
  notice: z.string().max(8192),
  target: z.unknown(),
});

export function parseAgentEventDelivery(
  message: {
    readonly attributes: Readonly<Record<string, string>>;
    readonly data: Buffer;
  },
  host: string,
): ParsedAgentEventDelivery {
  if (message.data.length > MAX_DELIVERY_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  let json: unknown;
  try {
    json = JSON.parse(message.data.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  const body = deliveryBodySchema.safeParse(json);
  if (!body.success) return { ok: false, reason: 'malformed-body' };
  const event = agentEventSchema.safeParse(body.data.event);
  if (!event.success) return { ok: false, reason: 'invalid-event' };
  const target = agentEventTargetSchema.safeParse(body.data.target);
  if (!target.success || target.data.type !== 'session') {
    return { ok: false, reason: 'not-a-session' };
  }
  if (message.attributes['host'] !== host || target.data.host !== host) {
    return { ok: false, reason: 'wrong-host' };
  }
  const subscription = { id: body.data.subscriptionId };
  if (
    body.data.deliveryId !== agentEventDeliveryId(event.data, subscription) ||
    message.attributes['delivery_id'] !== body.data.deliveryId
  ) {
    return { ok: false, reason: 'delivery-id-mismatch' };
  }
  let notice: string;
  try {
    notice = renderAgentEventNotice(event.data, subscription, body.data.ended);
  } catch {
    return { ok: false, reason: 'invalid-event' };
  }
  return {
    ok: true,
    value: {
      deliveryId: body.data.deliveryId,
      subscriptionId: body.data.subscriptionId,
      event: event.data,
      ended: body.data.ended,
      sessionId: target.data.sessionId,
      host,
      notice,
      noticeMatches: notice === body.data.notice,
    },
  };
}
