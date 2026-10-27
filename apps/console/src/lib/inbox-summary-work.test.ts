// @vitest-environment node
import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { summaryTitle } from './handoff-summary-work';
import {
  admitInboxSummary as admit,
  executeSummaries as execute,
} from './inbox-summary-work';
import { drainOutbox } from './orchestrator-dispatch';
import type { OrchestratorRouteDeps } from './orchestrator-routes';

const admitInboxSummary = (
  runtime: OrchestratorRouteDeps,
  input: string,
  observed = JSON.parse(input).updatedAt,
) => admit(runtime, input, { source: observed });

async function executeSummaries(
  runtime: OrchestratorRouteDeps,
  generate?: Parameters<typeof execute>[1],
) {
  await runtime.drain();
  await execute(runtime, generate);
}

function fixture() {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => new Date().toISOString(),
  });
  const tokenFor = vi.fn(async () => 'unused');
  const deliverOutcomeWebhook = vi.fn();
  const runtime: OrchestratorRouteDeps = {
    store,
    orchestrator,
    drain: () =>
      drainOutbox({
        store,
        orchestrator,
        tokens: { tokenFor },
        deliverOutcomeWebhook,
      }),
  };
  return { runtime, tokenFor, deliverOutcomeWebhook };
}
const context = (revision: string, number = 1) =>
  JSON.stringify({
    repo: 'owner/repo',
    number,
    updatedAt: `2026-10-25T00:00:0${revision.charCodeAt(0) - 97}.000Z`,
    revision,
    latestComment: `Choose ${revision}`,
  });

beforeEach(() => {
  vi.stubEnv(
    'AGENT_LCARS_HANDOFF_SUMMARY_URL',
    'https://summary.example.test/v1/chat/completions',
  );
  vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_API_KEY', 'test-only-key');
  vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_MODEL', 'small-summary-model');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Inbox summaries through Work', () => {
  it('does not drain unrelated outcomes while rendering or break maintenance on invalid optional configuration', async () => {
    const { runtime } = fixture();
    const drain = vi.spyOn(runtime, 'drain');
    await admitInboxSummary(runtime, context('a'));
    expect(drain).not.toHaveBeenCalled();
    vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_MODEL', '');
    await expect(execute(runtime)).resolves.toBeUndefined();
    expect(drain).not.toHaveBeenCalled();
  });

  it('limits maintenance inference to one item and the remaining HTTP budget', async () => {
    vi.useFakeTimers();
    const { runtime } = fixture();
    await admitInboxSummary(runtime, context('a', 1));
    await admitInboxSummary(runtime, context('a', 2));
    await runtime.drain();
    const generate = vi.fn(async () => 'Choose a.');
    const deadline = Date.now() + 20_000;
    await execute(runtime, generate, deadline);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.any(String), 15_000);
    // A spent request budget leaves queued work for a later tick, without
    // consuming an attempt or requiring post-response CPU to make progress.
    vi.setSystemTime(deadline);
    await execute(runtime, generate, deadline);
    expect(generate).toHaveBeenCalledTimes(1);
    await execute(runtime, generate, Date.now() + 45_000);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenLastCalledWith(expect.any(String), 30_000);
  });

  it('preserves the same queued attempt when claiming exhausts the request budget', async () => {
    vi.useFakeTimers();
    const { runtime } = fixture();
    await admitInboxSummary(runtime, context('a'));
    await runtime.drain();
    const [queued] = await runtime.store.listQueuedRuns();
    const deadline = Date.now() + 20_000;
    const claim = runtime.store.claimQueuedRun.bind(runtime.store);
    vi.spyOn(runtime.store, 'claimQueuedRun').mockImplementationOnce(
      async (input) => {
        const run = await claim(input);
        vi.setSystemTime(deadline);
        return run;
      },
    );
    const generate = vi.fn(async () => 'Choose a.');
    await execute(runtime, generate, deadline);
    expect(generate).not.toHaveBeenCalled();
    expect(await runtime.store.listQueuedRuns()).toMatchObject([
      { runId: queued?.runId, revisionAttempt: queued?.revisionAttempt },
    ]);
    await execute(runtime, generate, Date.now() + 45_000);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await admitInboxSummary(runtime, context('a'))).toEqual({
      pending: false,
      description: 'Choose a.',
    });
  });

  it('persists the current reading aid without sending an outcome notification', async () => {
    const { runtime, tokenFor, deliverOutcomeWebhook } = fixture();
    expect(await admitInboxSummary(runtime, context('a'))).toEqual({
      pending: true,
    });
    const generate = vi.fn(async () => 'Choose a.');
    await executeSummaries(runtime, generate);
    expect(await admitInboxSummary(runtime, context('a'))).toEqual({
      pending: false,
      description: 'Choose a.',
    });
    expect(generate).toHaveBeenCalledTimes(1);
    await runtime.drain();
    expect(tokenFor).not.toHaveBeenCalled();
    expect(deliverOutcomeWebhook).not.toHaveBeenCalled();
  });

  it('keeps only the newest queued input and never publishes the active obsolete result', async () => {
    const { runtime } = fixture();
    await admitInboxSummary(runtime, context('a'));
    let finish!: (value: string) => void;
    const generate = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue('Choose c.');
    const running = executeSummaries(runtime, generate);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await admitInboxSummary(runtime, context('b'));
    await admitInboxSummary(runtime, context('c'));
    finish('Obsolete a.');
    await running;
    await executeSummaries(runtime, generate);
    expect(
      generate.mock.calls.map(([input]) => JSON.parse(input).revision),
    ).toEqual(['a', 'c']);
    expect(await admitInboxSummary(runtime, context('c'))).toEqual({
      pending: false,
      description: 'Choose c.',
    });
    expect(
      (await admitInboxSummary(runtime, context('b'))).description,
    ).toBeUndefined();
    expect((await admitInboxSummary(runtime, context('c'))).description).toBe(
      'Choose c.',
    );
  });

  it('does not replace a newer result with a late older snapshot never previously seen', async () => {
    const { runtime } = fixture();
    await admitInboxSummary(runtime, context('c'));
    const generate = vi.fn(async () => 'Choose c.');
    await executeSummaries(runtime, generate);
    expect(await admitInboxSummary(runtime, context('a'))).toEqual({
      pending: false,
    });
    await executeSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await admitInboxSummary(runtime, context('c'))).description).toBe(
      'Choose c.',
    );
  });

  it('handles A to B to A without rerunning unchanged snapshots or accepting a delayed B', async () => {
    const { runtime } = fixture();
    const a = context('a');
    const b = JSON.stringify({ ...JSON.parse(a), latestComment: 'Choose b' });
    const generate = vi.fn(
      async (input: string) => JSON.parse(input).latestComment,
    );
    const times = [0, 1, 2, 3].map(
      (second) => `2026-10-25T01:00:0${second}.000Z`,
    );
    await admitInboxSummary(runtime, a, times[0]);
    await executeSummaries(runtime, generate);
    expect(
      (await admitInboxSummary(runtime, b, times[0])).description,
    ).toBeUndefined();
    await executeSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(1);
    await admitInboxSummary(runtime, b, times[1]);
    await executeSummaries(runtime, generate);
    await admitInboxSummary(runtime, a, times[2]);
    await executeSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(3);
    expect((await admitInboxSummary(runtime, a, times[3])).description).toBe(
      'Choose a',
    );
    expect(
      (await admitInboxSummary(runtime, b, times[1])).description,
    ).toBeUndefined();
    await executeSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('enforces the shared claim limit across concurrent executors and recovers queued work', async () => {
    const { runtime } = fixture();
    for (let number = 1; number <= 5; number++)
      await admitInboxSummary(runtime, context('a', number));
    const finishes: Array<(value: string) => void> = [];
    const generate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishes.push(resolve);
        }),
    );
    const workers = Array.from({ length: 5 }, () =>
      executeSummaries(runtime, generate),
    );
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
    finishes.splice(0).forEach((resolve) => resolve('Choose a.'));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(5));
    finishes.splice(0).forEach((resolve) => resolve('Choose a.'));
    await Promise.all(workers);
    expect(await admitInboxSummary(runtime, context('a', 5))).toEqual({
      pending: false,
      description: 'Choose a.',
    });
  });

  it('names the summary after its source and keeps one linkable source key', async () => {
    const { runtime } = fixture();
    const admitted: string[] = [];
    const resolve = runtime.store.resolveSourceWorkId.bind(runtime.store);
    vi.spyOn(runtime.store, 'resolveSourceWorkId').mockImplementation(
      async (sourceKey, candidate) => {
        const workId = await resolve(sourceKey, candidate);
        admitted.push(workId);
        return workId;
      },
    );
    await admitInboxSummary(
      runtime,
      JSON.stringify({
        workId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G',
        title: 'Reconcile the parked dispatch',
        updatedAt: '2026-10-25T00:00:00.000Z',
      }),
    );
    await admitInboxSummary(
      runtime,
      JSON.stringify({
        repo: 'owner/repo',
        number: 7,
        updatedAt: '2026-10-25T00:00:00.000Z',
      }),
    );
    const specs = await Promise.all(
      admitted.map(
        async (workId) => (await runtime.store.readTask({ workId }))?.task.work,
      ),
    );
    expect(specs[0]).toMatchObject({
      spec: {
        title: 'Inbox summary: Reconcile the parked dispatch',
        sourceKey: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G',
      },
    });
    expect(specs[1]).toMatchObject({
      spec: { title: 'Inbox summary: owner/repo#7', sourceKey: 'owner/repo#7' },
    });
  });

  it('bounds a long source title inside the shared work title limit', () => {
    expect(
      summaryTitle('Inbox summary', '界'.repeat(400), 'owner/repo#7'),
    ).toHaveLength(256);
    expect(summaryTitle('Inbox summary', '   ', 'owner/repo#7')).toBe(
      'Inbox summary: owner/repo#7',
    );
    expect(summaryTitle('Handoff summary', undefined, 'work:a/r1')).toBe(
      'Handoff summary: work:a/r1',
    );
  });

  it('retains source fallback after finite failures instead of restarting on each render', async () => {
    const { runtime } = fixture();
    await admitInboxSummary(runtime, context('a'));
    const generate = vi.fn(async () => undefined);
    await executeSummaries(runtime, generate);
    await executeSummaries(runtime, generate);
    await executeSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(await admitInboxSummary(runtime, context('a'))).toEqual({
      pending: false,
    });
    await executeSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(3);
  });
});
