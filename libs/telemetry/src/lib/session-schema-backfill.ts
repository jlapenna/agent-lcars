import { SESSION_AGENTS, SessionAgent, SessionDoc } from './types';

export interface SessionRepository {
  owner: string;
  name: string;
}

/** The operator-supplied, evidence-backed values for one legacy document.
 * This deliberately has no defaults: a backfill is allowed to copy an
 * explicit value into a missing field, never to guess it from a provider,
 * repository, archive path, or primary-repository setting. */
export interface SessionSchemaBackfill {
  sessionId: string;
  agent: SessionAgent;
  repo: SessionRepository;
  /** Required for `source: 'issue-agent'`, where it is the capture-time
   * statement about the archived transcript's timeline capability. */
  renderable?: boolean;
}

export type SessionSchemaGap = 'agent' | 'repo' | 'renderable' | 'source';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameRepo(left: SessionRepository, right: SessionRepository): boolean {
  return left.owner === right.owner && left.name === right.name;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Lists the current-schema fields absent from an untyped stored document.
 * It is intentionally a migration-only reader. Runtime compatibility readers
 * remain in place until the phase-2 migration proof is complete. */
export function sessionSchemaGaps(document: unknown): SessionSchemaGap[] {
  if (!isRecord(document)) return ['source'];
  const gaps: SessionSchemaGap[] = [];
  const source = document['source'];
  if (source !== 'cli' && source !== 'issue-agent') gaps.push('source');
  if (!SESSION_AGENTS.includes(document['agent'] as SessionAgent)) {
    gaps.push('agent');
  }
  const repo = document['repo'];
  if (
    !isRecord(repo) ||
    !isNonEmptyString(repo['owner']) ||
    !isNonEmptyString(repo['name'])
  ) {
    gaps.push('repo');
  }
  if (source === 'issue-agent' && typeof document['renderable'] !== 'boolean') {
    gaps.push('renderable');
  }
  return gaps;
}

/**
 * Applies one explicit migration declaration to a legacy document. Existing
 * populated fields must agree with the declaration; disagreement is a hard
 * stop rather than an opportunity to overwrite possibly newer telemetry.
 */
export function backfillSessionSchema(
  document: unknown,
  backfill: SessionSchemaBackfill,
): SessionDoc {
  if (!isRecord(document)) {
    throw new Error(`Session ${backfill.sessionId} is not an object`);
  }
  if (document['sessionId'] !== backfill.sessionId) {
    throw new Error(
      `Backfill sessionId ${backfill.sessionId} does not match stored document`,
    );
  }
  const source = document['source'];
  if (source !== 'cli' && source !== 'issue-agent') {
    throw new Error(`Session ${backfill.sessionId} has no supported source`);
  }
  if (document['agent'] !== undefined && document['agent'] !== backfill.agent) {
    throw new Error(`Session ${backfill.sessionId} has a conflicting agent`);
  }
  if (document['repo'] !== undefined) {
    const repo = document['repo'];
    if (
      !isRecord(repo) ||
      typeof repo['owner'] !== 'string' ||
      typeof repo['name'] !== 'string' ||
      !sameRepo({ owner: repo['owner'], name: repo['name'] }, backfill.repo)
    ) {
      throw new Error(`Session ${backfill.sessionId} has a conflicting repo`);
    }
  }
  if (source === 'issue-agent') {
    if (backfill.renderable === undefined) {
      throw new Error(
        `Issue-agent session ${backfill.sessionId} requires explicit renderable`,
      );
    }
    if (
      document['renderable'] !== undefined &&
      document['renderable'] !== backfill.renderable
    ) {
      throw new Error(
        `Session ${backfill.sessionId} has a conflicting renderable value`,
      );
    }
    return {
      ...document,
      source,
      agent: backfill.agent,
      repo: backfill.repo,
      renderable: backfill.renderable,
    } as SessionDoc;
  }
  return {
    ...document,
    source,
    agent: backfill.agent,
    repo: backfill.repo,
  } as SessionDoc;
}

/** Returns only the fields a migration may write after validating the full
 * declaration against the stored document. Keeping this patch narrow avoids
 * rewriting counters, timestamps, or archive references during backfill. */
export interface SessionSchemaBackfillPatch {
  agent: SessionAgent;
  repo: SessionRepository;
  renderable?: boolean;
}

export function sessionSchemaBackfillPatch(
  document: unknown,
  backfill: SessionSchemaBackfill,
): SessionSchemaBackfillPatch {
  const migrated = backfillSessionSchema(document, backfill);
  return {
    agent: backfill.agent,
    repo: backfill.repo,
    ...(migrated.source === 'issue-agent' && {
      renderable: backfill.renderable,
    }),
  };
}
