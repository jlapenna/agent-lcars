import 'server-only';

import { createHash } from 'node:crypto';

import { optional } from '@agent-lcars/util-server';

const REFRESH_TIMEOUT_MS = 10_000;

/**
 * How long one refresh result stays answerable to a second request carrying
 * the same, now spent, refresh token. GitHub rotates the refresh token on
 * use, so a request that left the browser before the renewed session cookie
 * arrived would otherwise spend a dead token and be refused.
 */
const SHARED_RESULT_MS = 30_000;

export type GithubTokenRefresh =
  | {
      ok: true;
      accessToken: string;
      /** Epoch ms; absent when GitHub issued a token without an expiry. */
      accessTokenExpiresAt?: number;
      /** GitHub rotates this on every refresh; absent if it sent none. */
      refreshToken?: string;
      /** This answer reuses an exchange another request already made. */
      shared?: true;
    }
  | {
      ok: false;
      /** `refused`: GitHub rejected the refresh token. `failed`: no answer. */
      outcome: 'refused' | 'failed';
      /** GitHub's short error code (`bad_refresh_token`), never a token. */
      githubError?: string;
    };

const inFlight = new Map<string, Promise<GithubTokenRefresh>>();

/**
 * Exchanges a GitHub refresh token for a new user access token, as the
 * sign-in OAuth app. The sign-in app issues eight-hour access tokens, so the
 * console renews them instead of sending the operator back through GitHub.
 * Never throws. Returns nothing where there is no sign-in app to ask as (the
 * hermetic E2E suite, local runs without OAuth secrets).
 */
export function refreshGithubUserToken(
  refreshToken: string,
): Promise<GithubTokenRefresh | undefined> {
  const clientId = optional('AUTH_GITHUB_ID');
  const clientSecret = optional('AUTH_GITHUB_SECRET');
  if (
    !refreshToken ||
    !clientId ||
    !clientSecret ||
    optional('AGENT_CONSOLE_GITHUB_API_BASE_URL')
  ) {
    return Promise.resolve(undefined);
  }
  // Keyed by a digest so the map never holds a usable credential as a key.
  const key = createHash('sha256').update(refreshToken).digest('hex');
  const shared = inFlight.get(key);
  if (shared) {
    return shared.then((result) =>
      result.ok ? { ...result, shared: true as const } : result,
    );
  }
  const request = exchange(clientId, clientSecret, refreshToken);
  inFlight.set(key, request);
  void request.then((result) => {
    const forget = () => inFlight.delete(key);
    // Only a success is worth sharing; a failure may succeed on a retry.
    if (result.ok) setTimeout(forget, SHARED_RESULT_MS).unref();
    else forget();
  });
  return request;
}

async function exchange(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<GithubTokenRefresh> {
  try {
    const response = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      },
    );
    if (!response.ok) return { ok: false, outcome: 'failed' };
    const body = (await response.json()) as Record<string, unknown>;
    // GitHub reports a rejected refresh token as HTTP 200 with an `error`.
    if (typeof body['access_token'] !== 'string' || !body['access_token']) {
      return {
        ok: false,
        outcome: 'refused',
        ...(typeof body['error'] === 'string'
          ? { githubError: body['error'].slice(0, 64) }
          : {}),
      };
    }
    return {
      ok: true,
      accessToken: body['access_token'],
      ...(typeof body['expires_in'] === 'number'
        ? { accessTokenExpiresAt: Date.now() + body['expires_in'] * 1000 }
        : {}),
      ...(typeof body['refresh_token'] === 'string' && body['refresh_token']
        ? { refreshToken: body['refresh_token'] }
        : {}),
    };
  } catch {
    return { ok: false, outcome: 'failed' };
  }
}

/** Test seam: forget shared results between cases. */
export function resetGithubTokenRefreshForTests(): void {
  inFlight.clear();
}
