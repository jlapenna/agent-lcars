import 'server-only';

import { parseDispatchMarker } from '@agent-lcars/dispatch-contracts';

import type { CompletionOidcIdentity } from './github-actions-oidc';
import type { DispatchTokenProvider } from './orchestrator-dispatch';

const GITHUB_API = 'https://api.github.com';

export type RunBinding =
  { bound: true } | { bound: false; reason: 'marker-mismatch' | 'no-marker' };

/** GitHub could not answer: the caller must fail closed, never settle. */
export class BindingUnavailable extends Error {
  override readonly name = 'BindingUnavailable';
}

export interface RunBindingDeps {
  tokens: DispatchTokenProvider;
  fetchImpl?: typeof fetch;
  githubApiBaseUrl?: string;
}

/**
 * Prove the verified token belongs to the workflow run the orchestrator
 * dispatched for `runId`: the OIDC claims prove "a trusted finalizer on an
 * allowed repository", and the dispatch marker in that Actions run's
 * display title proves "for *this* run". Same join
 * `orchestrator-terminal-runs.ts` uses to settle terminal runs.
 */
export async function bindCompletionToRun(
  deps: RunBindingDeps,
  identity: CompletionOidcIdentity,
  runId: string,
  repo: string,
): Promise<RunBinding> {
  if (identity.repository !== repo) {
    return { bound: false, reason: 'marker-mismatch' };
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const base = (deps.githubApiBaseUrl ?? GITHUB_API).replace(/\/+$/u, '');
  let response: Response;
  try {
    const token = await deps.tokens.tokenFor(repo);
    response = await fetchImpl(
      `${base}/repos/${repo}/actions/runs/${identity.runId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
  } catch (error) {
    throw new BindingUnavailable(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    throw new BindingUnavailable(
      `actions run lookup returned ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    display_title?: string;
    name?: string;
  };
  const marker = parseDispatchMarker(body.display_title ?? body.name);
  if (marker === undefined) return { bound: false, reason: 'no-marker' };
  return marker.intentId === runId
    ? { bound: true }
    : { bound: false, reason: 'marker-mismatch' };
}
