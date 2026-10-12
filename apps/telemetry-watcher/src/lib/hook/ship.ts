import { type SessionEventV1 } from '@agent-lcars/telemetry';

import { type SpoolSendOutcome } from './spool';

export interface ShipOptions {
  readonly origin: string;
  readonly token: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs?: number;
}

export const SESSION_EVENTS_PATH = '/api/telemetry/v1/sessions';

/**
 * One POST to the console's ingest route. 2xx and the client-error
 * statuses that a retry can never fix (`400`, `401`, `403`, `404`, `413`,
 * `422`) both resolve the spooled event; everything else, including a
 * network failure or timeout, asks the spool to keep it for the next
 * flusher.
 */
export async function shipSessionEvent(
  event: SessionEventV1,
  options: ShipOptions,
): Promise<{ outcome: SpoolSendOutcome; status?: number }> {
  const url = `${options.origin.replace(/\/$/, '')}${SESSION_EVENTS_PATH}/${encodeURIComponent(event.sessionId)}/events`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 3_000,
  );
  try {
    const response = await options.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (response.ok) return { outcome: 'sent', status: response.status };
    if ([400, 401, 403, 404, 413, 422].includes(response.status)) {
      return { outcome: 'drop', status: response.status };
    }
    return { outcome: 'retry', status: response.status };
  } catch {
    return { outcome: 'retry' };
  } finally {
    clearTimeout(timer);
  }
}
