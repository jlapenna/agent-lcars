import {
  BuildSessionDocOptions,
  SessionDoc,
  SessionLiveness,
  SessionSummary,
} from './types';

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
