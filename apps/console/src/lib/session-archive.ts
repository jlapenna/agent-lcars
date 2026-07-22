import type {
  SessionAgent,
  SessionDoc,
  SessionLiveness,
  SessionSource,
} from '@agent-lcars/telemetry';
import { displayLiveness, sessionAgent } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocs,
} from '@agent-lcars/telemetry/server';

import { REPO_NAME, REPO_OWNER } from './github-client';
import { aggregateSessionLedger, type SessionLedger } from './session-ledger';

export const DEFAULT_ARCHIVE_DAYS = 14;
export const MAX_ARCHIVE_DAYS = 90;

/** Server-side page-size cap for the archive table - the store's own
 * MAX_LIST_LIMIT (200) already bounds this; passed explicitly rather than
 * relying on the store's default (100) so a wide `days` window still shows
 * everything within the store's hard ceiling. */
const ARCHIVE_LIST_LIMIT = 200;

export interface SessionArchiveQuery {
  days: number;
  source?: SessionSource;
  issueNumber?: number;
}

type RawSearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Defensive query-param parsing for the /sessions archive page: any
 * missing, malformed, or out-of-range value falls back to a safe default
 * rather than throwing - there's no form validation UI here, just query
 * params a maintainer edits by hand in the URL bar (per the "no filter
 * chrome beyond simple query params" UI philosophy - see #2694/#3019).
 */
export function parseSessionArchiveQuery(
  searchParams: RawSearchParams,
): SessionArchiveQuery {
  const daysRaw = Number(firstValue(searchParams['days']));
  const days =
    Number.isFinite(daysRaw) && daysRaw > 0
      ? Math.min(Math.round(daysRaw), MAX_ARCHIVE_DAYS)
      : DEFAULT_ARCHIVE_DAYS;

  const sourceRaw = firstValue(searchParams['source']);
  const source: SessionSource | undefined =
    sourceRaw === 'cli' || sourceRaw === 'issue-agent' ? sourceRaw : undefined;

  const issueRaw = Number(firstValue(searchParams['issue']));
  const issueNumber =
    Number.isInteger(issueRaw) && issueRaw > 0 ? issueRaw : undefined;

  return { days, source, issueNumber };
}

/** Wall-clock span of a session's own recorded activity (lastActivityAt
 * minus startedAt) - not "now minus startedAt", so a long-idle-then-resumed
 * session doesn't inflate this with dead time. Shared by the archive table
 * and the detail page header so the two never disagree on how a session's
 * duration is computed. */
export function sessionDurationSeconds(
  startedAt: string,
  lastActivityAt: string,
): number {
  const started = Date.parse(startedAt);
  const last = Date.parse(lastActivityAt);
  if (Number.isNaN(started) || Number.isNaN(last)) {
    return 0;
  }
  return Math.max(0, (last - started) / 1000);
}

export interface SessionRow {
  sessionId: string;
  source: SessionSource;
  /** Resolved via `sessionAgent()` at fetch time - see `CliSession.agent`'s
   * doc comment in cli-sessions.ts for why this is always concrete here. */
  agent: SessionAgent;
  title: string;
  issueNumber?: number;
  issueUrl?: string;
  prUrls: { number: number; url: string }[];
  /** `cli` sessions only. */
  host?: string;
  /** `issue-agent` sessions only. */
  runId?: string;
  runUrl?: string;
  model?: string;
  turns: number;
  totalTokens: number;
  totalCostUsd?: number;
  startedAt: string;
  lastActivityAt: string;
  liveness: SessionLiveness;
}

function issueUrl(issueNumber: number): string {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${issueNumber}`;
}

function prUrl(number: number): string {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${number}`;
}

function runUrl(runId: string): string {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}`;
}

/** Converts a stored doc into the archive table's row view-model. `now` is
 * injected (not read from the clock in here) so liveness recomputation
 * stays deterministic under test - see displayLiveness. */
export function toSessionRow(doc: SessionDoc, now: string): SessionRow {
  const totalTokens = doc.tokens.inputTokens + doc.tokens.outputTokens;
  const title =
    doc.title ??
    (doc.source === 'issue-agent' && doc.issueNumber !== undefined
      ? `Issue #${doc.issueNumber}`
      : doc.sessionId);

  return {
    sessionId: doc.sessionId,
    source: doc.source,
    agent: sessionAgent(doc),
    title,
    ...(doc.source === 'issue-agent' &&
      doc.issueNumber !== undefined && {
        issueNumber: doc.issueNumber,
        issueUrl: issueUrl(doc.issueNumber),
      }),
    prUrls: doc.deliverables.prNumbers.map((number) => ({
      number,
      url: prUrl(number),
    })),
    ...(doc.source === 'cli' && doc.host && { host: doc.host }),
    ...(doc.source === 'issue-agent' &&
      doc.runId && { runId: doc.runId, runUrl: runUrl(doc.runId) }),
    ...(doc.model && { model: doc.model }),
    turns: doc.turns,
    totalTokens,
    ...(doc.totalCostUsd !== undefined && { totalCostUsd: doc.totalCostUsd }),
    startedAt: doc.startedAt,
    lastActivityAt: doc.lastActivityAt,
    liveness: displayLiveness(
      doc.liveness,
      doc.lastActivityAt,
      now,
      doc.observedAt,
    ),
  };
}

export interface SessionArchiveResult {
  rows: SessionRow[];
  ledger: SessionLedger;
  /** Human-readable notes when the store degraded instead of crashing,
   * matching every other fetcher in this app (cli-sessions.ts,
   * runner-sessions.ts). */
  warnings: string[];
}

/**
 * Fetches the session docs for the archive page's window/filters, and
 * derives both the row list (newest activity first - `listSessionDocs`'s
 * own sort) and the cost/token ledger from the *same* doc set, so the two
 * views on the page are always consistent with each other.
 */
export async function getSessionArchive(
  query: SessionArchiveQuery,
): Promise<SessionArchiveResult> {
  const activeSince = new Date(
    Date.now() - query.days * 24 * 60 * 60 * 1000,
  ).toISOString();

  let docs: SessionDoc[];
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    docs = await listSessionDocs(firestore, {
      activeSince,
      ...(query.source && { source: query.source }),
      ...(query.issueNumber !== undefined && {
        issueNumber: query.issueNumber,
      }),
      limit: ARCHIVE_LIST_LIMIT,
    });
  } catch (error) {
    console.error('agent-lcars: failed to list session archive:', error);
    return {
      rows: [],
      ledger: { byIssue: [], byWeek: [] },
      warnings: ['Session archive unavailable (agent-telemetry store failed).'],
    };
  }

  const now = new Date().toISOString();
  return {
    rows: docs.map((doc) => toSessionRow(doc, now)),
    ledger: aggregateSessionLedger(docs),
    warnings: [],
  };
}
