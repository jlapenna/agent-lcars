import {
  BuildSessionDocOptions,
  SessionDoc,
  SessionLiveness,
  SessionSummary,
} from './types';

/** Horizon past `lastActivityAt` at which a `source: 'cli'` session doc
 * becomes eligible for Firestore TTL deletion (see issue #2708). CLI
 * sessions run on a developer's own machine/worktree — 30d comfortably
 * outlives the console's 24h `activeSince` read cutoff (#2694/#2701)
 * without retaining that host/cwd/branch detail indefinitely (privacy +
 * noise; see #3107 follow-up 2, which split this from
 * `ISSUE_AGENT_SESSION_RETENTION_DAYS` below). */
export const CLI_SESSION_RETENTION_DAYS = 30;

/** @deprecated Alias for {@link CLI_SESSION_RETENTION_DAYS} (same value),
 * kept only so existing importers that predate the per-source retention
 * split (#3107 follow-up 2) — e.g. agent-lcars's e2e seed fixtures, which
 * only ever build `source: 'cli'` docs — don't need to change. New code
 * should import `CLI_SESSION_RETENTION_DAYS` directly. */
export const SESSION_RETENTION_DAYS = CLI_SESSION_RETENTION_DAYS;

/** Horizon past `lastActivityAt` at which a `source: 'issue-agent'` session
 * doc becomes eligible for Firestore TTL deletion. issue-agent docs are the
 * only index into the durable GCS transcript archive (`transcriptGcsUri`,
 * Slice 2) — that archived transcript has no TTL of its own, so once the
 * Firestore doc pointing at it expires, the archive becomes unbrowsable
 * from the console. 365d keeps that index alive for a full year (#3107
 * follow-up 2), well past the 30d `cli` docs get. */
export const ISSUE_AGENT_SESSION_RETENTION_DAYS = 365;

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
  const expireAt = computeExpireAt(summary.lastActivityAt, summary.source);
  const base = {
    sessionId: summary.sessionId,
    liveness,
    ...(summary.agent && { agent: summary.agent }),
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
    ...(summary.totalCostUsd !== undefined && {
      totalCostUsd: summary.totalCostUsd,
    }),
    ...(summary.result && { result: summary.result }),
    deliverables: summary.deliverables,
  };

  if (summary.source === 'issue-agent') {
    return {
      ...base,
      source: 'issue-agent',
      ...(options.runId && { runId: options.runId }),
      ...(options.issueNumber !== undefined && {
        issueNumber: options.issueNumber,
      }),
      ...(options.transcriptGcsUri && {
        transcriptGcsUri: options.transcriptGcsUri,
      }),
    };
  }

  return {
    ...base,
    source: 'cli',
    ...(summary.host && { host: summary.host }),
    ...(summary.cwd && { cwd: summary.cwd }),
    ...(summary.worktree && { worktree: summary.worktree }),
    ...(summary.branch && { branch: summary.branch }),
    ...(summary.artifacts &&
      summary.artifacts.length > 0 && { artifacts: summary.artifacts }),
  };
}
