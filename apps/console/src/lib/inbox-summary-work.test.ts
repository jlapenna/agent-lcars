// @vitest-environment node
import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  admitInboxSummary as admit,
  executeInboxSummaries as execute,
} from './inbox-summary-work';
import { drainOutbox } from './orchestrator-dispatch';
import type { OrchestratorRouteDeps } from './orchestrator-routes';

const admitInboxSummary = (
  runtime: OrchestratorRouteDeps,
  input: string,
  observed = JSON.parse(input).updatedAt,
) => admit(runtime, input, { source: observed });

async function executeInboxSummaries(
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
afterEach(() => vi.unstubAllEnvs());

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

  it('persists the current reading aid without sending an outcome notification', async () => {
    const { runtime, tokenFor, deliverOutcomeWebhook } = fixture();
    expect(await admitInboxSummary(runtime, context('a'))).toEqual({
      pending: true,
    });
    const generate = vi.fn(async () => 'Choose a.');
    await executeInboxSummaries(runtime, generate);
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
    const running = executeInboxSummaries(runtime, generate);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await admitInboxSummary(runtime, context('b'));
    await admitInboxSummary(runtime, context('c'));
    finish('Obsolete a.');
    await running;
    await executeInboxSummaries(runtime, generate);
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
    await executeInboxSummaries(runtime, generate);
    expect(await admitInboxSummary(runtime, context('a'))).toEqual({
      pending: false,
    });
    await executeInboxSummaries(runtime, generate);
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
    await executeInboxSummaries(runtime, generate);
    expect(
      (await admitInboxSummary(runtime, b, times[0])).description,
    ).toBeUndefined();
    await executeInboxSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(1);
    await admitInboxSummary(runtime, b, times[1]);
    await executeInboxSummaries(runtime, generate);
    await admitInboxSummary(runtime, a, times[2]);
    await executeInboxSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(3);
    expect((await admitInboxSummary(runtime, a, times[3])).description).toBe(
      'Choose a',
    );
    expect(
      (await admitInboxSummary(runtime, b, times[1])).description,
    ).toBeUndefined();
    await executeInboxSummaries(runtime, generate);
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
      executeInboxSummaries(runtime, generate),
    );
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(4));
    finishes.splice(0).forEach((resolve) => resolve('Choose a.'));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(5));
    finishes.splice(0).forEach((resolve) => resolve('Choose a.'));
    await Promise.all(workers);
    expect(await admitInboxSummary(runtime, context('a', 5))).toEqual({
      pending: false,
      description: 'Choose a.',
    });
  });

  it('retains source fallback after finite failures instead of restarting on each render', async () => {
    const { runtime } = fixture();
    await admitInboxSummary(runtime, context('a'));
    const generate = vi.fn(async () => undefined);
    await executeInboxSummaries(runtime, generate);
    await executeInboxSummaries(runtime, generate);
    await executeInboxSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(await admitInboxSummary(runtime, context('a'))).toEqual({
      pending: false,
    });
    await executeInboxSummaries(runtime, generate);
    expect(generate).toHaveBeenCalledTimes(3);
  });
});
