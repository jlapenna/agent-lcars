import 'server-only';

import { required } from '@agent-lcars/util-server';

import { type WatchedRepo } from './watched-repo';

export const WATCHED_REPOS_ENV = 'AGENT_LCARS_WATCHED_REPOS';

function validateWatchedRepo(entry: unknown, index: number): WatchedRepo {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${WATCHED_REPOS_ENV}[${index}] must be an object`);
  }
  const record = entry as Record<string, unknown>;

  const owner = record['owner'];
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error(
      `${WATCHED_REPOS_ENV}[${index}].owner must be a non-empty string`,
    );
  }
  const name = record['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(
      `${WATCHED_REPOS_ENV}[${index}].name must be a non-empty string`,
    );
  }
  const alias = record['alias'];
  if (
    alias !== undefined &&
    (typeof alias !== 'string' || alias.length === 0)
  ) {
    throw new Error(
      `${WATCHED_REPOS_ENV}[${index}].alias must be a non-empty string when present`,
    );
  }

  const agents = record['agents'];
  if (agents !== undefined && agents !== false) {
    throw new Error(
      `${WATCHED_REPOS_ENV}[${index}].agents must be false when present`,
    );
  }

  return {
    owner,
    name,
    ...(alias !== undefined && { alias: alias as string }),
    ...(agents === false ? { agents } : {}),
  };
}

/** Parses the explicit console repository configuration. A missing value is
 * an unsafe deployment configuration, not a single-repository fallback. */
export function getWatchedRepos(): WatchedRepo[] {
  const raw = required(WATCHED_REPOS_ENV);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${WATCHED_REPOS_ENV} is not valid JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${WATCHED_REPOS_ENV} must be a non-empty JSON array of {owner, name, alias?, agents?} objects`,
    );
  }
  return parsed.map((entry, index) => validateWatchedRepo(entry, index));
}
