import { Octokit } from '@octokit/rest';
import { optional, required } from '@repo/util-server';

let client: Octokit | undefined;

export function getGithubClient(): Octokit {
  if (!client) {
    client = new Octokit({
      auth: required('AGENT_LCARS_GITHUB_TOKEN'),
      // Only ever set by the agent-lcars e2e suite, which has no real
      // GitHub credentials and instead points this at its own fixture route
      // (apps/console/src/app/api/e2e/github) so PR-join
      // assertions don't depend on the real GitHub API. Never set in prod
      // (absent from apphosting.yaml).
      ...(optional('AGENT_CONSOLE_GITHUB_API_BASE_URL') && {
        baseUrl: optional('AGENT_CONSOLE_GITHUB_API_BASE_URL'),
      }),
    });
  }
  return client;
}

/** Which coding-agent workflow pipeline a repo runs, and the filename each
 * one lives under by default (see agent-activity.ts's WORKFLOW_FILES).
 * Lives here, not in agent-activity.ts, so WatchedRepo below can reference
 * it without a circular import (agent-activity.ts already imports from this
 * file) - re-exported from agent-activity.ts for existing importers. */
export type AgentPipeline = 'claude' | 'codex' | 'opencode';

export interface WatchedRepo {
  owner: string;
  name: string;
  /** Per-pipeline override of agent-activity.ts's default WORKFLOW_FILES
   * filenames. A key absent from this map falls back to the default
   * filename; an explicit `null` marks a pipeline this repo doesn't run at
   * all, so it's simply not fetched for this repo (rather than 404ing
   * against a guessed filename). */
  workflowFiles?: Partial<Record<AgentPipeline, string | null>>;
}

/** The only repo this console has ever watched - kept as the fallback so an
 * unset `AGENT_LCARS_WATCHED_REPOS` reproduces today's single-repo behavior
 * exactly. */
export const DEFAULT_WATCHED_REPOS: WatchedRepo[] = [
  { owner: 'supersprinklesracing', name: 'members' },
];

function validateWatchedRepo(entry: unknown, index: number): WatchedRepo {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`AGENT_LCARS_WATCHED_REPOS[${index}] must be an object`);
  }
  const record = entry as Record<string, unknown>;

  const owner = record['owner'];
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error(
      `AGENT_LCARS_WATCHED_REPOS[${index}].owner must be a non-empty string`,
    );
  }
  const name = record['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(
      `AGENT_LCARS_WATCHED_REPOS[${index}].name must be a non-empty string`,
    );
  }
  const workflowFiles = record['workflowFiles'];
  if (workflowFiles !== undefined) {
    if (
      typeof workflowFiles !== 'object' ||
      workflowFiles === null ||
      Array.isArray(workflowFiles)
    ) {
      throw new Error(
        `AGENT_LCARS_WATCHED_REPOS[${index}].workflowFiles must be an object when present`,
      );
    }
    for (const [pipeline, value] of Object.entries(workflowFiles)) {
      if (typeof value !== 'string' && value !== null) {
        throw new Error(
          `AGENT_LCARS_WATCHED_REPOS[${index}].workflowFiles.${pipeline} must be a string or null`,
        );
      }
    }
  }

  return {
    owner,
    name,
    ...(workflowFiles && {
      workflowFiles: workflowFiles as Partial<
        Record<AgentPipeline, string | null>
      >,
    }),
  };
}

/**
 * Parses `AGENT_LCARS_WATCHED_REPOS`: a JSON array of
 * `{ "owner": string, "name": string, "workflowFiles"?: Partial<Record<AgentPipeline, string>> }`
 * objects, e.g.
 * `[{"owner":"supersprinklesracing","name":"members"},{"owner":"supersprinklesracing","name":"website"}]`.
 * Throws with a specific reason on malformed input rather than falling back
 * silently, mirroring apps/telemetry-watcher/src/lib/config.ts's
 * parseWatchRootsJson - a broken config should fail loudly at startup, not
 * silently watch the wrong (or no) repos.
 */
function parseWatchedReposJson(raw: string): WatchedRepo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `AGENT_LCARS_WATCHED_REPOS is not valid JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      'AGENT_LCARS_WATCHED_REPOS must be a non-empty JSON array of {owner, name, workflowFiles?} objects',
    );
  }
  return parsed.map((entry, index) => validateWatchedRepo(entry, index));
}

/** The curated repo list this console watches, sourced from
 * `AGENT_LCARS_WATCHED_REPOS` (JSON array) when set, otherwise
 * {@link DEFAULT_WATCHED_REPOS}. */
export function getWatchedRepos(): WatchedRepo[] {
  const raw = optional('AGENT_LCARS_WATCHED_REPOS');
  return raw ? parseWatchedReposJson(raw) : DEFAULT_WATCHED_REPOS;
}

/** The repo global, ops-style actions (quick task, unstick-prs, nx cache
 * eviction) target when the UI doesn't offer a per-action repo picker -
 * always the first watched repo, matching today's single-repo behavior. */
export function primaryWatchedRepo(): WatchedRepo {
  return getWatchedRepos()[0];
}

export function repoKey(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
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
