import 'server-only';

import type { ItemState } from '@agent-lcars/work/derive';

import { controlPlaneRepository } from './deployment';
import { SESSION_EXPIRY_WORKFLOW_FILE } from './github-actions-oidc';
import type { DispatchTokenProvider } from './github-app-tokens';

/** Item states after which nothing will write the item's sessions again
 *  unless it is reopened. Their telemetry sessions get an `expireAt`. */
const CLOSED_ITEM_STATES: ReadonlySet<ItemState> = new Set([
  'done',
  'failed',
  'canceled',
]);

export function isClosedItemState(state: ItemState): boolean {
  return CLOSED_ITEM_STATES.has(state);
}

export interface SessionExpiryDispatchDeps {
  tokens: DispatchTokenProvider;
  fetchImpl?: typeof fetch;
  githubApiBaseUrl?: string;
}

/**
 * Asks `work-session-expiry.yml` to apply a native item's lifecycle to its
 * telemetry sessions. Called on the item's close transition: the sidecar
 * writes a native session without `expireAt` (so an open item's sessions are
 * never TTL-reaped), and the console cannot write the telemetry database
 * itself, so the workflow -- which reads the item through the Work API and
 * writes as `telemetry_writer` -- stamps the close. The workflow re-reads the
 * item's state, so a dispatch that races a reopen does no harm.
 *
 * Throws on any failure; callers decide whether that is retryable.
 */
export async function dispatchSessionExpiry(
  deps: SessionExpiryDispatchDeps,
  workId: string,
): Promise<void> {
  const repository = controlPlaneRepository();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const apiBaseUrl = (
    deps.githubApiBaseUrl ?? 'https://api.github.com'
  ).replace(/\/+$/u, '');
  const token = await deps.tokens.tokenFor(repository);
  const response = await fetchImpl(
    `${apiBaseUrl}/repos/${repository}/actions/workflows/${SESSION_EXPIRY_WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main', inputs: { item: workId } }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `session expiry dispatch for ${workId} failed: ${response.status} ${await response.text()}`,
    );
  }
}
