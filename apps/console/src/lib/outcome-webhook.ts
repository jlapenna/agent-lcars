import 'server-only';

import { optional } from '@agent-lcars/util-server';
import { GoogleAuth } from 'google-auth-library';

/**
 * A settled native item's own outbound surface (design spec's "Slack
 * threads", decision 4). The outbox drain (`orchestrator-dispatch.ts`)
 * gains a delivery case, beside the existing GitHub outcome comment, for
 * any native item whose origin names a `thread`: its outcome is POSTed to
 * the registered webhook for that origin's `channel`, signed with this
 * console's runtime identity Google ID token for the target's audience --
 * the same mechanism `work-auth.ts` verifies on the inbound side, in the
 * other direction.
 */

export interface OutcomeWebhookTarget {
  url: string;
  audience: string;
}

/** Deliberately small, and nothing the console does not already render
 *  (spec: "no transcript content leaves the bucket"). */
export interface OutcomeWebhookPayload {
  itemId: string;
  runId: string;
  state: 'finished' | 'canceled' | 'lost';
  ok: boolean;
  parked: boolean;
  /** `Run.result.message`. */
  message?: string;
  /** `Run.result.ref`, e.g. the PR URL. */
  ref?: string;
  /** `origin.thread`, echoed back for the adapter to route on. */
  thread: string;
  consoleUrl: string;
}

function isOutcomeWebhookTarget(value: unknown): value is OutcomeWebhookTarget {
  if (typeof value !== 'object' || value === null) return false;
  const { url, audience } = value as Record<string, unknown>;
  return (
    typeof url === 'string' &&
    url.length > 0 &&
    typeof audience === 'string' &&
    audience.length > 0
  );
}

/**
 * `AGENT_LCARS_OUTCOME_WEBHOOKS` -- a JSON map from `origin.channel` to its
 * delivery target. Absent, empty, or malformed in any way (invalid JSON,
 * not an object, an entry missing `url`/`audience`) all resolve to
 * `undefined` rather than throwing: a broken config must never break the
 * outbox drain that calls this on every native item's settlement.
 */
export function outcomeWebhookFor(
  channel: string,
): OutcomeWebhookTarget | undefined {
  const raw = optional('AGENT_LCARS_OUTCOME_WEBHOOKS');
  if (raw === undefined || raw.trim() === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const entry = (parsed as Record<string, unknown>)[channel];
  return isOutcomeWebhookTarget(entry) ? entry : undefined;
}

let cachedAuth: GoogleAuth | undefined;
function runtimeAuth(): GoogleAuth {
  return (cachedAuth ??= new GoogleAuth());
}

/**
 * POSTs a settled run's outcome to its origin's registered webhook. Throws
 * on any non-2xx response or transport failure -- the outbox drain treats
 * that exactly like a GitHub outcome-comment delivery failure: released
 * with backoff, retired after the existing window, never a lost run.
 */
export async function deliverOutcomeWebhook(
  target: OutcomeWebhookTarget,
  payload: OutcomeWebhookPayload,
): Promise<void> {
  const client = await runtimeAuth().getIdTokenClient(target.audience);
  const headers = await client.getRequestHeaders(target.url);
  headers.set('Content-Type', 'application/json');

  const response = await fetch(target.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `outcome webhook ${target.url} returned ${response.status}`,
    );
  }
}
