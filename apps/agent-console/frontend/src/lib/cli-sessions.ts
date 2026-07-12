import type { CliSessionDoc, SessionLiveness } from '@repo/agent-telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocs,
} from '@repo/agent-telemetry/server';

import { getGithubClient, REPO_NAME, REPO_OWNER } from './github-client';

export interface JoinedPr {
  number: number;
  title: string;
  url: string;
}

export interface CliSession {
  sessionId: string;
  liveness: SessionLiveness;
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
}

function toCliSession(doc: CliSessionDoc): CliSession {
  return {
    sessionId: doc.sessionId,
    liveness: doc.liveness,
    host: doc.host,
    branch: doc.branch,
    worktree: doc.worktree,
    model: doc.model,
    turns: doc.turns,
    totalTokens: doc.tokens.inputTokens + doc.tokens.outputTokens,
    title: doc.title,
    startedAt: doc.startedAt,
    lastActivityAt: doc.lastActivityAt,
  };
}

/**
 * Joins a branch to an open PR via the same GitHub search client used for
 * runner `display_title` matching (see `agent-activity.ts`) - a live PR
 * search rather than a stored field, since a CLI session's branch can grow a
 * PR after the session doc was last written.
 */
export async function joinBranchToPr(
  branch: string,
): Promise<JoinedPr | undefined> {
  const octokit = getGithubClient();
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${REPO_OWNER}/${REPO_NAME} is:pr is:open head:${branch}`,
    per_page: 1,
  });
  const pr = data.items[0];
  if (!pr) {
    return undefined;
  }
  return { number: pr.number, title: pr.title, url: pr.html_url };
}

export interface CliSessionsResult {
  sessions: CliSession[];
  /** Human-readable notes when the store or a join degraded instead of
   * crashing (e.g. no telemetry infra reachable - PRD item 16). */
  warnings: string[];
}

/**
 * Fetches every `source: 'cli'` session doc from the agent-telemetry store
 * and joins each one's branch to an open PR when it has one. One malformed
 * doc or one failed PR lookup degrades that single session instead of
 * crashing the whole list, matching the defensive pattern in
 * `agent-activity.ts` / `action-items.ts`. A store-level failure (e.g. no
 * telemetry infra reachable) degrades to an empty list rather than crashing
 * the dashboard - the existing GitHub-derived view must still work.
 */
export async function getCliSessions(): Promise<CliSessionsResult> {
  let docs: CliSessionDoc[];
  try {
    const firestore = await getAgentTelemetryReaderFirestore();
    const allDocs = await listSessionDocs(firestore);
    docs = allDocs.filter((doc): doc is CliSessionDoc => doc.source === 'cli');
  } catch (error) {
    console.error('agent-console: failed to list CLI sessions:', error);
    return {
      sessions: [],
      warnings: ['CLI sessions unavailable (agent-telemetry store failed).'],
    };
  }

  const warnings: string[] = [];
  const sessions = await Promise.all(
    docs.map(async (doc) => {
      const session = toCliSession(doc);
      if (!doc.branch) {
        return session;
      }
      try {
        session.pr = await joinBranchToPr(doc.branch);
      } catch (error) {
        console.error(
          `agent-console: failed to join branch "${doc.branch}" to a PR:`,
          error,
        );
        warnings.push(`PR lookup failed for branch "${doc.branch}".`);
      }
      return session;
    }),
  );

  sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { sessions, warnings };
}
