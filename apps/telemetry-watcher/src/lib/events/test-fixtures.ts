import {
  type AgentEvent,
  agentEventDeliveryId,
  renderAgentEventNotice,
} from '@agent-lcars/work';

export const HOST = 'pike';
export const SESSION = '00db4fb2-f273-4eb4-b7cf-7d84006b2d61';
export const SUBSCRIPTION = 'sub123';

export const EVENT: AgentEvent = {
  id: 'evt-1',
  key: 'lcars:session:other-session',
  kind: 'ended',
  occurredAt: '2026-11-25T12:00:00.000Z',
  actor: 'jlapenna',
  link: 'https://lcars.jlapenna.net/sessions/other-session',
};

export const DELIVERY_ID = agentEventDeliveryId(EVENT, { id: SUBSCRIPTION });

export function deliveryBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    deliveryId: DELIVERY_ID,
    subscriptionId: SUBSCRIPTION,
    event: EVENT,
    ended: true,
    notice: renderAgentEventNotice(EVENT, { id: SUBSCRIPTION }, true),
    target: { type: 'session', sessionId: SESSION, host: HOST },
    ...overrides,
  };
}

export function deliveryMessage(
  body: unknown = deliveryBody(),
  attributes: Record<string, string> = {
    host: HOST,
    delivery_id: DELIVERY_ID,
  },
): { attributes: Record<string, string>; data: Buffer } {
  return {
    attributes,
    data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
