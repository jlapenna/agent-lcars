import 'server-only';

import {
  issueSourceKey,
  type TrackerIssue,
} from '@agent-lcars/dispatch-contracts';
import {
  type OrchestratorStore,
  type Task,
  type TaskId,
  taskKey,
} from '@agent-lcars/orchestrator';
import type { anchorOwnerSchema } from '@agent-lcars/work';
import { toItemView } from '@agent-lcars/work/derive';
import type { z } from 'zod';

import { sessionReferencesItemNumber } from './claimed-idle';
import type { CliSession } from './cli-sessions';
import { issueReferenceForTask } from './issue-trackers';
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
type OwnerContext = Pick<WorkContext, 'sessionsFor' | 'now' | 'cliSessions'> & {
  runtime: { store: OrchestratorStore };
};

async function readTaskOwner(
  context: OwnerContext,
  taskId: TaskId | undefined,
  repository: string,
  matches: (session: CliSession, task?: Task) => boolean,
): Promise<Omit<AnchorOwner, 'anchor'>> {
  const [owner = '', name = ''] = repository.split('/');
  const [versioned, cli] = await Promise.all([
    taskId ? context.runtime.store.readTask(taskId) : undefined,
    context.cliSessions({ owner, name }),
  ]);
  let task: AnchorOwner['task'];
  if (versioned && taskId) {
    const runs = await context.runtime.store.listRuns(taskId);
    const item = toItemView({
      workId: taskKey(taskId),
      task: versioned.task,
      runs,
    });
    const { activeRunId } = versioned.task;
    const run =
      item.runs.find((candidate) => candidate.runId === activeRunId) ??
      item.runs.at(-1);
    task = {
      state: item.state,
      pipeline: item.spec.pipeline,
      runCount: versioned.task.runCount,
      ...(activeRunId === undefined ? {} : { activeRunId }),
      updatedAt: versioned.task.updatedAt,
      ...(run ? { run } : {}),
      runSessions: run ? await context.sessionsFor([run.runId]) : [],
    };
  }
  const matching = cli.sessions.filter((session) =>
    matches(session, versioned?.task),
  );
  return {
    observedAt: context.now().toISOString(),
    verdict:
      task?.state === 'running'
        ? 'fleet-run'
        : matching.some(isActive)
          ? 'interactive-session'
          : 'none',
    complete: cli.warnings.length === 0,
    warnings: cli.warnings,
    ...(task ? { task } : {}),
    cliSessions: [
      ...matching.filter(isActive),
      ...matching.filter((session) => !isActive(session)),
    ].map(toOwnerSession),
  };
}

export async function readAnchorOwner(
  context: OwnerContext,
  anchor: { repo: string; issue: number },
): Promise<AnchorOwner> {
  const [owner = '', name = ''] = anchor.repo.split('/');
  return {
    anchor,
    ...(await readTaskOwner(context, anchor, anchor.repo, (session) =>
      sessionReferencesItemNumber(session, {
        repo: { owner, name },
        number: anchor.issue,
      }),
    )),
  };
}

export async function readTrackerIssueOwner(
  context: OwnerContext,
  issue: TrackerIssue,
  repository: string,
): Promise<AnchorOwner> {
  const reference = issue.reference;
  if (reference.tracker === 'github')
    return {
      ...(await readAnchorOwner(context, reference)),
      anchor: reference,
      identifier: issue.identifier,
      repository,
    };
  const workId = await context.runtime.store.readSourceWorkId(
    issueSourceKey(reference),
  );
  if (workId) {
    const existing = await context.runtime.store.readTask({ workId });
    const bound = existing && issueReferenceForTask(existing.task);
    if (
      existing &&
      (!bound || issueSourceKey(bound) !== issueSourceKey(reference))
    )
      throw new Error('Issue source binding does not match stored Work');
  }
  const identifier = issue.identifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const branchReference = new RegExp(
    `(?:^|[^a-z0-9])${identifier}(?:[^a-z0-9]|$)`,
    'iu',
  );
  const ownership = await readTaskOwner(
    context,
    workId ? { workId } : undefined,
    repository,
    (session, task) => {
      if (
        !session.repo ||
        `${session.repo.owner}/${session.repo.name}`.toLowerCase() !==
          repository.toLowerCase()
      )
        return false;
      return (
        (session.pr !== undefined &&
          task?.delivery?.number === session.pr.number) ||
        (session.branch !== undefined && branchReference.test(session.branch))
      );
    },
  );
  return {
    anchor: reference,
    identifier: issue.identifier,
    repository,
    ...(workId ? { workId } : {}),
    ...ownership,
  };
}
