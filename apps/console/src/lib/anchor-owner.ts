import 'server-only';

import type { OrchestratorStore } from '@agent-lcars/orchestrator';
import type { anchorOwnerSchema } from '@agent-lcars/work';
import { toItemView } from '@agent-lcars/work/derive';
import type { z } from 'zod';

import { sessionReferencesItemNumber } from './claimed-idle';
import type { CliSession } from './cli-sessions';
import type { WorkContext } from './work-mint';

/** The handler's side of the contract: `z.input`, because oRPC validates the
 *  returned value through the output schema (which fills defaults). */
type AnchorOwner = z.input<typeof anchorOwnerSchema>;

function isActive(session: CliSession): boolean {
  return session.liveness === 'live' || session.liveness === 'idle';
}

function toOwnerSession(
  session: CliSession,
): AnchorOwner['cliSessions'][number] {
  return {
    sessionId: session.sessionId,
    agent: session.agent,
    liveness: session.liveness,
    ...(session.host === undefined ? {} : { host: session.host }),
    ...(session.branch === undefined ? {} : { branch: session.branch }),
    ...(session.pr === undefined ? {} : { pr: session.pr }),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.status === undefined ? {} : { status: session.status }),
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
  };
}

/**
 * Who Console says is working one GitHub anchor (#2502), read from what
 * Console already holds and nothing else: the orchestrator task's live-run
 * mutex and run history, the fleet sessions recorded for that run, and CLI
 * session telemetry matched by `sessionReferencesItemNumber` -- the same
 * matcher the Agents page's Claimed but Idle section uses. A live run wins
 * over an interactive session because the run holds the task's mutex; both
 * are still reported as evidence.
 */
export async function readAnchorOwner(
  context: Pick<WorkContext, 'sessionsFor' | 'now'> & {
    runtime: { store: OrchestratorStore };
    cliSessions: WorkContext['cliSessions'];
  },
  anchor: { repo: string; issue: number },
): Promise<AnchorOwner> {
  const [owner = '', name = ''] = anchor.repo.split('/');
  const taskId = { repo: anchor.repo, issue: anchor.issue };
  const [versioned, cli] = await Promise.all([
    context.runtime.store.readTask(taskId),
    context.cliSessions({ owner, name }),
  ]);

  let task: AnchorOwner['task'];
  if (versioned !== undefined) {
    const runs = await context.runtime.store.listRuns(taskId);
    const item = toItemView({
      workId: `${anchor.repo}#${anchor.issue}`,
      task: versioned.task,
      runs,
    });
    const { activeRunId } = versioned.task;
    // `item.runs` is oldest first; the live run is the mutex holder when
    // there is one, otherwise the newest run is the most recent evidence.
    const run =
      (activeRunId === undefined
        ? undefined
        : item.runs.find((candidate) => candidate.runId === activeRunId)) ??
      item.runs.at(-1);
    task = {
      state: item.state,
      pipeline: item.spec.pipeline,
      runCount: versioned.task.runCount,
      ...(activeRunId === undefined ? {} : { activeRunId }),
      updatedAt: versioned.task.updatedAt,
      ...(run === undefined ? {} : { run }),
      runSessions:
        run === undefined ? [] : await context.sessionsFor([run.runId]),
    };
  }

  const item = { repo: { owner, name }, number: anchor.issue };
  const matching = cli.sessions.filter((session) =>
    sessionReferencesItemNumber(session, item),
  );
  // The fleet owns the anchor exactly when the item is `running`: a live run
  // holds the mutex, or a settled run's PR is still waiting to merge
  // (`deriveItemState`). A parked or failed item with that same waiting
  // binding is back in a human's court, so the binding alone is not a
  // verdict.
  const verdict: AnchorOwner['verdict'] =
    task?.state === 'running'
      ? 'fleet-run'
      : matching.some(isActive)
        ? 'interactive-session'
        : 'none';

  return {
    anchor: taskId,
    observedAt: context.now().toISOString(),
    verdict,
    complete: cli.warnings.length === 0,
    warnings: cli.warnings,
    ...(task === undefined ? {} : { task }),
    cliSessions: [
      ...matching.filter(isActive),
      ...matching.filter((session) => !isActive(session)),
    ].map(toOwnerSession),
  };
}
