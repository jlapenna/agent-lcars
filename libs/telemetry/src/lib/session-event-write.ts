import { buildSessionWrite } from './session-doc';
import { livenessForSessionEvent, type SessionEventV1 } from './session-event';
import { nextTokenMinutes } from './token-minutes';
import {
  type SessionDoc,
  type SessionObserver,
  type SessionSummary,
  type SessionWrite,
} from './types';

/**
 * Turns one hook `SessionEventV1` into the same `SessionWrite` shape
 * `runner finalize` produces (docs/hooks-telemetry-design.md §4). The `lcars hook
 * flush` client applies it to Firestore as the `telemetry-writer` account,
 * inside a transaction that re-reads the stored doc first.
 */

/** The stored doc re-expressed as the summary shape `buildSessionWrite`
 *  consumes, for lifecycle-only events (an `end` after the transcript is
 *  gone) that must land on top of what is already recorded. */
export function summaryFromSessionDoc(doc: SessionDoc): SessionSummary {
  return {
    sessionId: doc.sessionId,
    source: doc.source,
    agent: doc.agent,
    startedAt: doc.startedAt,
    lastActivityAt: doc.lastActivityAt,
    turns: doc.turns,
    toolCallCounts: doc.toolCallCounts,
    tokens: doc.tokens,
    deliverables: doc.deliverables,
    ...(doc.lastToolCall && { lastToolCall: doc.lastToolCall }),
    ...(doc.model && { model: doc.model }),
    ...(doc.resolvedModel && { resolvedModel: doc.resolvedModel }),
    ...(doc.permissionMode && { permissionMode: doc.permissionMode }),
    ...(doc.title && { title: doc.title }),
    ...(doc.status &&
      doc.statusUpdatedAt && {
        status: doc.status,
        statusUpdatedAt: doc.statusUpdatedAt,
      }),
    ...(doc.totalCostUsd !== undefined && { totalCostUsd: doc.totalCostUsd }),
    ...(doc.result && { result: doc.result }),
    ...(doc.repo && { repo: doc.repo }),
    ...(doc.source === 'cli' && {
      ...(doc.host && { host: doc.host }),
      ...(doc.cwd && { cwd: doc.cwd }),
      ...(doc.worktree && { worktree: doc.worktree }),
      ...(doc.branch && { branch: doc.branch }),
      ...(doc.githubActor && { githubActor: doc.githubActor }),
      ...(doc.artifacts && { artifacts: doc.artifacts }),
    }),
  };
}

/**
 * Whether a hook-sourced write may replace what is stored: refused only
 * when the stored doc was last written by a hook on the same host at the
 * same or a later per-session `seq`. A write without hook provenance, or a
 * doc a different writer last touched, always applies.
 */
export function isNewerHookWrite(
  stored: unknown,
  observer: SessionObserver | undefined,
): boolean {
  if (!observer) return true;
  if (typeof stored !== 'object' || stored === null) return true;
  const record = stored as Record<string, unknown>;
  return !(
    record['kind'] === 'hook' &&
    record['host'] === observer.host &&
    typeof record['seq'] === 'number' &&
    record['seq'] >= observer.seq
  );
}

/** Builds the write for one event, or `undefined` when the event carries no
 *  summary and nothing is stored to apply it on top of. */
export function sessionWriteForEvent(
  event: SessionEventV1,
  existing: SessionDoc | undefined,
  now: string,
): SessionWrite | undefined {
  const summary =
    event.summary ?? (existing ? summaryFromSessionDoc(existing) : undefined);
  if (!summary) return undefined;
  const liveness = livenessForSessionEvent(event.kind);
  // The retired host daemon archived CLI transcripts and recorded the
  // pointer on the doc. A hook write must carry an existing pointer forward,
  // or buildSessionWrite would clear it.
  const archive =
    !event.runner && existing?.source === 'cli'
      ? {
          ...(existing.cliTranscriptArchive && {
            cliTranscriptArchive: existing.cliTranscriptArchive,
          }),
          ...(existing.transcriptGcsUri && {
            transcriptGcsUri: existing.transcriptGcsUri,
          }),
        }
      : {};
  const write = buildSessionWrite({ ...summary, host: event.host }, liveness, {
    observedAt: now,
    ...archive,
    // Runner context, not the summary's own `source`, decides the source.
    forceSource: event.runner ? 'issue-agent' : 'cli',
    ...(event.runner && {
      runId: event.runner.runId,
      repo: event.runner.repo,
      ...(event.runner.intentId && { intentId: event.runner.intentId }),
      ...(event.runner.issueNumber !== undefined && {
        issueNumber: event.runner.issueNumber,
      }),
    }),
  });
  const observer: SessionObserver = {
    kind: 'hook',
    runtime: event.runtime.name,
    host: event.host,
    seq: event.seq,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    ...(event.runtime.clientVersion && {
      clientVersion: event.runtime.clientVersion,
    }),
  };
  const credited = nextTokenMinutes(
    existing,
    write.doc.tokens,
    event.occurredAt,
    now,
  );
  return {
    doc: { ...write.doc, observer, ...credited },
    clearFields: write.clearFields,
  };
}
