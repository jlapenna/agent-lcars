import type { AgentEventSubscriptionRequest } from '@agent-lcars/work';

/**
 * STUB (#3568 slice 5 leaves this for after slice 3): forwarding
 * `lcars session subscribe` requests to the console.
 *
 * The delivery agent will listen on a Unix socket under the user's runtime
 * directory, accept a subscribe, list or unsubscribe request from a session
 * on this host, stamp this host on it, and forward it to the console's
 * subscription API with this host's own service-account identity, so the
 * router can check that the session's telemetry reports the same host. The
 * API (slice 3) is not merged yet; nothing listens on the socket and every
 * request is refused as not implemented.
 */
export interface LocalSubscribeRequest {
  readonly sessionId: string;
  readonly request: AgentEventSubscriptionRequest;
}

export type SubscribeForwardResult =
  | { readonly ok: true; readonly subscriptionId: string }
  | { readonly ok: false; readonly error: string };

export interface SubscribeForwarder {
  forward(request: LocalSubscribeRequest): Promise<SubscribeForwardResult>;
}

export const notImplementedSubscribeForwarder: SubscribeForwarder = {
  forward: async () => ({ ok: false, error: 'not-implemented' }),
};
