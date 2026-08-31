import 'server-only';

import type {
  CliSessionDoc,
  SessionAgent,
  SessionLiveness,
} from '@agent-lcars/telemetry';
import { displayLiveness, totalTokens } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocs,
} from '@agent-lcars/telemetry/server';

import type { WatchedRepo } from './watched-repo';

/** Sessions with no activity in this window don't render at all - the
 * telemetry collection keeps one doc per session forever, and the dashboard
 * is a "what's happening" surface, not a session archive. */
const ACTIVE_WINDOW_HOURS = 24;

/** Hard cap on rendered sessions even within the window - a busy fleet day
 * produces 40+ session docs in 24h, and rows past this many are archive
 * material, not activity. Active (live/idle) sessions are kept first.
 * Exported so the panel can say the list is capped when it fills. */
export const MAX_SESSIONS = 20;

export interface JoinedPr {
  number: number;
  url: string;
}

export interface CliSession {
  sessionId: string;
  liveness: SessionLiveness;
  /** Explicit adapter identity from the persisted session contract. */
  agent: SessionAgent;
  host?: string;
  branch?: string;
  worktree?: string;
  model?: string;
  turns: number;
  /** Cost-weighted token equivalent; see {@link totalTokens}. */
  totalTokens: number;
  title?: string;
  /** Agent-declared "what it's doing right now" (#1257) - see `SessionRow`
   * (session-archive.ts) for the same fields on the archive's view-model;
   * `statusUpdatedAt` is the declaring envelope's own `updatedAt`, not
   * `lastActivityAt`. */
  status?: string;
  statusUpdatedAt?: string;
  startedAt: string;
  lastActivityAt: string;
  pr?: JoinedPr;
  /** Filenames shared under this session's share dir on `host` - only
   * meaningful together with `host` (the join key for the share URL). */
  artifacts?: string[];
  /** Undefined for docs written before Phase 0's `repo` field existed. */
  repo?: WatchedRepo;
}

function isActive(liveness: SessionLiveness): boolean {
  return liveness === 'live' || liveness === 'idle';
}

function toCliSession(doc: CliSessionDoc, now: string): CliSession {
  return {
    sessionId: doc.sessionId,
    // Recomputed at read time: the stored value is only as fresh as the
    // watcher's last write (see displayLiveness).
    liveness: displayLiveness(
      doc.liveness,
      doc.lastActivityAt,
      now,
      doc.observedAt,
    ),
    agent: doc.agent,
    host: doc.host,
    branch: doc.branch,
    worktree: doc.worktree,
    model: doc.model,
    turns: doc.turns,
    totalTokens: totalTokens(doc.tokens),
    title: doc.title,
    status: doc.status,
    statusUpdatedAt: doc.statusUpdatedAt,
    startedAt: doc.startedAt,
    lastActivityAt: doc.lastActivityAt,
    artifacts: doc.artifacts,
    repo: doc.repo,
  };
}

/** The session's own transcript already names the PRs it touched - use that
 * before ever asking GitHub. The newest PR number wins. A PR number is only
 * unique inside a repository, so legacy docs without `repo` must not turn it
 * into a guessed URL. */
function prFromDeliverables(doc: CliSessionDoc): JoinedPr | undefined {
  const prNumbers = doc.deliverables?.prNumbers;
  if (!doc.repo || !prNumbers || prNumbers.length === 0) return undefined;
  const number = prNumbers[prNumbers.length - 1];
  return {
    number,
    url: `https://github.com/${doc.repo.owner}/${doc.repo.name}/pull/${number}`,
  };
}

export interface CliSessionsResult {
  sessions: CliSession[];
  /** Human-readable notes when the store or a join degraded instead of
   * crashing (e.g. no telemetry infra reachable - PRD item 16). */
  warnings: string[];
}

/**
 * Fetches recently-active `source: 'cli'` session docs from the
 * agent-telemetry store. A PR link comes only from the session's recorded
 * deliverable; Bridge and Agents never enumerate GitHub to infer one.
 *
 * A recorded deliverable never overrides liveness. CLI sessions are commonly
 * long-lived or resumed for later work, so a merged PR only describes one
 * thing the session produced; it does not prove that the still-running
 * process has ended. The watcher/process signals remain authoritative.
 *
 * A store-level failure (e.g. no telemetry infra reachable) degrades to an
 * empty list rather than crashing the dashboard.
 */
export async function getCliSessions(): Promise<CliSessionsResult> {
  const now = new Date();
  const activeSince = new Date(
    now.getTime() - ACTIVE_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  let docs: CliSessionDoc[];
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    const recentDocs = await listSessionDocs(firestore, { activeSince });
    docs = recentDocs.filter(
      (doc): doc is CliSessionDoc => doc.source === 'cli',
    );
  } catch (error) {
    console.error('agent-lcars: failed to list CLI sessions:', error);
    return {
      sessions: [],
      warnings: ['CLI sessions unavailable (agent-telemetry store failed).'],
    };
  }

  const nowIso = now.toISOString();
  const sessionsByDoc = docs.map(
    (doc) => [doc, toCliSession(doc, nowIso)] as const,
  );
  // Keep active sessions ahead of the cap; listSessionDocs already returns
  // newest-activity first within each group.
  const capped = [
    ...sessionsByDoc.filter(([, session]) => isActive(session.liveness)),
    ...sessionsByDoc.filter(([, session]) => !isActive(session.liveness)),
  ].slice(0, MAX_SESSIONS);

  const sessions = capped.map(([doc, session]) => {
    const pr = prFromDeliverables(doc);
    return { ...session, ...(pr === undefined ? {} : { pr }) };
  });

  sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { sessions, warnings: [] };
}
