import 'server-only';

import type { DispatchTokenProvider } from './github-app-tokens';

/** Every fleet repository's caller of `agent-automerge-reusable.yml`. */
export const AUTOMERGE_WORKFLOW_FILE = 'agent-automerge.yml';

export interface AutomergeDispatchDeps {
  tokens: DispatchTokenProvider;
  fetchImpl?: typeof fetch;
  githubApiBaseUrl?: string;
}

/**
 * Runs `repo`'s Agent PR Auto-Merge sweep on `ref`. The reusable workflow's
 * `reconcile-automerge` job owns which pull requests it arms; this only makes
 * it run now. A repository without the workflow (404) has nothing to arm.
 *
 * Throws on any other failure; callers decide whether that is retryable.
 */
export async function dispatchAutomergeReconcile(
  deps: AutomergeDispatchDeps,
  repo: string,
  ref: string,
): Promise<'dispatched' | 'no-workflow'> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const apiBaseUrl = (
    deps.githubApiBaseUrl ?? 'https://api.github.com'
  ).replace(/\/+$/u, '');
  const token = await deps.tokens.tokenFor(repo);
  const response = await fetchImpl(
    `${apiBaseUrl}/repos/${repo}/actions/workflows/${AUTOMERGE_WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref }),
    },
  );
  if (response.status === 404) return 'no-workflow';
  if (!response.ok) {
    throw new Error(
      `auto-merge sweep dispatch for ${repo} failed: ${response.status} ${await response.text()}`,
    );
  }
  return 'dispatched';
}
