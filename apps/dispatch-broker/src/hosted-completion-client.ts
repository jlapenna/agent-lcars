import {
  COMPLETION_OIDC_AUDIENCE,
  type DispatchOutcomeKind,
  type DispatchOutcomeReference,
  HOSTED_COMPLETION_URL,
  type LaneReadinessFailure,
} from '@agent-lcars/dispatch-contracts';

export interface HostedCompletionPayload {
  issue: number;
  generation: number;
  intentId: string;
  token: string;
  workflow: string;
  outcome?: DispatchOutcomeKind;
  outcomeReference?: DispatchOutcomeReference;
  readinessFailure?: LaneReadinessFailure;
}

interface HostedCompletionClientOptions {
  payload: HostedCompletionPayload;
  oidcRequestUrl: string;
  oidcRequestToken: string;
  completionUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
}

class HostedCompletionRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HostedCompletionRequestError';
  }
}

function validatedHttpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostedCompletionRequestError(`${name} is not a valid URL`, false);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new HostedCompletionRequestError(
      `${name} must be an HTTPS URL without credentials or a fragment`,
      false,
    );
  }
  return url;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  {
    maxAttempts,
    sleep,
  }: {
    maxAttempts: number;
    sleep: (milliseconds: number) => Promise<void>;
  },
): Promise<T> {
  let delay = 1_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        !(error instanceof HostedCompletionRequestError) || error.retryable;
      if (!retryable || attempt === maxAttempts) throw error;
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error('Hosted completion retry loop exhausted unexpectedly');
}

async function requestOidcToken({
  oidcRequestUrl,
  oidcRequestToken,
  fetchImpl,
  sleep,
  timeoutMs,
  maxAttempts,
}: Required<
  Pick<
    HostedCompletionClientOptions,
    | 'oidcRequestUrl'
    | 'oidcRequestToken'
    | 'fetchImpl'
    | 'sleep'
    | 'timeoutMs'
    | 'maxAttempts'
  >
>): Promise<string> {
  const url = validatedHttpsUrl(oidcRequestUrl, 'GitHub OIDC request URL');
  url.searchParams.set('audience', COMPLETION_OIDC_AUDIENCE);

  return withRetry(
    async () => {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${oidcRequestToken}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new HostedCompletionRequestError(
          `GitHub OIDC token request failed with HTTP ${response.status}`,
          retryableStatus(response.status),
        );
      }
      const body = (await response.json()) as { value?: unknown };
      if (typeof body.value !== 'string' || body.value.length === 0) {
        throw new HostedCompletionRequestError(
          'GitHub OIDC token response did not contain a token',
          false,
        );
      }
      return body.value;
    },
    { maxAttempts, sleep },
  );
}

/**
 * Send a worker's immutable broker binding to the hosted control plane.
 * Both credentials are short-lived GitHub Actions OIDC values; response
 * bodies and tokens are deliberately absent from every thrown message.
 */
export async function sendHostedCompletion({
  payload,
  oidcRequestUrl,
  oidcRequestToken,
  completionUrl = HOSTED_COMPLETION_URL,
  fetchImpl = fetch,
  sleep = (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 15_000,
  maxAttempts = 3,
}: HostedCompletionClientOptions): Promise<void> {
  const endpoint = validatedHttpsUrl(
    completionUrl,
    'Hosted completion endpoint',
  );
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new HostedCompletionRequestError(
      'Hosted completion maxAttempts must be positive',
      false,
    );
  }
  const idToken = await requestOidcToken({
    oidcRequestUrl,
    oidcRequestToken,
    fetchImpl,
    sleep,
    timeoutMs,
    maxAttempts,
  });

  await withRetry(
    async () => {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new HostedCompletionRequestError(
          `Hosted completion request failed with HTTP ${response.status}`,
          retryableStatus(response.status),
        );
      }
    },
    { maxAttempts, sleep },
  );
}
