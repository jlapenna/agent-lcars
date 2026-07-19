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

/** Returns `undefined` for a session with no parseable `lastActivityAt`
 * (e.g. a transcript with no timestamped lines yet — `reducer.ts` falls back
 * to `''` in that case) rather than throwing on `Invalid Date`. */
function computeExpireAt(lastActivityAt: string): string | undefined {
  const lastActivityMs = new Date(lastActivityAt).getTime();
  if (Number.isNaN(lastActivityMs)) {
    return undefined;
  }
  const retentionMs = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
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
  const expireAt = computeExpireAt(summary.lastActivityAt);
  const base = {
    sessionId: summary.sessionId,
    liveness,
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
