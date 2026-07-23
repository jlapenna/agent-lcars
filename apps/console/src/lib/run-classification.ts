import type { IssueAgentSessionDoc } from '@agent-lcars/telemetry';
import {
  classifyRunStatus,
  type RunStatusClassifierResult,
} from '@agent-lcars/telemetry';

import { type AgentRun, RUN_TIMEOUT_MINUTES } from './agent-activity';
import { repoItemKey } from './github-client';

/**
 * Bridges the console's `AgentRun`/`IssueAgentSessionDoc` types to the pure
 * classifier in `@agent-lcars/telemetry` (which stays app-agnostic - libs
 * must not import from apps), and supplies the one caller-owned input the
 * classifier needs: the workflow's wall-clock kill budget. This is the
 * single place `RUN_TIMEOUT_MINUTES` and a run's fields get turned into a
 * classification - every row that renders a run's status calls this rather
 * than re-deriving it.
 */
export function classifyAgentRun(
  run: AgentRun,
  session?: IssueAgentSessionDoc,
): RunStatusClassifierResult {
  return classifyRunStatus(
    {
      status: run.status,
      conclusion: run.conclusion,
      elapsedSeconds: run.elapsedSeconds,
      timeoutMinutes: RUN_TIMEOUT_MINUTES,
    },
    session && {
      turns: session.turns,
      result: session.result,
      totalCostUsd: session.totalCostUsd,
    },
  );
}

/**
 * Joins finished runs to their session doc (by runId) and classifies each;
 * returns issue-number -> diagnosis for every run the classifier flagged
 * `silent-error` - GitHub said success, but the session shows a known
 * failure signature (error result) or recorded essentially no work (zero
 * turns, or zero cost across at most one turn) - see
 * `@agent-lcars/telemetry`'s `run-status-classifier.ts` for why this is
 * deliberately narrower than a "no PR/commit" check (claude.yml's own
 * server-side gates already cover that ground with better data). Used to
 * elevate those items into "Needs Your Action" (see page.tsx) even though
 * nothing in the item's own GitHub state (labels, checks, reviews) says
 * anything is wrong. A run whose `issueNumber` is unparseable, or with no
 * joined session doc at all, contributes nothing (graceful degradation -
 * PRD user story 16).
 *
 * Keyed by `repoItemKey(run.repo, run.issueNumber)`, not the bare issue
 * number - issue numbers only disambiguate within one repo, and this must
 * still distinguish, say, `owner-a/repo#42` from `owner-b/repo#42`.
 */
export function deriveSilentErrorDiagnoses(
  recentRuns: AgentRun[],
  sessionsByRunId: Map<string, IssueAgentSessionDoc>,
): Map<string, string> {
  const diagnoses = new Map<string, string>();
  for (const run of recentRuns) {
    if (run.issueNumber === undefined) continue;
    const session = sessionsByRunId.get(String(run.id));
    const classification = classifyAgentRun(run, session);
    if (classification.status === 'silent-error' && classification.diagnosis) {
      diagnoses.set(
        repoItemKey(run.repo, run.issueNumber),
        classification.diagnosis,
      );
    }
  }
  return diagnoses;
}

/**
 * Builds the run.id -> session-doc lookup every row-rendering component
 * needs (`LiveRunRow`'s budget gauges, `FinishedRunRow`'s classification) -
 * one small helper shared by both page.tsx entry points instead of each
 * re-deriving the same `String(run.id)` join.
 */
export function indexSessionsByNumericRunId(
  runs: AgentRun[],
  sessionsByRunId: Map<string, IssueAgentSessionDoc>,
): Record<number, IssueAgentSessionDoc> {
  const result: Record<number, IssueAgentSessionDoc> = {};
  for (const run of runs) {
    const session = sessionsByRunId.get(String(run.id));
    if (session) {
      result[run.id] = session;
    }
  }
  return result;
}
