import { isRenderableTranscriptAgent } from './transcript-timeline';
import {
  BuildSessionDocOptions,
  ClearableSessionField,
  isCanonicalSessionRepository,
  isSessionAgent,
  SessionAgent,
  SessionDoc,
  SessionLiveness,
  SessionRepository,
  SessionSummary,
  SessionWrite,
} from './types';

/** Horizon past `lastActivityAt` at which a `source: 'cli'` session doc
 * becomes eligible for Firestore TTL deletion (see issue #2708). CLI
 * sessions run on a developer's own machine/worktree — 30d comfortably
 * outlives the console's 24h `activeSince` read cutoff (#2694/#2701)
 * without retaining that host/cwd/branch detail indefinitely (privacy +
 * noise; see #3107 follow-up 2, which split this from
 * `ISSUE_AGENT_SESSION_RETENTION_DAYS` below). */
export const CLI_SESSION_RETENTION_DAYS = 30;

/** Horizon past `lastActivityAt` at which a `source: 'issue-agent'` session
 * doc becomes eligible for Firestore TTL deletion. issue-agent docs are the
 * only index into the durable GCS transcript archive (`transcriptGcsUri`,
 * Slice 2) — that archived transcript has no TTL of its own, so once the
 * Firestore doc pointing at it expires, the archive becomes unbrowsable
 * from the console. 365d keeps that index alive for a full year (#3107
 * follow-up 2), well past the 30d `cli` docs get. */
export const ISSUE_AGENT_SESSION_RETENTION_DAYS = 365;

function requiredSessionAgent(summary: SessionSummary): SessionAgent {
  if (!isSessionAgent(summary.agent)) {
    throw new Error(`Session ${summary.sessionId} requires an explicit agent`);
  }
  return summary.agent;
}

function requiredIssueAgentRepository(
  sessionId: string,
  repo: unknown,
): SessionRepository {
  if (!isCanonicalSessionRepository(repo)) {
    throw new Error(
      `Issue-agent session ${sessionId} requires a canonical GitHub repo`,
    );
  }
  return repo;
}

/** Returns `undefined` for a session with no parseable `lastActivityAt`
 * (e.g. a transcript with no timestamped lines yet — `reducer.ts` falls back
 * to `''` in that case) rather than throwing on `Invalid Date`. Retention
 * horizon is source-aware — see {@link CLI_SESSION_RETENTION_DAYS} /
 * {@link ISSUE_AGENT_SESSION_RETENTION_DAYS}. */
function computeExpireAt(
  lastActivityAt: string,
  source: SessionSummary['source'],
): string | undefined {
  const lastActivityMs = new Date(lastActivityAt).getTime();
  if (Number.isNaN(lastActivityMs)) {
    return undefined;
  }
  const retentionDays =
    source === 'issue-agent'
      ? ISSUE_AGENT_SESSION_RETENTION_DAYS
      : CLI_SESSION_RETENTION_DAYS;
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  return new Date(lastActivityMs + retentionMs).toISOString();
}

/**
 * Maps a {@link SessionSummary} (source-agnostic reducer output) into the
 * source-discriminated `SessionDoc` schema stored at `sessions/{sessionId}`.
 * Omits every optional key that has no value rather than writing
 * `undefined`/`null` placeholders (repo Firestore integrity rule).
 */
export function buildSessionDoc(
  summary: SessionSummary,
  liveness: SessionLiveness,
  options: BuildSessionDocOptions = {},
): SessionDoc {
  const source = options.forceSource ?? summary.source;
  const agent = requiredSessionAgent(summary);
  const expireAt = computeExpireAt(summary.lastActivityAt, source);
  const base = {
    sessionId: summary.sessionId,
    liveness,
    agent,
    startedAt: summary.startedAt,
    lastActivityAt: summary.lastActivityAt,
    ...(expireAt && { expireAt }),
    turns: summary.turns,
    toolCallCounts: summary.toolCallCounts,
    tokens: summary.tokens,
    ...(summary.lastToolCall && { lastToolCall: summary.lastToolCall }),
    ...(summary.model && { model: summary.model }),
    ...(summary.permissionMode && { permissionMode: summary.permissionMode }),
    ...(summary.title && { title: summary.title }),
    ...(summary.status && { status: summary.status }),
    ...(summary.statusUpdatedAt && {
      statusUpdatedAt: summary.statusUpdatedAt,
    }),
    ...(summary.totalCostUsd !== undefined && {
      totalCostUsd: summary.totalCostUsd,
    }),
    ...(summary.result && { result: summary.result }),
    deliverables: summary.deliverables,
  };

  if (source === 'issue-agent') {
    const repo = requiredIssueAgentRepository(
      summary.sessionId,
      options.repo ?? summary.repo,
    );
    const issueAgentBase = {
      ...base,
      source: 'issue-agent',
      ...(options.runId && { runId: options.runId }),
      ...(options.intentId && { intentId: options.intentId }),
      ...(options.issueNumber !== undefined && {
        issueNumber: options.issueNumber,
      }),
      repo,
    } as const;
    // renderable travels with transcriptGcsUri, never on its own — it
    // describes whether *this* archived transcript can be rendered, so it
    // has no meaning when there is nothing archived to render. Set once
    // here, from the capturing adapter's own identity (see
    // isRenderableTranscriptAgent's doc comment for why this is NOT the
    // same question as "does a TranscriptAdapter exist for this agent")
    // — this is this doc's only writer; the console reads the field rather
    // than re-deriving it.
    if (options.transcriptGcsUri) {
      return {
        ...issueAgentBase,
        transcriptGcsUri: options.transcriptGcsUri,
        renderable: isRenderableTranscriptAgent(agent),
        ...(options.resumeGcsUri && { resumeGcsUri: options.resumeGcsUri }),
      };
    }
    return issueAgentBase;
  }

  return {
    ...base,
    source: 'cli',
    ...(options.observedAt && { observedAt: options.observedAt }),
    ...(summary.host && { host: summary.host }),
    ...(summary.cwd && { cwd: summary.cwd }),
    ...(summary.worktree && { worktree: summary.worktree }),
    ...(summary.branch && { branch: summary.branch }),
    ...(summary.repo && { repo: summary.repo }),
    ...(summary.artifacts &&
      summary.artifacts.length > 0 && { artifacts: summary.artifacts }),
  };
}

type StoredDocument = Record<string, unknown>;

function isStoredDocument(value: unknown): value is StoredDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptyTranscript(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates the current persisted-session boundary. This deliberately has no
 * provider or repository fallback: phase 2 only merges after the bounded
 * backfill proves every stored document satisfies this contract.
 */
export function parseSessionDoc(value: unknown): SessionDoc {
  if (!isStoredDocument(value)) {
    throw new Error('Persisted session document must be an object');
  }
  const source = value['source'];
  if (source !== 'cli' && source !== 'issue-agent') {
    throw new Error('Persisted session document has an unsupported source');
  }
  if (!isSessionAgent(value['agent'])) {
    throw new Error('Persisted session document requires an explicit agent');
  }
  const repo = value['repo'];
  if (source === 'issue-agent' && !isCanonicalSessionRepository(repo)) {
    throw new Error(
      'Persisted issue-agent session requires a canonical GitHub repo',
    );
  }
  if (
    source === 'cli' &&
    repo !== undefined &&
    !isCanonicalSessionRepository(repo)
  ) {
    throw new Error('Persisted CLI session has a malformed GitHub repo');
  }
  if (source === 'issue-agent') {
    const transcriptGcsUri = value['transcriptGcsUri'];
    if (
      transcriptGcsUri !== undefined &&
      !hasNonEmptyTranscript(transcriptGcsUri)
    ) {
      throw new Error(
        'Persisted issue-agent session has an invalid transcript URI',
      );
    }
    if (
      transcriptGcsUri !== undefined &&
      typeof value['renderable'] !== 'boolean'
    ) {
      throw new Error(
        'Persisted archived issue-agent session requires explicit renderable',
      );
    }
    if (transcriptGcsUri === undefined && value['renderable'] !== undefined) {
      throw new Error(
        'Persisted summary-only issue-agent session cannot declare renderable',
      );
    }
  }
  return value as unknown as SessionDoc;
}

/**
 * Builds the complete description of one Firestore write (issue #1257):
 * the {@link SessionDoc} from {@link buildSessionDoc}, plus which fields (if
 * any) must be explicitly DELETED rather than merely omitted from the
 * merge. This is now the one function every `upsertSession` caller should
 * go through — see {@link SessionWrite}'s doc comment in `types.ts` for why
 * the write and the daemon's dedupe-cache key are deliberately the same
 * value.
 *
 * `clearFields` is derived PURELY from `summary.status`: no status on the
 * summary means BOTH `status` and `statusUpdatedAt` are requested for
 * deletion, unconditionally — there is no separate "should I clear" branch
 * anywhere, and no state to track. This holds even for a summary that never
 * had a status at all (every runner-mode / antigravity-mode write, and
 * every ordinary session that has never called `lcars session status`):
 * deleting an absent Firestore field is a no-op, and the write-cache means
 * it only ever goes out once per session before the identical write is
 * deduped away. Gating this on "is the status overlay even enabled" would
 * buy nothing and reintroduce exactly the kind of condition someone can
 * forget — see the corrected design in issue #1257's own discussion for the
 * fuller argument against a stateful "did a clear just happen" flag: that
 * shape makes `clearFields` an input independent of `doc`, which is exactly
 * what let a doc-only write cache silently swallow a delete in the first
 * place.
 */
export function buildSessionWrite(
  summary: SessionSummary,
  liveness: SessionLiveness,
  options: BuildSessionDocOptions = {},
): SessionWrite {
  const doc = buildSessionDoc(summary, liveness, options);
  const clearFields: ClearableSessionField[] =
    summary.status === undefined ? ['status', 'statusUpdatedAt'] : [];
  return { doc, clearFields };
}
