import 'server-only';

import { logger } from '@agent-lcars/logging';
import type { GithubAnchor } from '@agent-lcars/orchestrator';
import { z } from 'zod';

import type { DispatchTokenProvider } from './github-app-tokens';

const GITHUB_API = 'https://api.github.com';
export const GITHUB_ANCHOR_LIFECYCLE_TIMEOUT_MS = 4_000;
const responseSchema = z.object({
  state: z.enum(['open', 'closed']),
  updated_at: z.iso.datetime({ offset: false }),
});

export interface GithubAnchorLifecycle {
  state: 'open' | 'closed';
  sourceUpdatedAt: string;
}

export interface GithubAnchorLifecycleDeps {
  tokens: DispatchTokenProvider;
  fetchImpl?: typeof fetch;
  githubApiBaseUrl?: string;
}

/**
 * Reads only the lifecycle fields needed to decide whether queued work may
 * launch. GitHub exposes pull requests through the issues endpoint too, so
 * this one bounded REST request covers both anchor kinds. An unavailable or
 * malformed response is unknown rather than closed: transient GitHub trouble
 * must not silently discard work.
 */
export async function loadGithubAnchorLifecycle(
  deps: GithubAnchorLifecycleDeps,
  anchor: GithubAnchor,
): Promise<GithubAnchorLifecycle | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GITHUB_ANCHOR_LIFECYCLE_TIMEOUT_MS,
  );
  try {
    const lifecycle = await Promise.race([
      (async () => {
        const token = await deps.tokens.tokenFor(anchor.repo);
        if (controller.signal.aborted) return undefined;
        const response = await (deps.fetchImpl ?? globalThis.fetch)(
          `${deps.githubApiBaseUrl ?? GITHUB_API}/repos/${anchor.repo}/issues/${anchor.issue}`,
          {
            method: 'GET',
            signal: controller.signal,
            headers: {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${token}`,
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        );
        if (!response.ok) {
          logger.error(
            'agent-lcars: anchor lifecycle lookup failed for %s#%s: %s',
            anchor.repo,
            anchor.issue,
            response.status,
          );
          return undefined;
        }
        const parsed = responseSchema.safeParse(await response.json());
        if (!parsed.success) {
          logger.error(
            'agent-lcars: anchor lifecycle lookup returned malformed data for %s#%s',
            anchor.repo,
            anchor.issue,
          );
          return undefined;
        }
        return {
          state: parsed.data.state,
          sourceUpdatedAt: parsed.data.updated_at,
        };
      })(),
      new Promise<undefined>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(undefined), {
          once: true,
        });
      }),
    ]);
    if (controller.signal.aborted) {
      logger.error(
        'agent-lcars: anchor lifecycle lookup timed out for %s#%s',
        anchor.repo,
        anchor.issue,
      );
      return undefined;
    }
    return lifecycle;
  } catch (error) {
    logger.error(
      'agent-lcars: anchor lifecycle lookup failed for %s#%s:',
      anchor.repo,
      anchor.issue,
      error,
    );
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
