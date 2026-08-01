import { Octokit } from '@octokit/rest';
import { optional, required } from '@repo/util-server';

import {
  type AgentIntegration,
  type AgentPipeline,
  repoDisplayName,
  repoItemKey,
  repoKey,
  type WatchedRepo,
} from './watched-repo';

// Re-exported for existing importers - this file used to define these
// itself, but they now live in watched-repo.ts (a client-bundle-safe file
// with no @repo/util-server dependency) so client components can import
// them without accidentally pulling this file's server-only deps
// (firebase-admin, google-auth-library, ...) into a browser bundle.
export {
  type AgentPipeline,
  repoDisplayName,
  repoItemKey,
  repoKey,
  type WatchedRepo,
};

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

/** The only repo this console has ever watched - kept as the fallback so an
 * unset `AGENT_LCARS_WATCHED_REPOS` reproduces today's single-repo behavior
 * exactly. */
export const DEFAULT_WATCHED_REPOS: WatchedRepo[] = [
  { owner: 'supersprinklesracing', name: 'sprinkles', alias: 'sprinkles' },
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
  const alias = record['alias'];
  if (
    alias !== undefined &&
    (typeof alias !== 'string' || alias.length === 0)
  ) {
    throw new Error(
      `AGENT_LCARS_WATCHED_REPOS[${index}].alias must be a non-empty string when present`,
    );
  }

  const agents = record['agents'];
  if (agents !== undefined) {
    if (
      typeof agents !== 'object' ||
      agents === null ||
      Array.isArray(agents)
    ) {
      throw new Error(
        `AGENT_LCARS_WATCHED_REPOS[${index}].agents must be an object when present`,
      );
    }
    const supportedPipelines: AgentPipeline[] = ['claude', 'codex', 'opencode'];
    for (const [pipeline, value] of Object.entries(agents)) {
      if (!supportedPipelines.includes(pipeline as AgentPipeline)) {
        throw new Error(
          `AGENT_LCARS_WATCHED_REPOS[${index}].agents.${pipeline} is not a supported agent pipeline`,
        );
      }
      if (value === null) continue;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(
          `AGENT_LCARS_WATCHED_REPOS[${index}].agents.${pipeline} must be an object or null`,
        );
      }
      for (const field of ['workflowFile', 'label', 'replyTrigger']) {
        const fieldValue = (value as Record<string, unknown>)[field];
        if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
          throw new Error(
            `AGENT_LCARS_WATCHED_REPOS[${index}].agents.${pipeline}.${field} must be a non-empty string`,
          );
        }
      }
      const aliases = (value as Record<string, unknown>)['replyTriggerAliases'];
      if (
        aliases !== undefined &&
        (!Array.isArray(aliases) ||
          aliases.some(
            (alias) => typeof alias !== 'string' || alias.length === 0,
          ))
      ) {
        throw new Error(
          `AGENT_LCARS_WATCHED_REPOS[${index}].agents.${pipeline}.replyTriggerAliases must be an array of non-empty strings`,
        );
      }
    }
  }

  return {
    owner,
    name,
    ...(alias !== undefined && { alias: alias as string }),
    ...(agents && {
      agents: agents as Partial<Record<AgentPipeline, AgentIntegration | null>>,
    }),
  };
}

/**
 * Parses `AGENT_LCARS_WATCHED_REPOS`: a JSON array of
 * `{ "owner": string, "name": string, "alias"?: string, "agents"?: Partial<Record<AgentPipeline, AgentIntegration>> }`
 * objects, e.g.
 * `[{"owner":"supersprinklesracing","name":"sprinkles"},{"owner":"supersprinklesracing","name":"website","alias":"Website"}]`.
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
      'AGENT_LCARS_WATCHED_REPOS must be a non-empty JSON array of {owner, name, alias?, agents?} objects',
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

/** The repo global, ops-style actions (quick task, unstick-prs) target when
 * the UI doesn't offer a per-action repo picker - always the first watched
 * repo, matching today's single-repo behavior. */
export function primaryWatchedRepo(): WatchedRepo {
  return getWatchedRepos()[0];
}

export class UnwatchedRepoError extends Error {
  constructor(owner: string, name: string) {
    super(`${owner}/${name} is not a watched repo`);
    this.name = 'UnwatchedRepoError';
  }
}

/**
 * Resolves a client-supplied repo identifier against the canonical watched
 * list, rather than trusting the caller's object directly. Server Action
 * arguments are client-controlled at the HTTP boundary regardless of their
 * TS signature - without this, an authenticated client could pass an
 * arbitrary `{owner, name}` and use the console's GitHub credentials
 * against any repo they can reach, not just the configured watched set.
 * Every Server Action in app/actions.ts that accepts a client-supplied repo
 * must call this before passing it to backend-actions.ts.
 */
export function resolveWatchedRepo(candidate: {
  owner: string;
  name: string;
}): WatchedRepo {
  const match = getWatchedRepos().find(
    (repo) => repo.owner === candidate.owner && repo.name === candidate.name,
  );
  if (!match) {
    throw new UnwatchedRepoError(candidate.owner, candidate.name);
  }
  return match;
}

/**
 * Defensive parsing for the dashboard's optional `?repo=owner/name` filter
 * query param - any missing or unrecognized value falls back to "no
 * filter" (show every watched repo) rather than throwing, matching
 * parseSessionArchiveQuery's philosophy (no filter chrome beyond a simple
 * query param a maintainer edits by hand or a repo badge links to - see
 * #2694/#3019).
 */
export function parseRepoFilterParam(
  raw: string | string[] | undefined,
): WatchedRepo | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  return getWatchedRepos().find((repo) => repoKey(repo) === value);
}
