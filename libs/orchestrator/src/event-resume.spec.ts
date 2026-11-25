import { describe, expect, it } from 'vitest';

import {
  decidedRun,
  EVENT_RESUME_OUTBOX_PREFIX,
  eventResumeRequestId,
  isRefusal,
  type Refusal,
} from './decide';
import { MemoryStore } from './memory-store';
import {
  MAX_EVENT_RESUMES,
  MAX_PENDING_EVENT_RESUMES,
  type TaskId,
  type WorkAnchor,
} from './model';
import { Orchestrator } from './orchestrator';
import { OUTBOX_LEASE_MS } from './store';

const WORK: WorkAnchor = { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' };
const GITHUB: TaskId = { repo: 'octo/example', issue: 7 };
const T0 = '2026-11-25T12:00:00.000Z';
const TASK_WORK = { spec: { title: 'event resume test work' } };

function fixture() {
  let now = T0;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(Date.parse(now) + ms).toISOString();
    },
  };
  const store = new MemoryStore();
  return { clock, store, orchestrator: new Orchestrator(store, clock) };
}

type Fixture = ReturnType<typeof fixture>;

async function startRun(
  { orchestrator }: Fixture,
  requestId = 'req-1',
  params: Record<string, string> = { mode: 'implement' },
  taskId: TaskId = WORK,
) {
  const outcome = await orchestrator.request({
    taskId,
    requestId,
    pipeline: 'claude',
    work: TASK_WORK,
    params,
  });
  if (isRefusal(outcome)) throw new Error(`refused: ${outcome.reason}`);
  return decidedRun(outcome);
}

async function finish({ orchestrator }: Fixture, runId: string) {
  const outcome = await orchestrator.report(runId, {
    ok: true,
    summary: 'park',
  });
  if (isRefusal(outcome)) throw new Error(`refused: ${outcome.reason}`);
  return outcome;
}

function queue(
  f: Fixture,
  deliveryId: string,
  notice = `notice ${deliveryId}`,
) {
  return f.orchestrator.queueEventResume(WORK, { deliveryId, notice });
}

async function eventResumeEntries({ store }: Fixture) {
  const entries = await store.claimPendingOutbox({
    limit: 50,
    now: T0,
    leaseExpiresAt: new Date(Date.parse(T0) + OUTBOX_LEASE_MS).toISOString(),
  });
  return entries
    .filter((entry) => entry.kind === 'event-resume')
    .map((entry) => entry.entryId);
}

/** What the drain does for an `event-resume` entry: admit the oldest
 * waiting event's run. */
async function admit(f: Fixture) {
  const task = await f.store.readTask(WORK);
  const oldest = task?.task.eventResumes?.pending[0];
  return f.orchestrator.admitEventResume({
    taskId: WORK,
    requestId: eventResumeRequestId(oldest?.seq ?? 1),
    pipeline: 'claude',
  });
}

function refusal(outcome: unknown): Refusal['reason'] | undefined {
  return isRefusal(outcome as never) ? (outcome as Refusal).reason : undefined;
}

describe('event-resume (#3570)', () => {
  it('hands an event for an idle Work to the drain and resumes it with the notice', async () => {
    const f = fixture();
    const first = await startRun(f);
    await finish(f, first.runId);

    const queued = await queue(f, 'sub-1:ev-1', '[lcars-event] key done');
    expect(refusal(queued)).toBeUndefined();
    expect(await eventResumeEntries(f)).toEqual([
      `${EVENT_RESUME_OUTBOX_PREFIX}work:${WORK.workId}/e1`,
    ]);

    const admitted = await admit(f);
    if (isRefusal(admitted)) throw new Error(admitted.reason);
    const run = decidedRun(admitted);
    expect(run).toMatchObject({
      requestSource: 'event',
      requestId: 'event:e1',
      pipeline: 'claude',
      params: {
        mode: 'event',
        eventNotice: '[lcars-event] key done',
        eventDeliveries: 'sub-1:ev-1',
      },
    });
    expect(admitted.task.activeRunId).toBe(run.runId);
    expect(admitted.task.eventResumes).toMatchObject({
      received: 1,
      admitted: 1,
      pending: [],
    });
  });

  it('keeps an event that arrives while the subscribing run is still live, and resumes once it settles', async () => {
    const f = fixture();
    const first = await startRun(f);

    const queued = await queue(f, 'sub-1:ev-1');
    expect(refusal(queued)).toBeUndefined();
    // Busy: nothing for the drain yet, and admission is refused.
    expect(await eventResumeEntries(f)).toEqual([]);
    expect(refusal(await admit(f))).toBe('task-busy');
    expect(
      (await f.store.readTask(WORK))?.task.eventResumes?.pending,
    ).toHaveLength(1);

    const settled = await finish(f, first.runId);
    expect(settled.outbox.map((entry) => entry.entryId)).toContain(
      `${EVENT_RESUME_OUTBOX_PREFIX}${first.runId}`,
    );
    const admitted = await admit(f);
    expect(refusal(admitted)).toBeUndefined();
  });

  it('resumes exactly once for a repeated event or a repeated admission', async () => {
    const f = fixture();
    const first = await startRun(f);
    await finish(f, first.runId);

    expect(refusal(await queue(f, 'sub-1:ev-1'))).toBeUndefined();
    expect(refusal(await queue(f, 'sub-1:ev-1'))).toBe('duplicate-request');

    const admitted = await admit(f);
    if (isRefusal(admitted)) throw new Error(admitted.reason);
    const again = await f.orchestrator.admitEventResume({
      taskId: WORK,
      requestId: 'event:e1',
      pipeline: 'claude',
    });
    expect(refusal(again)).toBe('duplicate-request');
    expect((again as Refusal).existingRun?.runId).toBe(
      decidedRun(admitted).runId,
    );
    // A repeat after the resume ran is still remembered.
    await finish(f, decidedRun(admitted).runId);
    expect(refusal(await queue(f, 'sub-1:ev-1'))).toBe('duplicate-request');
    const nothing = await f.orchestrator.admitEventResume({
      taskId: WORK,
      requestId: 'event:e2',
      pipeline: 'claude',
    });
    expect(refusal(nothing)).toBe('no-pending-event');
  });

  it('resumes once for several events that arrive while the Work is busy', async () => {
    const f = fixture();
    const first = await startRun(f);
    await queue(f, 'sub-1:ev-1', 'first');
    await queue(f, 'sub-2:ev-2', 'second');
    await finish(f, first.runId);

    const admitted = await admit(f);
    if (isRefusal(admitted)) throw new Error(admitted.reason);
    expect(decidedRun(admitted).params).toMatchObject({
      eventNotice: 'first\n\nsecond',
      eventDeliveries: 'sub-1:ev-1,sub-2:ev-2',
    });
    expect(admitted.task.eventResumes?.admitted).toBe(1);
  });

  it('refuses a stale admission without changing anything', async () => {
    const f = fixture();
    const first = await startRun(f);
    await finish(f, first.runId);
    await queue(f, 'sub-1:ev-1');
    const stale = await f.orchestrator.admitEventResume({
      taskId: WORK,
      requestId: 'event:e9',
      pipeline: 'claude',
    });
    expect(refusal(stale)).toBe('stale-lease');
    expect(
      (await f.store.readTask(WORK))?.task.eventResumes?.pending,
    ).toHaveLength(1);
  });

  it(`caps resumes at ${MAX_EVENT_RESUMES} in a row, and a human reply restarts the count`, async () => {
    const f = fixture();
    let run = await startRun(f);
    await finish(f, run.runId);
    for (let i = 1; i <= MAX_EVENT_RESUMES; i += 1) {
      expect(refusal(await queue(f, `sub:ev-${i}`))).toBeUndefined();
      const admitted = await admit(f);
      if (isRefusal(admitted)) throw new Error(admitted.reason);
      run = decidedRun(admitted);
      await finish(f, run.runId);
    }
    expect(refusal(await queue(f, 'sub:ev-over'))).toBe('event-resume-limit');

    const reply = await startRun(f, 'reply-1', {
      mode: 'reply',
      reply: 'carry on',
      replyPrincipal: 'github:jlapenna',
    });
    expect((await f.store.readTask(WORK))?.task.eventResumes?.admitted).toBe(0);
    await finish(f, reply.runId);
    expect(refusal(await queue(f, 'sub:ev-after-reply'))).toBeUndefined();
  });

  it(`refuses more than ${MAX_PENDING_EVENT_RESUMES} waiting events`, async () => {
    const f = fixture();
    await startRun(f);
    for (let i = 1; i <= MAX_PENDING_EVENT_RESUMES; i += 1)
      expect(refusal(await queue(f, `sub:ev-${i}`))).toBeUndefined();
    expect(refusal(await queue(f, 'sub:ev-overflow'))).toBe(
      'event-resume-limit',
    );
  });

  it('keeps waiting events across a run that another request admits', async () => {
    const f = fixture();
    const first = await startRun(f);
    await queue(f, 'sub-1:ev-1');
    await finish(f, first.runId);
    // A human reply takes the Work before the drain admits the event.
    const reply = await startRun(f, 'reply-1', {
      mode: 'reply',
      reply: 'x',
      replyPrincipal: 'github:jlapenna',
    });
    expect(refusal(await admit(f))).toBe('task-busy');
    const settled = await finish(f, reply.runId);
    expect(settled.outbox.map((entry) => entry.kind)).toContain('event-resume');
    expect(refusal(await admit(f))).toBeUndefined();
  });

  it('refuses events for closed, unknown and GitHub-anchored tasks', async () => {
    const f = fixture();
    expect(refusal(await queue(f, 'sub:ev-unknown'))).toBe('unknown-task');
    const first = await startRun(f);
    await finish(f, first.runId);
    await f.orchestrator.close(WORK);
    expect(refusal(await queue(f, 'sub:ev-closed'))).toBe('task-closed');

    await startRun(f, 'gh-1', { mode: 'implement' }, GITHUB);
    const github = await f.orchestrator.queueEventResume(
      GITHUB as unknown as WorkAnchor,
      { deliveryId: 'sub:ev', notice: 'n' },
    );
    expect(refusal(github)).toBe('not-native');
  });
});
