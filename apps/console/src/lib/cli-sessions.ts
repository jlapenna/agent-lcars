import type {
  CliSessionDoc,
  SessionAgent,
  SessionLiveness,
} from '@agent-lcars/telemetry';
import { displayLiveness, sessionAgent } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocs,
} from '@agent-lcars/telemetry/server';

import {
  getGithubClient,
  primaryWatchedRepo,
  repoKey,
  type WatchedRepo,
} from './github-client';

/** Sessions with no activity in this window don't render at all - the
 * telemetry collection keeps one doc per session forever, and the dashboard
 * is a "what's happening" surface, not a session archive. */
const ACTIVE_WINDOW_HOURS = 24;

/** Hard cap on rendered sessions even within the window - a busy fleet day
 * produces 40+ session docs in 24h, and rows past this many are archive
 * material, not activity. Active (live/idle) sessions are kept first. */
const MAX_SESSIONS = 20;

export interface JoinedPr {
  number: number;
  url: string;
}

export interface CliSession {
  sessionId: string;
  liveness: SessionLiveness;
  /** Resolved via `sessionAgent()` at fetch time (never the doc's raw
   * optional `agent` field), so it's always a concrete value here -
   * defaults to `'claude-code'` for the overwhelming majority of sessions
   * that predate #3123 or simply never carried a different agent. */
  agent: SessionAgent;
  host?: string;
  branch?: string;
  worktree?: string;
  model?: string;
  turns: number;
  /** Total tokens (input + output). No dollar-cost ledger exists yet (Agent
   * Console v2 PRD #2112 defers a cost ledger to a later slice) - token
   * volume is the best available proxy today. */
  totalTokens: number;
  title?: string;
  startedAt: string;
  lastActivityAt: string;
  pr?: JoinedPr;
  /** Filenames shared under this session's share dir on `host` - only
   * meaningful together with `host` (the join key for the share URL). */
  artifacts?: string[];
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
    agent: sessionAgent(doc),
    host: doc.host,
    branch: doc.branch,
    worktree: doc.worktree,
    model: doc.model,
    turns: doc.turns,
    totalTokens: doc.tokens.inputTokens + doc.tokens.outputTokens,
    title: doc.title,
    startedAt: doc.startedAt,
    lastActivityAt: doc.lastActivityAt,
    artifacts: doc.artifacts,
  };
}

/** The session's own transcript already names the PRs it touched - use that
 * before ever asking GitHub. The newest PR number wins. Falls back to the
 * primary watched repo for docs written before Phase 0's `repo` field
 * existed. */
function prFromDeliverables(doc: CliSessionDoc): JoinedPr | undefined {
  const prNumbers = doc.deliverables?.prNumbers;
  if (!prNumbers || prNumbers.length === 0) return undefined;
  const number = prNumbers[prNumbers.length - 1];
  const repo = doc.repo ?? primaryWatchedRepo();
  return {
    number,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${number}`,
  };
}

/**
 * Joins a branch to an open PR via the same GitHub search client used for
 * runner `display_title` matching (see `agent-activity.ts`) - a live PR
 * search rather than a stored field, since a CLI session's branch can grow a
 * PR after the session doc was last written.
 */
export async function joinBranchToPr(
  repo: WatchedRepo,
  branch: string,
): Promise<JoinedPr | undefined> {
  const octokit = getGithubClient();
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${repoKey(repo)} is:pr is:open head:${branch}`,
    per_page: 1,
  });
  const pr = data.items[0];
  if (!pr) {
    return undefined;
  }
  return { number: pr.number, url: pr.html_url };
}

export interface CliSessionsResult {
  sessions: CliSession[];
  /** Human-readable notes when the store or a join degraded instead of
   * crashing (e.g. no telemetry infra reachable - PRD item 16). */
  warnings: string[];
}

/**
 * Fetches recently-active `source: 'cli'` session docs from the
 * agent-telemetry store and attaches each one's PR when it has one.
 *
 * PR attachment is deliberately cheap: the doc's own `deliverables.prNumbers`
 * costs nothing, and the live branch->PR search runs only for *active*
 * sessions still missing a PR (a branch can grow a PR after the doc was
 * written). Searching for every doc - the original behavior - fired one
 * GitHub search per session per page load, which at 200+ docs blew through
 * the search API's ~30 req/min budget and flooded the warnings banner with
 * the resulting failures.
 *
 * A recorded deliverable never overrides liveness. CLI sessions are commonly
 * long-lived or resumed for later work, so a merged PR only describes one
 * thing the session produced; it does not prove that the still-running
 * process has ended. The watcher/process signals remain authoritative.
 *
 * One malformed doc or one failed PR lookup degrades that single session
 * instead of crashing the whole list, matching the defensive pattern in
 * `agent-activity.ts` / `action-items.ts`. A store-level failure (e.g. no
 * telemetry infra reachable) degrades to an empty list rather than crashing
 * the dashboard - the existing GitHub-derived view must still work.
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

  const warnings: string[] = [];
  // Dedupe live searches by repo+branch: resumed sessions share a worktree
  // branch, and one lookup (and, on failure, one warning) answers for all
  // of them. Keyed by repo too, not branch alone - two watched repos could
  // legitimately share a branch-naming convention.
  const searchByBranch = new Map<string, Promise<JoinedPr | undefined>>();
  const searchBranch = (
    repo: WatchedRepo,
    branch: string,
  ): Promise<JoinedPr | undefined> => {
    const key = `${repoKey(repo)}#${branch}`;
    let search = searchByBranch.get(key);
    if (!search) {
      search = joinBranchToPr(repo, branch).catch((error) => {
        console.error(
          `agent-lcars: failed to join branch "${branch}" (${repoKey(repo)}) to a PR:`,
          error,
        );
        warnings.push(
          `PR lookup failed for branch "${branch}" (${repoKey(repo)}).`,
        );
        return undefined;
      });
      searchByBranch.set(key, search);
    }
    return search;
  };
  const sessions = await Promise.all(
    capped.map(async ([doc, session]) => {
      session.pr = prFromDeliverables(doc);
      if (!session.pr && doc.branch && isActive(session.liveness)) {
        session.pr = await searchBranch(
          doc.repo ?? primaryWatchedRepo(),
          doc.branch,
        );
      }
      return session;
    }),
  );

  sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { sessions, warnings };
}
