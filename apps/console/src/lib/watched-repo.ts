/**
 * Pure repo-identity types/helpers, deliberately split out of
 * github-client.ts: that file imports `@repo/util-server` (env/secrets
 * access, `assertNotBrowser()`-guarded), so anything importing it - even
 * for just these types - gets pulled into a 'use client' component's
 * browser bundle and fails to build (Node-only deps like firebase-admin
 * can't bundle for the browser). This file has zero server dependencies
 * and is safe to import from client components.
 */

/** Which coding-agent workflow pipeline a repo runs, and the filename each
 * one lives under by default (see agent-activity.ts's WORKFLOW_FILES). */
export type AgentPipeline = 'claude' | 'codex' | 'opencode';

export interface WatchedRepo {
  owner: string;
  name: string;
  /** Per-pipeline override of agent-activity.ts's default WORKFLOW_FILES
   * filenames. A key absent from this map falls back to the default
   * filename; an explicit `null` marks a pipeline this repo doesn't run at
   * all, so it's simply not fetched for this repo. */
  workflowFiles?: Partial<Record<AgentPipeline, string | null>>;
  /** Display name shown in the UI instead of `owner/name` (repoKey's
   * format) wherever a repo badge/title is rendered - e.g. a shorter label
   * for a long or noisy repo name. Purely cosmetic: never affects GitHub
   * API calls, URLs, or the identity keys `repoKey`/`repoItemKey` produce. */
  alias?: string;
}

export function repoKey(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

/** The name to render in the UI for a repo: its configured `alias` when
 * set, otherwise `repoKey`'s `owner/name`. Use this instead of `repoKey`
 * anywhere a repo name is *displayed*; keep using `repoKey` for identity
 * (keys, URLs, filter matching). */
export function repoDisplayName(repo: {
  owner: string;
  name: string;
  alias?: string;
}): string {
  return repo.alias && repo.alias.length > 0 ? repo.alias : repoKey(repo);
}

/** Cross-repo-safe join/dedupe key for issue and PR numbers, which only
 * disambiguate within a single repo. GitHub Actions run ids are already
 * globally unique across repos and never need this. */
export function repoItemKey(
  repo: { owner: string; name: string },
  number: number,
): string {
  return `${repoKey(repo)}#${number}`;
}
