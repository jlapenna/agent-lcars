import 'server-only';

import { optional, required } from '@agent-lcars/util-server';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';

import { createGithubClientAuthStrategy } from './github-app-tokens';
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
// with no @agent-lcars/util-server dependency) so client components can import
// them without accidentally pulling this file's server-only deps
// (firebase-admin, google-auth-library, ...) into a browser bundle.
export {
  type AgentPipeline,
  repoDisplayName,
  repoItemKey,
  repoKey,
  type WatchedRepo,
};

// The dashboard fans out ~26 GitHub calls per load across
// agent-activity.ts/action-items.ts/item-enrichment.ts (see #13, filed
// alongside the original unthrottled fan-out). A 429/secondary-rate-limit
// used to just be a rejected promise that degraded that section to a
// warning banner; retry a small bounded number of times first so a single
// rate-limited call doesn't need the whole section to fail.
const MAX_RATE_LIMIT_RETRIES = 2;

// Bounds how long a single GitHub call can hang before this client gives up
// on it, so a stalled connection can't block Next's `"use cache"` fill
// indefinitely (the cache-populating fetch has no timeout of its own).
const REQUEST_TIMEOUT_MS = 15_000;

// A rate-limit retry only gets consent when GitHub's own `retryAfter` fits
// inside REQUEST_TIMEOUT_MS. The throttling plugin blocks its shared queue
// for the full `retryAfter` before issuing the retried fetch - only then
// does timeoutFetch's AbortSignal start counting - so honoring a multi-
// minute `retryAfter` would hold every other queued request hostage far
// past the timeout this client otherwise promises. Sharing the same
// constant (rather than a second bespoke budget) keeps that relationship
// explicit.
const MAX_RATE_LIMIT_RETRY_AFTER_SECONDS = REQUEST_TIMEOUT_MS / 1000;

function timeoutFetch(
  ...[input, init]: Parameters<typeof fetch>
): ReturnType<typeof fetch> {
  return fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

const SAFE_RETRY_METHODS = new Set(['GET', 'HEAD']);

/**
 * plugin-retry's automatic retries assume idempotency: retrying a POST/PATCH
 * whose response was lost (network blip, or a retryable 5xx that actually
 * landed) can duplicate a mutation - and this same singleton is what
 * backend-actions.ts uses for `issues.createComment`, `pulls.createReview`,
 * `actions.createWorkflowDispatch`, merges, etc. Reads are safe to retry;
 * everything else gets its retry budget forced to zero, overriding the
 * `retry.retries` default set in getGithubClient below.
 *
 * Registered on the constructed client (see getGithubClient below) rather
 * than as a `.plugin()` itself, purely so this can stay typed against
 * `@octokit/rest`'s own `Octokit` (this file's only octokit type import)
 * instead of also reaching for `@octokit/core`'s narrower plugin-authoring
 * types. Hook registration only matters relative to plugin-retry's and
 * plugin-throttling's OWN hook registration, which already happened by the
 * time the constructor returns - registering this `before` hook right
 * after construction, before any request can possibly go out, still runs
 * it ahead of plugin-retry's error handler, which reads
 * `options.request.retries` fresh off this same shared `options` object on
 * every failure. No need to touch the throttling plugin: it only retries
 * requests that never reached GitHub's mutation logic in the first place
 * (rate-limited requests are rejected up front).
 */
function disableRetryForMutations(octokit: Octokit): void {
  octokit.hook.before('request', (options) => {
    if (!SAFE_RETRY_METHODS.has(options.method)) {
      options.request.retries = 0;
    }
  });
}

/**
 * Shared by `onRateLimit`/`onSecondaryRateLimit` below: consents to a retry
 * only when both the bounded attempt count AND the bounded wait budget
 * allow it - see MAX_RATE_LIMIT_RETRY_AFTER_SECONDS's own comment for why
 * the wait budget matters. Deliberately just the decision, not the
 * logging - each call site keeps its own literal, greppable log message
 * (`GitHub rate limit hit` vs. `GitHub secondary rate limit hit`) rather
 * than reconstructing one from an interpolated %s, which would only show
 * up correctly once formatted and defeat a plain-text log search.
 */
function withinRateLimitRetryBudget(
  retryAfter: number,
  retryCount: number,
): boolean {
  return (
    retryCount < MAX_RATE_LIMIT_RETRIES &&
    retryAfter <= MAX_RATE_LIMIT_RETRY_AFTER_SECONDS
  );
}

const ThrottledOctokit = Octokit.plugin(retry, throttling);

/**
 * This console's own Octokit permission surface: issues (create/update/
 * comment/label/list), pull requests (list/get/review/merge/update-branch),
 * Actions (list/cancel/dispatch workflow runs), and contents (git refs/tags
 * for the Quick Task claim protocol, `repos.get`'s metadata). Requesting a
 * permission the GitHub App itself was never granted fails EVERY mint for
 * EVERY request, not just the one call site that needed it -- so this
 * deliberately excludes `checks`/`administration`, the two gaps #1284's
 * permission audit found. Runner fleet status no longer needs
 * `administration:read`: it comes from the control plane's autoscaler
 * telemetry, rather than GitHub's repository-scoped runner endpoint. The
 * remaining `checks:read` gap is `item-enrichment.ts`'s GraphQL
 * `statusCheckRollup` field, which degrades through partial-GraphQL-error
 * handling rather than crashing -- see that file's own comments.
 */
const CONSOLE_GITHUB_CLIENT_PERMISSIONS: Record<string, string> = {
  actions: 'write',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
};

let client: Octokit | undefined;

export function getGithubClient(): Octokit {
  if (!client) {
    // `AGENT_CONSOLE_GITHUB_API_BASE_URL` is only ever set by the
    // agent-lcars e2e suite, which has no real GitHub App credentials and
    // instead points every request at its own fixture route
    // (apps/console/src/app/api/e2e/github) so PR-join assertions don't
    // depend on the real GitHub API or a real App-token mint. Never set in
    // prod (absent from apphosting.yaml). The fixture route does not
    // inspect the Authorization header's value at all, so a static
    // placeholder auth is exactly as good as a minted one here and avoids
    // e2e needing real (or even syntactically valid) App credentials.
    const e2eBaseUrl = optional('AGENT_CONSOLE_GITHUB_API_BASE_URL');
    client = new ThrottledOctokit({
      ...(e2eBaseUrl
        ? { auth: 'e2e-fixture-token', baseUrl: e2eBaseUrl }
        : {
            authStrategy: createGithubClientAuthStrategy,
            auth: {
              clientId: required('AGENT_LCARS_APP_CLIENT_ID'),
              privateKeyPem: required('AGENT_LCARS_APP_PRIVATE_KEY'),
              permissions: CONSOLE_GITHUB_CLIENT_PERMISSIONS,
            },
          }),
      request: {
        fetch: timeoutFetch,
      },
      // Layered with `throttle` below: this covers generic 5xx/network
      // retries (plugin-retry) for safe (GET/HEAD) requests only -
      // disableRetryForMutations above forces mutating requests to zero
      // retries regardless of this default - while `throttle` covers
      // 429/secondary rate-limit responses specifically
      // (plugin-throttling), bounded by both attempt count and wait
      // budget (see withinRateLimitRetryBudget above).
      retry: {
        retries: MAX_RATE_LIMIT_RETRIES,
      },
      throttle: {
        onRateLimit: (retryAfter, options, _octokit, retryCount) => {
          const shouldRetry = withinRateLimitRetryBudget(
            retryAfter,
            retryCount,
          );
          console.warn(
            'agent-lcars: GitHub rate limit hit for %s %s, retryAfter %ss (attempt %s/%s)%s',
            options.method,
            options.url,
            retryAfter,
            retryCount + 1,
            MAX_RATE_LIMIT_RETRIES,
            shouldRetry ? ', retrying' : ', giving up (retry budget exceeded)',
          );
          return shouldRetry;
        },
        onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
          const shouldRetry = withinRateLimitRetryBudget(
            retryAfter,
            retryCount,
          );
          console.warn(
            'agent-lcars: GitHub secondary rate limit hit for %s %s, retryAfter %ss (attempt %s/%s)%s',
            options.method,
            options.url,
            retryAfter,
            retryCount + 1,
            MAX_RATE_LIMIT_RETRIES,
            shouldRetry ? ', retrying' : ', giving up (retry budget exceeded)',
          );
          return shouldRetry;
        },
      },
    });
    disableRetryForMutations(client);
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

/** The repository targeted by truly global ops actions that do not have a
 * task/repository context (currently only unstick-prs). Quick Task creation
 * deliberately requires an explicit repository at every boundary. */
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
