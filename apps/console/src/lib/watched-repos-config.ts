import 'server-only';

import { required } from '@agent-lcars/util-server';

import {
  type AgentIntegration,
  type AgentPipeline,
  type WatchedRepo,
} from './watched-repo';

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
  if (agents !== undefined) {
    if (
      typeof agents !== 'object' ||
      agents === null ||
      Array.isArray(agents)
    ) {
      throw new Error(
        `${WATCHED_REPOS_ENV}[${index}].agents must be an object when present`,
      );
    }
    const supportedPipelines: AgentPipeline[] = ['claude', 'codex', 'opencode'];
    for (const [pipeline, value] of Object.entries(agents)) {
      if (!supportedPipelines.includes(pipeline as AgentPipeline)) {
        throw new Error(
          `${WATCHED_REPOS_ENV}[${index}].agents.${pipeline} is not a supported agent pipeline`,
        );
      }
      if (value === null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(
          `${WATCHED_REPOS_ENV}[${index}].agents.${pipeline} must be an object or null`,
        );
      }
      for (const field of ['label', 'replyTrigger']) {
        const fieldValue = (value as Record<string, unknown>)[field];
        if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
          throw new Error(
            `${WATCHED_REPOS_ENV}[${index}].agents.${pipeline}.${field} must be a non-empty string`,
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
          `${WATCHED_REPOS_ENV}[${index}].agents.${pipeline}.replyTriggerAliases must be an array of non-empty strings`,
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
