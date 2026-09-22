// Consume the exact native -> baked runner completion payload through the
// production route and outbox. Memory persistence and GitHub HTTP are local.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { deriveItemState } from '@agent-lcars/work/derive';
import { expect, it } from 'vitest';

import { drainOutbox } from '../../apps/console/src/lib/orchestrator-dispatch';
import {
  hashRunToken,
  mintRunToken,
} from '../../apps/console/src/lib/run-token';
import { createRunsHandler } from '../../apps/console/src/lib/runs-router';

const paths: string[] = JSON.parse(
  process.env.LCARS_NATIVE_FAILURE_REPORTS ?? '[]',
);
if (paths.length !== 3)
  throw new Error('Qualification requires one image-bound report per provider');
const reports = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
const sha = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const root = resolve(import.meta.dirname, '../..');

it('settles exact native failure payloads without human assignment or PARK', async () => {
  expect(new Set(reports.map((report) => report.provider))).toEqual(
    new Set(['claude', 'codex', 'opencode']),
  );
  expect(new Set(reports.map((report) => report.imageId)).size).toBe(1);
  for (const report of reports) {
    expect(report.passed).toBe(true);
    expect(report.jobUid).toBe(1001);
    expect(report.runnerHash).toBe(
      sha(
        resolve(root, 'apps/runner-autoscaler/runner-image/direct-runner.sh'),
      ),
    );
    for (const [name, hash] of Object.entries(report.moduleHashes))
      expect(hash).toBe(sha(resolve(root, 'packages/fleet-tools/bin', name)));
    for (const [name, hash] of Object.entries(report.runtimeHashes))
      expect(hash).toBe(
        sha(resolve(root, 'apps/runner-autoscaler/runner-image/runtime', name)),
      );
    const observation = report.nativeReport.observations.find(
      (entry: { mode: string }) =>
        entry.mode === 'bootstrap-workflow-recovery-exhausted',
    );
    expect(observation.observedExpectedPrimitive).toBe(true);
    expect(observation.workflow.finalization.passed).toBe(true);
    expect(observation.workflow.finalization.requests).toHaveLength(1);
    const payload = observation.workflow.finalization.requests[0].body;
    expect(payload.outcome).toBe('worker-control-failed');

    const instant = new Date().toISOString();
    const store = new MemoryStore();
    const orchestrator = new Orchestrator(store, { now: () => instant });
    const taskId = { repo: 'octo/example', issue: 42 };
    const requested = await orchestrator.request({
      taskId,
      requestId: `native-failure-${report.provider}`,
      pipeline: report.provider,
      params: { mode: 'implement' },
      work: {
        origin: { principal: 'github:fixture', channel: 'github' },
        spec: {
          title: 'Native recovery exhaustion qualification',
          description: 'Local-only evidence',
          pipeline: report.provider,
          target: { repo: taskId.repo },
        },
      },
    });
    if ('refused' in requested || !requested.run)
      throw new Error('Fixture admission failed');
    const runId = requested.run.runId;
    expect(runId).toBe('octo/example#42/r1');
    await store.enqueueRun({ runId, now: instant });
    await orchestrator.confirmDispatch(runId);
    const token = mintRunToken();
    await store.claimQueuedRun({
      pipelines: [report.provider],
      now: instant,
      claimedBy: 'local-qualification',
      tokenHash: hashRunToken(token),
    });
    const calls: { url: string; body: string }[] = [];
    const releasedLeases: string[] = [];
    const tokens = { tokenFor: async () => 'local-fixture-only' };
    const drain = () =>
      drainOutbox({
        store,
        orchestrator,
        tokens,
        now: () => instant,
        fetchImpl: (async (input, init) => {
          calls.push({ url: String(input), body: String(init?.body ?? '') });
          return new Response(null, { status: 201 });
        }) as typeof fetch,
      });
    const handler = createRunsHandler();
    const { response } = await handler.handle(
      new Request(
        `https://lcars.test/api/work/v1/runs/${encodeURIComponent(runId)}/complete`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      ),
      {
        prefix: '/api/work/v1',
        context: {
          store,
          orchestrator,
          now: () => new Date(instant),
          tokens,
          codexAuth: {
            read: async () => {
              throw new Error(
                'Credential reads are outside this qualification',
              );
            },
            readLease: async () => undefined,
            createLease: async () => undefined,
            takeLease: async () => undefined,
            replace: async () => {
              throw new Error(
                'Credential writes are outside this qualification',
              );
            },
            releaseLease: async (id) => {
              releasedLeases.push(id);
            },
          },
          checkoutTokens: {
            tokenFor: async () => 'local-checkout-only',
            expiringTokenFor: async () => ({
              token: 'local-checkout-only',
              expiresAt: instant,
            }),
            expiringTokenForRepositories: async () => ({
              token: 'local-checkout-only',
              expiresAt: instant,
            }),
          },
          bearerToken: token,
          drain,
        },
      },
    );
    expect(response?.status, await response?.text()).toBe(200);
    expect(releasedLeases).toEqual(report.provider === 'codex' ? [runId] : []);
    expect(await store.readRun(runId)).toMatchObject({
      state: 'finished',
      result: { ok: false, summary: 'worker-control-failed' },
    });
    const task = await store.readTask(taskId);
    expect(task).toBeDefined();
    if (!task) throw new Error('Settled task missing');
    expect(deriveItemState(task.task, await store.listRuns(taskId))).toBe(
      'failed',
    );
    expect(calls.some((call) => call.url.endsWith('/issues/42/comments'))).toBe(
      true,
    );
    expect(
      calls.some(
        (call) =>
          call.url.includes('/assignees') ||
          call.body.includes('status:needs-human'),
      ),
    ).toBe(false);
  }
});
