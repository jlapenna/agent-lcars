// @vitest-environment node

import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
  type Run,
} from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { readAnchorOwner } from './anchor-owner';
import type { CliSession } from './cli-sessions';

// Matches vitest-setup.ts's default AGENT_LCARS_CONTROL_PLANE_REPOSITORIES.
const REPO = 'jlapenna/agent-lcars';
const NOW = '2026-10-27T12:00:00.000Z';
const ANCHOR = { repo: REPO, issue: 42 };

function fixture(cliSessions: CliSession[] = []) {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => NOW });
  const context = {
    runtime: { store },
    now: () => new Date(NOW),
    sessionsFor: async () => [],
    cliSessions: async () => ({ sessions: cliSessions, warnings: [] }),
  };
  return { store, orchestrator, context };
}

/** Admits `ANCHOR` and settles its first run with `summary`. */
async function settled(
  orchestrator: Orchestrator,
  summary: 'park' | 'pull-request',
): Promise<Run> {
  const outcome = await orchestrator.request({
    taskId: ANCHOR,
    requestId: 'first',
    pipeline: 'claude',
    work: {
      origin: { principal: 'github:jlapenna', channel: 'github' },
      spec: {
        title: 'Fix the widget',
        description: 'A GitHub-anchored item.',
        pipeline: 'claude',
        target: { repo: REPO },
      },
    },
  });
  if (isRefusal(outcome)) throw new Error(outcome.reason);
  const run = decidedRun(outcome);
  await orchestrator.confirmDispatch(run.runId);
  const reported = await orchestrator.report(run.runId, { ok: true, summary });
  if (isRefusal(reported)) throw new Error(reported.reason);
  return run;
}

/** The PR the run opened has not merged: the binding stays `waiting` on
 *  both the task and the run, exactly as `reportResult` leaves it. */
async function bindWaitingDelivery(store: MemoryStore, run: Run) {
  const versioned = await store.readTask(ANCHOR);
  if (versioned === undefined) throw new Error('task missing');
  const delivery = {
    runId: run.runId,
    repo: REPO,
    number: 43,
    baseRef: 'main',
    head: '0'.repeat(40),
    state: 'waiting' as const,
    observedAt: NOW,
  };
  await store.apply({
    expectedRevision: versioned.revision,
    decision: {
      task: { ...versioned.task, delivery },
      run: { ...(await store.readRun(run.runId))!, delivery },
      outbox: [],
    },
  });
}

function cliSession(over: Partial<CliSession> = {}): CliSession {
  return {
    sessionId: 'cli-1',
    liveness: 'live',
    agent: 'claude-code',
    repo: { owner: 'jlapenna', name: 'agent-lcars' },
    branch: 'fix-widget-42',
    turns: 1,
    totalTokens: 100,
    startedAt: NOW,
    lastActivityAt: NOW,
    ...over,
  };
}

describe('readAnchorOwner', () => {
  it('reports no owner for an anchor with no task and no matching session', async () => {
    const { context } = fixture([cliSession({ branch: 'other-99' })]);
    const owner = await readAnchorOwner(context, ANCHOR);
    expect(owner).toMatchObject({ verdict: 'none', cliSessions: [] });
    expect(owner).not.toHaveProperty('task');
  });

  it('names the fleet while a settled run is still waiting on its PR', async () => {
    const { store, orchestrator, context } = fixture([cliSession()]);
    const run = await settled(orchestrator, 'pull-request');
    await bindWaitingDelivery(store, run);

    const owner = await readAnchorOwner(context, ANCHOR);
    expect(owner.verdict).toBe('fleet-run');
    expect(owner.task).toMatchObject({ state: 'running', runCount: 1 });
    expect(owner.task).not.toHaveProperty('activeRunId');
    expect(owner.task?.run?.runId).toBe(run.runId);
    // The live interactive session is still reported as evidence.
    expect(owner.cliSessions.map((s) => s.sessionId)).toEqual(['cli-1']);
  });

  it('does not name the fleet for a parked run whose binding is still waiting', async () => {
    const { store, orchestrator, context } = fixture([cliSession()]);
    const run = await settled(orchestrator, 'park');
    await bindWaitingDelivery(store, run);

    const owner = await readAnchorOwner(context, ANCHOR);
    expect(owner.task?.state).toBe('parked');
    expect(owner.verdict).toBe('interactive-session');
  });

  it('reports a parked item with no binding and no session as owned by nobody', async () => {
    const { orchestrator, context } = fixture();
    await settled(orchestrator, 'park');
    const owner = await readAnchorOwner(context, ANCHOR);
    expect(owner.task?.state).toBe('parked');
    expect(owner.verdict).toBe('none');
  });

  it('names the fleet while a run is live, over an interactive session', async () => {
    const { orchestrator, context } = fixture([cliSession()]);
    const outcome = await orchestrator.request({
      taskId: ANCHOR,
      requestId: 'first',
      pipeline: 'claude',
      work: {
        origin: { principal: 'github:jlapenna', channel: 'github' },
        spec: {
          title: 'Fix the widget',
          description: 'A GitHub-anchored item.',
          pipeline: 'claude',
          target: { repo: REPO },
        },
      },
    });
    if (isRefusal(outcome)) throw new Error(outcome.reason);
    const owner = await readAnchorOwner(context, ANCHOR);
    expect(owner.verdict).toBe('fleet-run');
    expect(owner.task?.activeRunId).toBe(decidedRun(outcome).runId);
  });
});
