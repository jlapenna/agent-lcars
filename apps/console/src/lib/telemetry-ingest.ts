import 'server-only';

import {
  buildSessionWrite,
  isSafeIdentifier,
  livenessForSessionEvent,
  parseSessionEventV1,
  type SessionDoc,
  type SessionEventV1,
  type SessionObserver,
  type SessionSummary,
  type SessionWrite,
} from '@agent-lcars/telemetry';
import { NextResponse } from 'next/server';

/** Who may post events, resolved by the route from either a host token or
 *  a Work-grant principal carrying `telemetry.writer`. */
export interface TelemetryWriterPrincipal {
  readonly principal: string;
  /** Host-token callers may only report their own host. */
  readonly boundHost?: string;
  /** Only a service-account identity (the runner's telemetry-writer SA)
   *  may tag events with QueueExecutor runner context. */
  readonly allowRunner: boolean;
}

export interface TelemetryIngestDependencies {
  /** `AGENT_LCARS_TELEMETRY_INGEST=1`; the route is a 404 until phase 0
   *  turns it on (docs/hooks-telemetry-design.md §6). */
  enabled: () => boolean;
  authenticate: (
    request: Request,
    bearer: string,
  ) => Promise<TelemetryWriterPrincipal | undefined>;
  readSessionDoc: (sessionId: string) => Promise<SessionDoc | undefined>;
  writeSession: (write: SessionWrite) => Promise<void>;
  now: () => string;
}

/** Generous for a summary; a transcript body would be megabytes. */
export const SESSION_EVENT_MAX_BODY_BYTES = 256 * 1024;

type IngestOutcome =
  | { readonly accepted: true; readonly liveness: string; readonly seq: number }
  | { readonly accepted: false; readonly reason: 'stale' };

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

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
      ...(doc.artifacts && { artifacts: doc.artifacts }),
    }),
  };
}

/** A host-bound token may only touch CLI sessions that the same host
 *  recorded (by `host`, or by hook provenance). Anything else, including a
 *  runner's issue-agent session whose id a workstation learned, is not
 *  its to overwrite. */
function ownedByHost(existing: SessionDoc, boundHost: string): boolean {
  if (existing.source !== 'cli') return false;
  // Fail closed: a doc that never recorded its host (the watcher daemon
  // always does) is nobody's to take over with a host-bound token.
  if (existing.host !== boundHost) return false;
  const observer = existing.observer;
  return observer === undefined || observer.host === boundHost;
}

/** A runner event may only touch a doc that is (or will be) that run's
 *  issue-agent session, never a workstation's CLI doc or another run's. */
function ownedByRun(existing: SessionDoc, event: SessionEventV1): boolean {
  if (existing.source !== 'issue-agent') return false;
  return existing.runId === undefined || existing.runId === event.runner?.runId;
}

function isStale(
  existing: SessionDoc | undefined,
  event: SessionEventV1,
): boolean {
  const observer = existing?.observer;
  return (
    observer !== undefined &&
    observer.kind === 'hook' &&
    observer.host === event.host &&
    observer.seq >= event.seq
  );
}

/** Builds the Firestore write for one accepted event. Exported for tests
 *  and for a future bulk/replay path; the route uses `handleSessionEventRequest`. */
export function sessionWriteForEvent(
  event: SessionEventV1,
  existing: SessionDoc | undefined,
  now: string,
): SessionWrite | undefined {
  const summary =
    event.summary ?? (existing ? summaryFromSessionDoc(existing) : undefined);
  if (!summary) return undefined;
  const liveness = livenessForSessionEvent(event.kind);
  const write = buildSessionWrite({ ...summary, host: event.host }, liveness, {
    observedAt: now,
    // The caller's verified identity decides the source, never the
    // summary's own `source` field: a host token can only ever produce a
    // `cli` doc, and only runner context (service identities) an
    // `issue-agent` one.
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
  return { doc: { ...write.doc, observer }, clearFields: write.clearFields };
}

export async function handleSessionEventRequest(
  request: Request,
  sessionId: string,
  deps: TelemetryIngestDependencies,
): Promise<NextResponse> {
  if (!deps.enabled()) return json({ error: 'Not Found' }, 404);
  if (!isSafeIdentifier(sessionId)) {
    return json({ error: 'invalid session id' }, 400);
  }
  const header = request.headers.get('authorization');
  const match = header === null ? null : /^Bearer\s+(\S+)$/iu.exec(header);
  if (match === null) return json({ error: 'Unauthorized' }, 401);
  const principal = await deps.authenticate(request, match[1] ?? '');
  if (!principal) return json({ error: 'Unauthorized' }, 401);

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > SESSION_EVENT_MAX_BODY_BYTES) {
    return json({ error: 'event too large' }, 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > SESSION_EVENT_MAX_BODY_BYTES) {
    return json({ error: 'event too large' }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
  const parsed = parseSessionEventV1(body);
  if (!parsed.ok) return json({ error: parsed.reason }, 400);
  const event = parsed.event;
  if (event.sessionId !== sessionId) {
    return json({ error: 'event sessionId must match the path' }, 400);
  }
  if (principal.boundHost !== undefined && event.host !== principal.boundHost) {
    return json({ error: 'host not permitted for this token' }, 403);
  }
  if (event.runner && !principal.allowRunner) {
    return json({ error: 'runner context not permitted for this token' }, 403);
  }
  if (principal.boundHost === undefined && !event.runner) {
    // A service identity reports dispatched runs only; workstation sessions
    // always arrive through a host-bound token.
    return json({ error: 'runner context required for this identity' }, 403);
  }

  const existing = await deps.readSessionDoc(sessionId);
  if (
    principal.boundHost !== undefined &&
    existing !== undefined &&
    !ownedByHost(existing, principal.boundHost)
  ) {
    return json({ error: 'session not owned by this host' }, 403);
  }
  if (event.runner && existing !== undefined && !ownedByRun(existing, event)) {
    return json({ error: 'session not owned by this run' }, 403);
  }
  if (isStale(existing, event)) {
    const outcome: IngestOutcome = { accepted: false, reason: 'stale' };
    return json(outcome, 200);
  }
  const now = deps.now();
  const write = sessionWriteForEvent(event, existing, now);
  if (!write) {
    return json(
      { error: 'a first event for a session must carry a summary' },
      422,
    );
  }
  await deps.writeSession(write);
  const outcome: IngestOutcome = {
    accepted: true,
    liveness: write.doc.liveness,
    seq: event.seq,
  };
  return json(outcome, 202);
}
