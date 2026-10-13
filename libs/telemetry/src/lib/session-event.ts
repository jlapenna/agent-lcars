import {
  isCanonicalSessionRepository,
  isSessionAgent,
  type SessionAgent,
  type SessionDeliverables,
  type SessionLiveness,
  type SessionRepository,
  type SessionResult,
  type SessionSummary,
  type TokenUsage,
  type ToolCallDigest,
} from './types';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  isSafeIdentifier,
  truncateTitle,
} from './unknown-value';

/**
 * One hook-sourced observation of a coding-agent session, spooled by the
 * `lcars hook` client (apps/telemetry-watcher) and written by `lcars hook
 * flush` as the same `SessionDoc` shape `runner finalize` writes (see
 * `session-event-write.ts` and docs/hooks-telemetry-design.md), so nothing
 * downstream of Firestore changes.
 *
 * The contract is deliberately a whitelist: `parseSessionEventV1` copies
 * only the fields named here into fresh objects, so a corrupted spool line
 * cannot smuggle arbitrary keys into a session document.
 */
export const SESSION_EVENT_KINDS = [
  'start',
  'prompt',
  'tool',
  'stop',
  'end',
  'heartbeat',
] as const;

export type SessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

export function isSessionEventKind(value: unknown): value is SessionEventKind {
  return SESSION_EVENT_KINDS.includes(value as SessionEventKind);
}

/** Which runtime hook produced the event, for provenance on the stored doc
 * (`SessionObserver`) and for debugging a client/runtime version skew. */
export interface SessionEventRuntime {
  /** `claude-code`, `codex`, `opencode`: the agent whose hook fired. */
  name: SessionAgent;
  /** The runtime's own hook event name (`PostToolUse`, `session.idle`...). */
  hookEvent?: string;
  /** Version of the `lcars` client bundle that produced the event. */
  clientVersion?: string;
}

/** Present only for dispatched (QueueExecutor) runs; mirrors
 * `BuildSessionDocOptions`'s issue-agent fields. */
export interface SessionEventRunnerContext {
  runId: string;
  intentId?: string;
  issueNumber?: number;
  repo: SessionRepository;
}

export interface SessionEventV1 {
  version: 1;
  /** Client-generated, unique per event; the dedupe key. */
  eventId: string;
  /** Per-session monotonic counter kept in the client's state file. The
   * console drops an event whose `seq` does not exceed the stored one for
   * the same `host`, so a slow flusher can never regress a doc. */
  seq: number;
  occurredAt: string;
  host: string;
  agent: SessionAgent;
  sessionId: string;
  kind: SessionEventKind;
  runtime: SessionEventRuntime;
  /** Summary-only reducer output, exactly `SessionSummary`. Optional so a
   * lifecycle-only event (an `end` after the transcript is gone) can still
   * be applied on top of the stored doc. */
  summary?: SessionSummary;
  runner?: SessionEventRunnerContext;
}

/** Liveness the event asserts (docs/hooks-telemetry-design.md §4.3). A
 * missed `end` ages out through `displayLiveness`, so nothing here needs
 * a `stale` branch. */
export function livenessForSessionEvent(
  kind: SessionEventKind,
): SessionLiveness {
  switch (kind) {
    case 'stop':
      return 'idle';
    case 'end':
      return 'ended';
    default:
      return 'live';
  }
}

export const SESSION_EVENT_MAX_STRING = 512;
const MAX_TOOL_NAMES = 200;
const MAX_LIST = 200;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type SessionEventParseResult =
  | { readonly ok: true; readonly event: SessionEventV1 }
  | { readonly ok: false; readonly reason: string };

function isoTimestamp(value: unknown): string | undefined {
  const text = asString(value);
  if (!text || !ISO_RE.test(text) || Number.isNaN(Date.parse(text))) {
    return undefined;
  }
  return text;
}

function boundedString(value: unknown): string | undefined {
  const text = asString(value);
  if (text === undefined || text.length === 0) return undefined;
  return text.length > SESSION_EVENT_MAX_STRING
    ? text.slice(0, SESSION_EVENT_MAX_STRING)
    : text;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const n = asNumber(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function parseTokens(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const inputTokens = nonNegativeInteger(record['inputTokens']);
  const outputTokens = nonNegativeInteger(record['outputTokens']);
  const cacheCreationTokens = nonNegativeInteger(record['cacheCreationTokens']);
  const cacheReadTokens = nonNegativeInteger(record['cacheReadTokens']);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheCreationTokens === undefined ||
    cacheReadTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
}

function parseToolCallCounts(
  value: unknown,
): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  if (entries.length > MAX_TOOL_NAMES) return undefined;
  const counts: Record<string, number> = {};
  for (const [name, count] of entries) {
    const n = nonNegativeInteger(count);
    if (n === undefined || name.length === 0 || name.length > 128) {
      return undefined;
    }
    counts[name] = n;
  }
  return counts;
}

function parseDeliverables(value: unknown): SessionDeliverables | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const prNumbers = asArray(record['prNumbers']);
  const commitShas = asArray(record['commitShas']);
  if (!prNumbers || !commitShas) return undefined;
  if (prNumbers.length > MAX_LIST || commitShas.length > MAX_LIST) {
    return undefined;
  }
  const prs: number[] = [];
  for (const pr of prNumbers) {
    const n = nonNegativeInteger(pr);
    if (n === undefined || n === 0) return undefined;
    prs.push(n);
  }
  const shas: string[] = [];
  for (const sha of commitShas) {
    const text = asString(sha);
    if (!text || !/^[0-9a-f]{7,40}$/i.test(text)) return undefined;
    shas.push(text);
  }
  const branch = boundedString(record['branch']);
  return { prNumbers: prs, commitShas: shas, ...(branch && { branch }) };
}

function parseLastToolCall(value: unknown): ToolCallDigest | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = boundedString(record['name']);
  const timestamp = isoTimestamp(record['timestamp']);
  return name && timestamp ? { name, timestamp } : undefined;
}

function parseResult(value: unknown): SessionResult | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const subtype = boundedString(record['subtype']);
  const isError = asBoolean(record['isError']);
  return subtype && isError !== undefined ? { subtype, isError } : undefined;
}

function parseArtifacts(value: unknown): string[] | undefined {
  const list = asArray(value);
  if (!list || list.length > MAX_LIST) return undefined;
  const out: string[] = [];
  for (const item of list) {
    const text = boundedString(item);
    if (!text) return undefined;
    out.push(text);
  }
  return out;
}

/**
 * Validates and copies a `SessionSummary` carried inside an event. Returns
 * `undefined` when a required field is missing or malformed; optional
 * fields that fail validation are dropped rather than failing the whole
 * summary, matching the reducer's own tolerance for odd transcript lines.
 */
export function parseSessionSummaryV1(
  value: unknown,
  sessionId: string,
): SessionSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record['sessionId'] !== sessionId) return undefined;
  const source = record['source'];
  if (source !== 'cli' && source !== 'issue-agent') return undefined;
  const agent = record['agent'];
  if (!isSessionAgent(agent)) return undefined;
  const startedAt = isoTimestamp(record['startedAt']);
  const lastActivityAt = isoTimestamp(record['lastActivityAt']);
  const turns = nonNegativeInteger(record['turns']);
  const toolCallCounts = parseToolCallCounts(record['toolCallCounts']);
  const tokens = parseTokens(record['tokens']);
  const deliverables = parseDeliverables(record['deliverables']);
  if (
    !startedAt ||
    !lastActivityAt ||
    turns === undefined ||
    !toolCallCounts ||
    !tokens ||
    !deliverables
  ) {
    return undefined;
  }
  const repo = record['repo'];
  const title = asString(record['title']);
  const status = asString(record['status']);
  const statusUpdatedAt = isoTimestamp(record['statusUpdatedAt']);
  const totalCostUsd = asNumber(record['totalCostUsd']);
  const lastToolCall = parseLastToolCall(record['lastToolCall']);
  const result = parseResult(record['result']);
  const artifacts = parseArtifacts(record['artifacts']);
  const host = boundedString(record['host']);
  const cwd = boundedString(record['cwd']);
  const worktree = boundedString(record['worktree']);
  const branch = boundedString(record['branch']);
  const model = boundedString(record['model']);
  const resolvedModel = boundedString(record['resolvedModel']);
  const permissionMode = boundedString(record['permissionMode']);
  const summary: SessionSummary = {
    sessionId,
    source,
    agent,
    startedAt,
    lastActivityAt,
    turns,
    toolCallCounts,
    tokens,
    deliverables,
    ...(isCanonicalSessionRepository(repo) && {
      repo: { owner: repo.owner, name: repo.name },
    }),
    ...(host && { host }),
    ...(cwd && { cwd }),
    ...(worktree && { worktree }),
    ...(branch && { branch }),
    ...(model && { model }),
    ...(resolvedModel && { resolvedModel }),
    ...(permissionMode && { permissionMode }),
    ...(title && { title: truncateTitle(title) }),
    ...(status &&
      statusUpdatedAt && { status: truncateTitle(status), statusUpdatedAt }),
    ...(totalCostUsd !== undefined &&
      Number.isFinite(totalCostUsd) &&
      totalCostUsd >= 0 && { totalCostUsd }),
    ...(lastToolCall && { lastToolCall }),
    ...(result && { result }),
    ...(artifacts && artifacts.length > 0 && { artifacts }),
  };
  return summary;
}

function parseRuntime(value: unknown): SessionEventRuntime | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = record['name'];
  if (!isSessionAgent(name)) return undefined;
  const hookEvent = boundedString(record['hookEvent']);
  const clientVersion = boundedString(record['clientVersion']);
  return {
    name,
    ...(hookEvent && { hookEvent }),
    ...(clientVersion && { clientVersion }),
  };
}

function parseRunner(value: unknown): SessionEventRunnerContext | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const runId = asString(record['runId']);
  const repo = record['repo'];
  if (
    !runId ||
    !isSafeIdentifier(runId) ||
    !isCanonicalSessionRepository(repo)
  ) {
    return undefined;
  }
  const intentId = asString(record['intentId']);
  if (intentId !== undefined && !isSafeIdentifier(intentId)) return undefined;
  const issueNumber = nonNegativeInteger(record['issueNumber']);
  return {
    runId,
    repo: { owner: repo.owner, name: repo.name },
    ...(intentId && { intentId }),
    ...(issueNumber !== undefined && issueNumber > 0 && { issueNumber }),
  };
}

export function parseSessionEventV1(value: unknown): SessionEventParseResult {
  const record = asRecord(value);
  if (!record) return { ok: false, reason: 'event must be an object' };
  if (record['version'] !== 1) {
    return { ok: false, reason: 'unsupported event version' };
  }
  const eventId = asString(record['eventId']);
  if (!eventId || !isSafeIdentifier(eventId)) {
    return { ok: false, reason: 'eventId must be a safe identifier' };
  }
  const seq = nonNegativeInteger(record['seq']);
  if (seq === undefined || seq === 0) {
    return { ok: false, reason: 'seq must be a positive integer' };
  }
  const occurredAt = isoTimestamp(record['occurredAt']);
  if (!occurredAt) {
    return { ok: false, reason: 'occurredAt must be an ISO timestamp' };
  }
  const host = asString(record['host']);
  if (!host || !isSafeIdentifier(host)) {
    return { ok: false, reason: 'host must be a safe identifier' };
  }
  const agent = record['agent'];
  if (!isSessionAgent(agent)) {
    return { ok: false, reason: 'agent is not a known session agent' };
  }
  const sessionId = asString(record['sessionId']);
  if (!sessionId || !isSafeIdentifier(sessionId)) {
    return { ok: false, reason: 'sessionId must be a safe identifier' };
  }
  const kind = record['kind'];
  if (!isSessionEventKind(kind)) {
    return { ok: false, reason: 'kind is not a known event kind' };
  }
  const runtime = parseRuntime(record['runtime']);
  if (!runtime) return { ok: false, reason: 'runtime.name is required' };
  if (runtime.name !== agent) {
    return { ok: false, reason: 'runtime.name must match agent' };
  }
  let summary: SessionSummary | undefined;
  if (record['summary'] !== undefined) {
    summary = parseSessionSummaryV1(record['summary'], sessionId);
    if (!summary) return { ok: false, reason: 'summary is malformed' };
    if (summary.agent !== agent) {
      return { ok: false, reason: 'summary.agent must match agent' };
    }
  }
  let runner: SessionEventRunnerContext | undefined;
  if (record['runner'] !== undefined) {
    runner = parseRunner(record['runner']);
    if (!runner) return { ok: false, reason: 'runner context is malformed' };
  }
  return {
    ok: true,
    event: {
      version: 1,
      eventId,
      seq,
      occurredAt,
      host,
      agent,
      sessionId,
      kind,
      runtime,
      ...(summary && { summary }),
      ...(runner && { runner }),
    },
  };
}
