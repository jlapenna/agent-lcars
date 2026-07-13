import {
  BuildSessionDocOptions,
  SessionDoc,
  SessionLiveness,
  SessionSummary,
} from './types';

/** Horizon past `lastActivityAt` at which a session doc becomes eligible for
 * Firestore TTL deletion (see issue #2708). Slice 2's GCS transcript archive
 * may want ended-session docs retained longer as an index into the archive
 * — revisit this constant when that lands rather than deleting docs it still
 * needs. */
export const SESSION_RETENTION_DAYS = 30;

function computeExpireAt(lastActivityAt: string): string {
  const retentionMs = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return new Date(
    new Date(lastActivityAt).getTime() + retentionMs,
  ).toISOString();
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
  const base = {
    sessionId: summary.sessionId,
    liveness,
    startedAt: summary.startedAt,
    lastActivityAt: summary.lastActivityAt,
    expireAt: computeExpireAt(summary.lastActivityAt),
    turns: summary.turns,
    toolCallCounts: summary.toolCallCounts,
    tokens: summary.tokens,
    ...(summary.lastToolCall && { lastToolCall: summary.lastToolCall }),
    ...(summary.model && { model: summary.model }),
    ...(summary.permissionMode && { permissionMode: summary.permissionMode }),
    ...(summary.title && { title: summary.title }),
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
