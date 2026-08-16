import 'server-only';

import type {
  CliSessionDoc,
  SessionAgent,
  SessionLiveness,
} from '@agent-lcars/telemetry';
import {
  displayLiveness,
  sessionAgent,
  totalTokens,
} from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocs,
} from '@agent-lcars/telemetry/server';

import {
  getGithubClient,
  getWatchedRepos,
  repoKey,
  type WatchedRepo,
} from './github-client';

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
    agent: sessionAgent(doc),
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

// GitHub caps a page at 100. The watched repos carry single-digit open PRs,
// so this bounds the loop rather than expecting to reach it.
const PULLS_PER_PAGE = 100;
const PULLS_MAX_PAGES = 5;

/**
 * Every open PR in the repo, keyed by its head branch - a live lookup rather
 * than a stored field, since a CLI session's branch can grow a PR after the
 * session doc was last written.
 *
 * This used to be one `search.issuesAndPullRequests` call per branch
 * (`is:pr is:open head:<branch>`). #147 took the action-item board off the
 * search API's 30-req/min budget and left this as the console's only
 * remaining search call; listing open PRs once and joining in memory removes
 * it too, and turns N branch lookups into one request per repo.
 *
 * `pulls.list` carries `head.ref` (verified against the live API), which is
 * the same branch the search qualifier matched on.
 */
export async function listOpenPrsByBranch(
  repo: WatchedRepo,
): Promise<Map<string, JoinedPr>> {
  const octokit = getGithubClient();
  const byBranch = new Map<string, JoinedPr>();
  for (let page = 1; page <= PULLS_MAX_PAGES; page++) {
    const { data } = await octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      per_page: PULLS_PER_PAGE,
      page,
    });
    for (const pr of data) {
      // First write wins, matching the old `per_page: 1` search: if two open
      // PRs somehow share a head ref, take the one GitHub lists first rather
      // than letting a later page silently reassign the branch.
      if (pr.head?.ref && !byBranch.has(pr.head.ref)) {
        byBranch.set(pr.head.ref, { number: pr.number, url: pr.html_url });
      }
    }
    if (data.length < PULLS_PER_PAGE) break;
  }
  return byBranch;
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
  // One open-PR listing per repo, fetched once and shared by every session
  // that needs a branch join - keyed by repo, not branch, because that is
  // now the unit of work. Two watched repos could legitimately share a
  // branch-naming convention, so the join itself stays repo-scoped.
  const prsByRepo = new Map<string, Promise<Map<string, JoinedPr>>>();
  const failedPrRepos = new Set<string>();
  const openPrsFor = (repo: WatchedRepo): Promise<Map<string, JoinedPr>> => {
    const key = repoKey(repo);
    let pending = prsByRepo.get(key);
    if (!pending) {
      pending = listOpenPrsByBranch(repo).catch((error) => {
        failedPrRepos.add(key);
        console.error(
          'agent-lcars: failed to list open PRs for branch joins (%s):',
          key,
          error,
        );
        warnings.push(`PR lookup failed for ${key}.`);
        // An empty map degrades to "no PR attached" for this repo's
        // sessions, matching the previous per-branch failure behavior.
        return new Map<string, JoinedPr>();
      });
      prsByRepo.set(key, pending);
    }
    return pending;
  };
  const sessions = await Promise.all(
    capped.map(async ([doc, session]) => {
      session.pr = prFromDeliverables(doc);
      if (!session.pr && doc.branch && isActive(session.liveness)) {
        const branch = doc.branch;
        const repos = doc.repo ? [doc.repo] : getWatchedRepos();
        const openPrsByRepo = await Promise.all(
          repos.map((repo) => openPrsFor(repo)),
        );
        // A failed lookup leaves a legacy repo-less session indeterminate:
        // the unavailable repo could contain the same branch and be the
        // session's actual repository. Never resolve from partial evidence.
        if (
          !doc.repo &&
          repos.some((repo) => failedPrRepos.has(repoKey(repo)))
        ) {
          return session;
        }
        const matches = openPrsByRepo.flatMap((openPrs) => {
          const match = openPrs.get(branch);
          return match ? [match] : [];
        });
        // A branch name can exist in more than one watched repo. Preserve a
        // legacy session's unknown repository instead of attaching a
        // plausible-looking but potentially wrong link.
        session.pr = matches.length === 1 ? matches[0] : undefined;
      }
      return session;
    }),
  );

  sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { sessions, warnings };
}
