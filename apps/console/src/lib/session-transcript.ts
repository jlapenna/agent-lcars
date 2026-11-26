import 'server-only';

import { createHash } from 'node:crypto';

import { logger } from '@agent-lcars/logging';
import type {
  SessionAgent,
  SessionDoc,
  TranscriptElisionDivider,
  TranscriptPageParseState,
  TranscriptTextEvent,
  TranscriptTimelineEvent,
} from '@agent-lcars/telemetry';
import {
  elideTranscriptTimeline,
  parseTranscriptTimeline,
  parseTranscriptTimelineChunk,
} from '@agent-lcars/telemetry';
import {
  DEFAULT_TRANSCRIPT_PAGE_BYTES,
  fetchSessionTranscript,
  fetchSessionTranscriptByteRange,
  fetchSessionTranscriptTail,
  MAX_RUNNER_TRANSCRIPT_LINE_BYTES,
  MAX_TRANSCRIPT_SINGLE_LINE_BYTES,
  OPENCODE_EXPORT_MAX_BYTES,
  sliceTranscriptByteRangeFromBuffer,
} from '@agent-lcars/telemetry/server';
import { isE2eTesting } from '@agent-lcars/util-server';

import { getE2eTranscript } from './e2e-transcript-fixtures';

/** Events returned per page when paginating a single-envelope OpenCode export. */
export const DEFAULT_OPENCODE_PAGE_EVENTS = 500;

/** Upper bound on encoded pagination cursor length accepted from query strings. */
export const MAX_TRANSCRIPT_CURSOR_CHARS = 512;

/** Maximum consecutive metadata-only chunks skipped per paginated request. */
const MAX_EMPTY_CHUNKS_PER_PAGE = 8;

export interface TranscriptPageCursor {
  v: 1;
  agent: SessionAgent;
  mode: 'bytes' | 'events';
  offset: number;
  /** Compact SHA-256 fingerprint of `(transcriptGcsUri, captureId)` binding the
   * cursor to the exact archived snapshot rendered on page 1. */
  snapshot?: string;
  state?: TranscriptPageParseState;
}

export interface SessionTranscriptResult {
  events: (TranscriptTimelineEvent | TranscriptElisionDivider)[];
  /** Opaque fingerprint of the archived snapshot rendered by this result, used
   * to remount client pagination state when Console Refresh loads a new capture. */
  snapshotId?: string;
  nextCursor?: string;
  hasMore?: boolean;
  /** True when the underlying storage read failed (as opposed to malformed
   * transcript content), allowing paginated API routes to return HTTP 503 while
   * SSR page 1 still degrades gracefully with `warning`. */
  storageError?: boolean;
  /** Set when the fetch/parse degraded rather than crashed - GCS errors
   * (missing object, network/auth failure) and partially-unparseable
   * transcripts both surface here rather than as a thrown error, so the
   * session detail page can always render its header even when the
   * transcript can't be shown (never a 500 - see the detail page's own
   * try/catch-free design, since this function absorbs the failure). */
  warning?: string;
}

export interface TranscriptPageApiResponse {
  events: (TranscriptTimelineEvent | TranscriptElisionDivider)[];
  hasMore: boolean;
  nextCursor?: string;
  warning?: string;
  code?: 'snapshot-changed';
}

export type ResolvedSessionTranscriptTarget =
  | {
      status: 'eligible';
      transcriptGcsUri: string;
      agent: SessionAgent;
      snapshotId: string;
      maxSingleLineBytes: number;
    }
  | { status: 'expired'; warning: string }
  | { status: 'revoked'; warning: string }
  | { status: 'ineligible' };

/**
 * Computes an opaque 132-bit SHA-256 base64url digest identifying a specific
 * archived transcript object and CLI capture token without exposing raw GCS
 * bucket/object paths in client cursors.
 */
export function computeTranscriptSnapshotId(
  transcriptGcsUri: string,
  captureId?: string,
): string {
  return createHash('sha256')
    .update(transcriptGcsUri)
    .update('\0')
    .update(captureId ?? '')
    .digest('base64url')
    .slice(0, 22);
}

/**
 * Shared eligibility and consent gate enforced identically by SSR page 1
 * (`getSessionDetail`) and every paginated `/api/sessions/[id]/transcript` read.
 */
export function resolveSessionTranscriptTarget(
  doc: SessionDoc,
  nowMs: number = Date.now(),
): ResolvedSessionTranscriptTarget {
  if (doc.source === 'cli') {
    const cliArchive = doc.cliTranscriptArchive;
    if (cliArchive?.status === 'available') {
      const unexpired = Boolean(
        cliArchive.expiresAt && Date.parse(cliArchive.expiresAt) > nowMs,
      );
      if (!unexpired) {
        return {
          status: 'expired',
          warning: 'Transcript unavailable (archive retention expired).',
        };
      }
      if (doc.transcriptGcsUri && doc.renderable) {
        return {
          status: 'eligible',
          transcriptGcsUri: doc.transcriptGcsUri,
          agent: doc.agent,
          snapshotId: computeTranscriptSnapshotId(
            doc.transcriptGcsUri,
            cliArchive.captureId,
          ),
          maxSingleLineBytes: MAX_TRANSCRIPT_SINGLE_LINE_BYTES,
        };
      }
      return { status: 'ineligible' };
    }
    if (cliArchive?.status === 'expired') {
      return {
        status: 'revoked',
        warning: 'Transcript unavailable (archive retention expired).',
      };
    }
    return { status: 'ineligible' };
  }

  const openCodeExport =
    doc.transcriptGcsUri && doc.agent === 'opencode'
      ? doc.resumeGcsUri
      : undefined;
  if (doc.transcriptGcsUri && (doc.renderable || openCodeExport)) {
    const resolvedUri = openCodeExport ?? doc.transcriptGcsUri;
    return {
      status: 'eligible',
      transcriptGcsUri: resolvedUri,
      agent: doc.agent,
      snapshotId: computeTranscriptSnapshotId(resolvedUri),
      maxSingleLineBytes: MAX_RUNNER_TRANSCRIPT_LINE_BYTES,
    };
  }
  return { status: 'ineligible' };
}

const TRAJECTORY_TAIL_BYTES = 1024 * 1024;
const TRAJECTORY_MESSAGE_LIMIT = 5;
const TRAJECTORY_MESSAGE_CHARS = 1200;

export interface SessionTrajectoryPreview {
  messages: Pick<TranscriptTextEvent, 'role' | 'text'>[];
}

export async function getSessionTrajectoryPreview(
  target: Extract<ResolvedSessionTranscriptTarget, { status: 'eligible' }>,
): Promise<SessionTrajectoryPreview> {
  const { agent, transcriptGcsUri } = target;
  const fixture = isE2eTesting()
    ? getE2eTranscript(transcriptGcsUri)
    : undefined;
  let raw: string;
  if (agent === 'opencode') {
    raw =
      fixture ??
      (await fetchSessionTranscript(
        transcriptGcsUri,
        OPENCODE_EXPORT_MAX_BYTES,
      ));
  } else {
    // The extra byte distinguishes a truncated window from an exact fit.
    const readBytes = TRAJECTORY_TAIL_BYTES + 1;
    const tail =
      fixture === undefined
        ? await fetchSessionTranscriptTail(transcriptGcsUri, readBytes)
        : Buffer.from(fixture).subarray(-readBytes);
    if (tail.length > TRAJECTORY_TAIL_BYTES) {
      const firstNewline = tail.indexOf(10);
      raw = firstNewline === -1 ? '' : tail.toString('utf8', firstNewline + 1);
    } else {
      raw = tail.toString('utf8');
    }
  }
  const { events } = parseTranscriptTimeline(raw, agent);
  const messages = events
    .filter(
      (event): event is TranscriptTextEvent =>
        event.kind === 'text' && event.text.trim().length > 0,
    )
    .slice(-TRAJECTORY_MESSAGE_LIMIT)
    .map(({ role, text }) => ({
      role,
      text:
        text.length > TRAJECTORY_MESSAGE_CHARS
          ? text.slice(0, TRAJECTORY_MESSAGE_CHARS).trimEnd() + '…'
          : text,
    }));
  return { messages };
}

export function encodeTranscriptCursor(cursor: TranscriptPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function isValidParseState(value: unknown): value is TranscriptPageParseState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      key !== 'inSidechain' &&
      key !== 'sidechainContributedEvents' &&
      key !== 'pendingCodexTurnHash'
    ) {
      return false;
    }
  }
  if (
    record['inSidechain'] !== undefined &&
    typeof record['inSidechain'] !== 'boolean'
  ) {
    return false;
  }
  if (
    record['sidechainContributedEvents'] !== undefined &&
    typeof record['sidechainContributedEvents'] !== 'boolean'
  ) {
    return false;
  }
  if (
    record['pendingCodexTurnHash'] !== undefined &&
    (typeof record['pendingCodexTurnHash'] !== 'string' ||
      record['pendingCodexTurnHash'].length === 0 ||
      record['pendingCodexTurnHash'].length > 128)
  ) {
    return false;
  }
  return true;
}

export function parseTranscriptCursor(
  raw: string,
  expectedAgent: SessionAgent,
): TranscriptPageCursor | undefined {
  if (
    !raw ||
    raw.length > MAX_TRANSCRIPT_CURSOR_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(raw)
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const expectedMode = expectedAgent === 'opencode' ? 'events' : 'bytes';
  if (
    record['v'] !== 1 ||
    record['agent'] !== expectedAgent ||
    record['mode'] !== expectedMode ||
    typeof record['offset'] !== 'number' ||
    !Number.isSafeInteger(record['offset']) ||
    record['offset'] <= 0
  ) {
    return undefined;
  }
  if (
    record['snapshot'] !== undefined &&
    (typeof record['snapshot'] !== 'string' ||
      record['snapshot'].length === 0 ||
      record['snapshot'].length > 64)
  ) {
    return undefined;
  }
  if (record['state'] !== undefined && !isValidParseState(record['state'])) {
    return undefined;
  }
  return {
    v: 1,
    agent: expectedAgent,
    mode: expectedMode,
    offset: record['offset'],
    ...(record['snapshot'] !== undefined && {
      snapshot: record['snapshot'],
    }),
    ...(record['state'] !== undefined && {
      state: record['state'] as TranscriptPageParseState,
    }),
  };
}

export interface GetSessionTranscriptOptions {
  cursor?: TranscriptPageCursor;
  snapshotId?: string;
  pageBytes?: number;
  pageEvents?: number;
  maxSingleLineBytes?: number;
}

async function getOpenCodeTranscriptPage(
  transcriptGcsUri: string,
  options?: GetSessionTranscriptOptions,
): Promise<SessionTranscriptResult> {
  let raw: string;
  try {
    raw =
      (isE2eTesting() ? getE2eTranscript(transcriptGcsUri) : undefined) ??
      (await fetchSessionTranscript(
        transcriptGcsUri,
        OPENCODE_EXPORT_MAX_BYTES,
      ));
  } catch (error) {
    logger.error(
      'agent-lcars: failed to fetch session transcript from storage:',
      error,
    );
    return {
      events: [],
      ...(options?.snapshotId && { snapshotId: options.snapshotId }),
      storageError: true,
      warning:
        'Transcript unavailable or expired (failed to fetch from storage).',
    };
  }

  const { events, hadUnparseableLines } = parseTranscriptTimeline(
    raw,
    'opencode',
  );
  const pageEvents = options?.pageEvents ?? DEFAULT_OPENCODE_PAGE_EVENTS;
  const offset = options?.cursor?.mode === 'events' ? options.cursor.offset : 0;
  const snapshotId =
    options?.snapshotId ??
    options?.cursor?.snapshot ??
    computeTranscriptSnapshotId(transcriptGcsUri);
  const slice = events.slice(offset, offset + pageEvents);
  const hasMore = offset + slice.length < events.length;
  const nextCursor = hasMore
    ? encodeTranscriptCursor({
        v: 1,
        agent: 'opencode',
        mode: 'events',
        offset: offset + slice.length,
        snapshot: snapshotId,
      })
    : undefined;

  const renderedEvents =
    offset === 0 && !hasMore ? elideTranscriptTimeline(slice) : slice;

  return {
    events: renderedEvents,
    ...(options?.snapshotId && { snapshotId: options.snapshotId }),
    ...(nextCursor && { nextCursor, hasMore: true }),
    ...(hadUnparseableLines &&
      (offset === 0 || events.length === 0) && {
        warning:
          events.length === 0
            ? 'Transcript archive is malformed and could not be parsed.'
            : 'Some transcript lines could not be parsed and were skipped.',
      }),
  };
}

/**
 * Fetches and parses a page of a session's archived transcript for the
 * detail page's timeline section or `/api/sessions/[id]/transcript`. Every
 * failure mode - a malformed/expired `gs://` URI, the object missing from the
 * bucket, a network/auth error, or a transcript with some unparseable lines -
 * degrades to a warning rather than throwing, matching every other read path
 * in this app (cli-sessions.ts/runner-sessions.ts/session-archive.ts).
 */
export async function getSessionTranscript(
  transcriptGcsUri: string,
  agent: SessionAgent = 'claude-code',
  options?: GetSessionTranscriptOptions,
): Promise<SessionTranscriptResult> {
  if (agent === 'opencode') {
    return getOpenCodeTranscriptPage(transcriptGcsUri, options);
  }

  const pageBytes = options?.pageBytes ?? DEFAULT_TRANSCRIPT_PAGE_BYTES;
  const maxSingleLineBytes =
    options?.maxSingleLineBytes ?? MAX_RUNNER_TRANSCRIPT_LINE_BYTES;
  const snapshotId =
    options?.snapshotId ??
    options?.cursor?.snapshot ??
    computeTranscriptSnapshotId(transcriptGcsUri);
  let currentOffset =
    options?.cursor?.mode === 'bytes' ? options.cursor.offset : 0;
  let currentState =
    options?.cursor?.mode === 'bytes' ? options.cursor.state : undefined;

  const accumulatedEvents: TranscriptTimelineEvent[] = [];
  let hadUnparseableLines = false;
  let reachedEof = false;

  let e2eBuffer: Buffer | undefined;
  try {
    const e2eFixture = isE2eTesting()
      ? getE2eTranscript(transcriptGcsUri)
      : undefined;
    e2eBuffer =
      e2eFixture !== undefined ? Buffer.from(e2eFixture, 'utf8') : undefined;
  } catch (error) {
    logger.error(
      'agent-lcars: failed to fetch session transcript from storage:',
      error,
    );
    return {
      events: [],
      ...(options?.snapshotId && { snapshotId: options.snapshotId }),
      storageError: true,
      warning:
        'Transcript unavailable or expired (failed to fetch from storage).',
    };
  }

  for (let step = 0; step < MAX_EMPTY_CHUNKS_PER_PAGE; step += 1) {
    let range: Awaited<ReturnType<typeof fetchSessionTranscriptByteRange>>;
    try {
      range =
        e2eBuffer !== undefined
          ? await sliceTranscriptByteRangeFromBuffer(e2eBuffer, {
              startOffset: currentOffset,
              maxBytes: pageBytes,
              maxSingleLineBytes,
            })
          : await fetchSessionTranscriptByteRange(transcriptGcsUri, {
              startOffset: currentOffset,
              maxBytes: pageBytes,
              maxSingleLineBytes,
            });
    } catch (error) {
      logger.error(
        'agent-lcars: failed to fetch session transcript from storage:',
        error,
      );
      return {
        events: [],
        ...(options?.snapshotId && { snapshotId: options.snapshotId }),
        storageError: true,
        warning:
          'Transcript unavailable or expired (failed to fetch from storage).',
      };
    }

    if (range.skippedOversizedLine) {
      hadUnparseableLines = true;
      currentOffset = range.skippedOversizedLine.nextOffset;
      if (range.eof) {
        reachedEof = true;
        break;
      }
      continue;
    }

    const parsed = parseTranscriptTimelineChunk(range.chunk, {
      startOffset: currentOffset,
      eof: range.eof,
      agent,
      initialState: currentState,
    });

    if (parsed.hadUnparseableLines) {
      hadUnparseableLines = true;
    }

    const stalled = !range.eof && parsed.nextOffset <= currentOffset;
    currentOffset = parsed.nextOffset;
    currentState = parsed.nextState;
    // Loop rather than `push(...parsed.events)` so a single record emitting
    // >100k events cannot overflow V8's function-argument stack limit.
    for (let i = 0; i < parsed.events.length; i += 1) {
      accumulatedEvents.push(parsed.events[i]);
    }

    if (range.eof) {
      reachedEof = true;
      break;
    }
    if (accumulatedEvents.length > 0 || stalled) {
      if (stalled) {
        reachedEof = true;
        hadUnparseableLines = true;
      }
      break;
    }
  }

  const isFirstPage = !options?.cursor;
  const hasMore = !reachedEof;
  const hasCarryState = Boolean(
    currentState &&
    (currentState.inSidechain ||
      currentState.sidechainContributedEvents ||
      currentState.pendingCodexTurnHash),
  );
  const nextCursor = hasMore
    ? encodeTranscriptCursor({
        v: 1,
        agent,
        mode: 'bytes',
        offset: currentOffset,
        snapshot: snapshotId,
        ...(hasCarryState && { state: currentState }),
      })
    : undefined;

  const renderedEvents =
    isFirstPage && !hasMore
      ? elideTranscriptTimeline(accumulatedEvents)
      : accumulatedEvents;

  return {
    events: renderedEvents,
    ...(options?.snapshotId && { snapshotId: options.snapshotId }),
    ...(nextCursor && { nextCursor, hasMore: true }),
    ...(hadUnparseableLines && {
      warning: 'Some transcript lines could not be parsed and were skipped.',
    }),
  };
}
