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
 * One POST to the console's ingest route. Only a response that says the
 * event itself is malformed (`400`, `413`, `422`) resolves it as `drop`. A
 * `401`/`403` (rotated or unknown token), `404` (ingest flag off), any 5xx,
 * a network failure or a timeout all ask the spool to keep the event: the
 * spool is size-capped, so waiting for the console to be enabled or the
 * token to be fixed costs bounded disk and loses nothing silently.
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
    if ([400, 413, 422].includes(response.status)) {
      return { outcome: 'drop', status: response.status };
    }
    return { outcome: 'retry', status: response.status };
  } catch {
    return { outcome: 'retry' };
  } finally {
    clearTimeout(timer);
  }
}
