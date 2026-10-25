// @vitest-environment node
import {
  decidedRun,
  isRefusal,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  admitHandoffSummary,
  readHandoffActions,
  withHandoffActions,
} from './handoff-summary-work';
import { executeSummaries } from './inbox-summary-work';
import { drainOutbox } from './orchestrator-dispatch';

const actions = [
  { text: 'Inspect production', command: 'check --prod' },
  { text: 'Reply with the result.' },
];
const fetchSummary = vi.fn();
beforeEach(() => {
  vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_URL', 'https://summary.example.test');
  vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_API_KEY', 'test');
  vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_MODEL', 'small');
  fetchSummary.mockReset().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ actions }) } }],
        }),
      ),
  );
  vi.stubGlobal('fetch', fetchSummary);
  vi.stubEnv(
    'AGENT_LCARS_OUTCOME_WEBHOOKS',
    JSON.stringify({
      console: { url: 'https://adapter.example.test', audience: 'test' },
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture(
  message = 'Run `check --prod`, then reply with the result.',
) {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => new Date().toISOString(),
  });
  const deliverOutcomeWebhook = vi.fn();
  const deps = {
    store,
    orchestrator,
    tokens: { tokenFor: vi.fn(async () => 'unused') },
    deliverOutcomeWebhook,
  };
  const runtime = { store, orchestrator, drain: () => drainOutbox(deps) };
  const requested = await orchestrator.request({
    taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
    requestId: 'source',
    pipeline: 'claude',
    work: {
      origin: {
        principal: 'user:test',
        channel: 'console',
        thread: 'original-thread',
      },
      spec: {
        title: 'Real handoff shape',
        description: 'Task',
        pipeline: 'claude',
        priority: 'normal',
        target: { repo: 'owner/repo' },
      },
    },
  });
  if (isRefusal(requested)) throw new Error(requested.reason);
  const sourceId = decidedRun(requested).runId;
  await runtime.drain();
  await orchestrator.report(sourceId, { ok: true, summary: 'park', message });
  return { ...runtime, runtime, sourceId, deliverOutcomeWebhook };
}

describe('handoff summary Work', () => {
  it('recovers admission independently of outcome delivery and reads only the exact immutable source', async () => {
    const { runtime, sourceId, deliverOutcomeWebhook } = await fixture(
      'Run `check --prod`, then reply. ' + '界'.repeat(12_000),
    );
    const original = (await runtime.store.readRun(sourceId))!;
    const admit = runtime.store.resolveSourceWorkId.bind(runtime.store);
    vi.spyOn(runtime.store, 'resolveSourceWorkId')
      .mockRejectedValueOnce(new Error('temporary store failure'))
      .mockImplementation(admit);
    const first = await runtime.drain();
    expect(first.reported).toContain(sourceId);
    expect(deliverOutcomeWebhook).toHaveBeenCalledTimes(1);
    expect(first.failed).toEqual([
      expect.objectContaining({ entryId: `handoff-summary/${sourceId}` }),
    ]);
    expect(fetchSummary).not.toHaveBeenCalled();
    // Re-delivery after interruption uses the same durable identity.
    await Promise.all([
      admitHandoffSummary(runtime, original),
      admitHandoffSummary(runtime, original),
    ]);
    expect(await readHandoffActions(runtime.store, original)).toBeUndefined();
    await runtime.drain();
    await executeSummaries(runtime);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(await readHandoffActions(runtime.store, original)).toEqual(actions);
    expect(await withHandoffActions(runtime.store, [original])).toMatchObject([
      {
        result: {
          summary: 'park',
          message: original.result?.message,
          humanNeededActions: actions,
        },
      },
    ]);
    expect(await runtime.store.readRun(sourceId)).toEqual(original);
    expect(
      await readHandoffActions(runtime.store, {
        ...original,
        runId: `${sourceId}-other`,
      }),
    ).toBeUndefined();
    expect(
      await readHandoffActions(runtime.store, {
        ...original,
        result: { ...original.result!, message: 'Changed handoff' },
      }),
    ).toBeUndefined();
    await admitHandoffSummary(runtime, original);
    await runtime.drain();
    await executeSummaries(runtime);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
    expect(deliverOutcomeWebhook).toHaveBeenCalledTimes(1);
  });

  it('releases the same attempt when reading the source consumes the model budget', async () => {
    vi.useFakeTimers();
    const { runtime, sourceId } = await fixture();
    await runtime.drain();
    const [queued] = await runtime.store.listQueuedRuns();
    const deadline = Date.now() + 20_000;
    const read = runtime.store.readRun.bind(runtime.store);
    vi.spyOn(runtime.store, 'readRun').mockImplementation(async (id) => {
      if (id === sourceId) vi.setSystemTime(deadline);
      return read(id);
    });
    await executeSummaries(runtime, undefined, deadline);
    expect(fetchSummary).not.toHaveBeenCalled();
    expect(await runtime.store.listQueuedRuns()).toMatchObject([
      { runId: queued?.runId, revisionAttempt: queued?.revisionAttempt },
    ]);
    vi.mocked(runtime.store.readRun).mockImplementation(read);
    await executeSummaries(runtime, undefined, Date.now() + 45_000);
    expect(fetchSummary).toHaveBeenCalledTimes(1);
  });

  it('retains raw handoff after three failed attempts without retrying on reads or event redelivery', async () => {
    const { runtime, sourceId } = await fixture();
    const original = (await runtime.store.readRun(sourceId))!;
    fetchSummary.mockRejectedValue(new Error('provider unavailable'));
    for (let i = 0; i < 4; i++) {
      await runtime.drain();
      await executeSummaries(runtime);
    }
    expect(fetchSummary).toHaveBeenCalledTimes(3);
    expect(await readHandoffActions(runtime.store, original)).toBeUndefined();
    await admitHandoffSummary(runtime, original);
    await runtime.drain();
    await executeSummaries(runtime);
    expect(fetchSummary).toHaveBeenCalledTimes(3);
    expect(await runtime.store.readRun(sourceId)).toEqual(original);
  });
});
