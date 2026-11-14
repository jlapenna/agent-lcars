import 'server-only';

import { optional } from '@agent-lcars/util-server';

/** How long the console waits for GitHub's verdict before reporting none. */
const TOKEN_CHECK_TIMEOUT_MS = 5_000;

/**
 * What GitHub's own token registry says about an operator token it has just
 * refused. `present` with a 401 on the write means GitHub still lists the
 * token it rejected; `absent` means the token is gone, whatever the
 * operator's security log shows. Dates come from GitHub's record, never from
 * the token.
 */
export interface OperatorTokenRecord {
  tokenRecord: 'present' | 'absent' | 'unknown';
  tokenRecordCreatedAt?: string;
  tokenRecordExpiresAt?: string | null;
}

/**
 * Asks GitHub whether a refused operator token still exists, authenticating
 * as the sign-in OAuth app ("Check a token"). Read-only: it neither resets
 * nor revokes anything. Best effort by contract: the caller is already
 * reporting a refusal, so this never throws and never delays it past
 * TOKEN_CHECK_TIMEOUT_MS. Returns nothing where the console has no sign-in
 * app to ask as (the hermetic E2E suite, local runs without OAuth secrets).
 */
export async function describeRefusedOperatorToken(
  accessToken: string,
): Promise<OperatorTokenRecord | undefined> {
  const clientId = optional('AUTH_GITHUB_ID');
  const clientSecret = optional('AUTH_GITHUB_SECRET');
  if (
    !accessToken ||
    !clientId ||
    !clientSecret ||
    optional('AGENT_CONSOLE_GITHUB_API_BASE_URL')
  ) {
    return undefined;
  }
  try {
    const response = await fetch(
      `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ access_token: accessToken }),
        signal: AbortSignal.timeout(TOKEN_CHECK_TIMEOUT_MS),
      },
    );
    // 404 is GitHub's documented answer for a token it does not hold. Every
    // other failure, including the 422 it also uses for abuse protection,
    // establishes nothing about the registry.
    if (response.status === 404) return { tokenRecord: 'absent' };
    if (!response.ok) return { tokenRecord: 'unknown' };
    const record = (await response.json()) as {
      created_at?: unknown;
      expires_at?: unknown;
    };
    return {
      tokenRecord: 'present',
      ...(typeof record.created_at === 'string'
        ? { tokenRecordCreatedAt: record.created_at }
        : {}),
      ...(typeof record.expires_at === 'string' || record.expires_at === null
        ? { tokenRecordExpiresAt: record.expires_at }
        : {}),
    };
  } catch {
    return { tokenRecord: 'unknown' };
  }
}
