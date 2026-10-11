import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { reserveCredentialOperation } from './credential-operation';
import { decidedRun, isRefusal } from './decide';
import { FirestoreStore } from './firestore-store';
import { MemoryStore } from './memory-store';
import { Orchestrator } from './orchestrator';
import type { OrchestratorStore } from './store';

const NOW = '2026-10-10T02:00:00.000Z';
const HASH = 'a'.repeat(64);
const RESULT = {
  ok: false,
  summary: 'provider-limit',
  message: 'accepted once',
};
const TASK = { repo: 'octo/example', issue: 2405 };
const host = process.env['FIRESTORE_EMULATOR_HOST'];
if (process.env['REQUIRE_FIRESTORE_EMULATOR'] === '1' && host === undefined)
  throw new Error('Credential fallback requires a connected emulator');

for (const backend of ['MemoryStore', 'FirestoreStore'] as const) {
  describe.skipIf(backend === 'FirestoreStore' && host === undefined)(
    `${backend}: claimed credential fallback composition`,
    () => {
      async function fixture(authority = true, optIn = true) {
        const store: OrchestratorStore =
          backend === 'MemoryStore'
            ? new MemoryStore()
            : new FirestoreStore({
                projectId: 'demo-orchestrator',
                databaseId: '(default)',
                collectionPrefix: `credential-fallback-${crypto.randomUUID()}-`,
                emulatorHost: host!,
              });
        let instant = NOW;
        let grants = ['codex', 'claude', 'opencode'];
        const orchestrator = new Orchestrator(
          store,
          { now: () => instant },
          authority
            ? {
                pipelines: ['codex', 'claude', 'opencode'],
                allowedPipelines: () => grants,
              }
            : undefined,
        );
        const admitted = await orchestrator.request({
          taskId: TASK,
          requestId: 'original',
          pipeline: 'codex',
          work: { spec: { title: 'Preserve accepted credential result' } },
          ...(optIn
            ? {
                providerFallback: {
                  principal: 'user:operator',
                  allowedPipelines: ['claude', 'opencode'],
                },
              }
            : {}),
        });
        if (isRefusal(admitted)) throw new Error(admitted.reason);
        const runId = decidedRun(admitted).runId;
        await store.enqueueRun({ runId, now: NOW });
        expect(
          await store.claimQueuedRun({
            pipelines: ['codex'],
            now: NOW,
            claimedBy: 'exact-worker',
            tokenHash: HASH,
          }),
        ).toMatchObject({ runId });
        return {
          store,
          orchestrator,
          runId,
          now: () => instant,
          advance() {
            instant = '2026-10-10T04:00:00.000Z';
          },
          revoke() {
            grants = ['codex'];
          },
          async defer() {
            const reserved = await store.transactRun({
              runId,
              decide: ({ task, run }) => {
                if (task === undefined || run === undefined)
                  throw new Error('Missing exact claimed fixture');
                return reserveCredentialOperation({
                  now: instant,
                  task: task.task,
                  run,
                  id: 'reserved-operation',
                  kind: 'persist',
                  claimFingerprint: HASH,
                });
              },
            });
            expect(isRefusal(reserved)).toBe(false);
            const pending = await orchestrator.report(runId, RESULT, HASH);
            expect(isRefusal(pending)).toBe(false);
            expect(
              (await store.readRun(runId))?.credentialPendingResult,
            ).toEqual({
              claimFingerprint: HASH,
              requestedAt: NOW,
              result: RESULT,
            });
          },
          finish(
            operationId = 'reserved-operation',
            fingerprint = HASH,
            sequence = 0,
          ) {
            return orchestrator.finishCredentialOperation({
              runId,
              operationId,
              claimFingerprint: fingerprint,
              leaseRetiredAtSequence: sequence,
              now: () => instant,
            });
          },
        };
      }

      it('direct settlement reserves exact cleanup with original outcome and one fresh dispatch', async () => {
        const f = await fixture();
        const result = await f.orchestrator.report(f.runId, RESULT, HASH);
        expect(isRefusal(result)).toBe(false);
        if (isRefusal(result)) throw new Error(result.reason);
        expect(result.run).toMatchObject({
          runId: f.runId,
          state: 'finished',
          result: RESULT,
          credentialOperation: { kind: 'cleanup', claimFingerprint: HASH },
        });
        expect(result.additionalRuns).toHaveLength(1);
        expect(result.additionalRuns?.[0]).toMatchObject({
          pipeline: 'claude',
        });
        expect(
          result.outbox.filter((entry) => entry.kind === 'dispatch-run'),
        ).toHaveLength(1);
        const op = result.run?.credentialOperation;
        expect(op).toBeDefined();
        expect(await f.finish(op!.id, HASH, 1)).toMatchObject({
          refused: true,
          reason: 'credential-operation-pending',
        });
        expect(isRefusal(await f.finish(op!.id))).toBe(false);
        expect(
          (await f.store.readRun(f.runId))?.credentialOperation,
        ).toBeUndefined();
      });

      it('deferred settlement after deadline keeps accepted result and current authorized successor', async () => {
        const f = await fixture();
        await f.defer();
        f.advance();
        const result = await f.finish();
        expect(isRefusal(result)).toBe(false);
        if (isRefusal(result)) throw new Error(result.reason);
        expect(result.run).toMatchObject({ state: 'finished', result: RESULT });
        expect(result.run?.credentialPendingResult).toBeUndefined();
        expect(result.additionalRuns).toHaveLength(1);
        expect(result.additionalRuns?.[0]).toMatchObject({
          pipeline: 'claude',
        });
        expect(
          result.outbox.filter((entry) => entry.kind === 'report-outcome'),
        ).toHaveLength(1);
        expect(
          result.outbox.filter((entry) => entry.kind === 'dispatch-run'),
        ).toHaveLength(1);
        expect(await f.finish()).toMatchObject({
          refused: true,
          reason: 'not-claimant',
        });
      });

      it.each(['no-authority', 'no-opt-in', 'revoked-grant'] as const)(
        'deferred %s preserves the accepted result without a successor',
        async (mode) => {
          const f = await fixture(
            mode !== 'no-authority',
            mode !== 'no-opt-in',
          );
          await f.defer();
          if (mode === 'revoked-grant') f.revoke();
          const result = await f.finish();
          expect(isRefusal(result)).toBe(false);
          if (isRefusal(result)) throw new Error(result.reason);
          expect(result.run).toMatchObject({
            state: 'finished',
            result: RESULT,
          });
          expect(result.additionalRuns).toBeUndefined();
          expect(
            result.outbox.filter((entry) => entry.kind === 'dispatch-run'),
          ).toHaveLength(0);
        },
      );

      it('exact operation/hash/sequence and changed result refuse without changing accepted state', async () => {
        const f = await fixture();
        await f.defer();
        const pending = await f.store.readRun(f.runId);
        for (const outcome of [
          await f.finish('different-operation'),
          await f.finish('reserved-operation', 'b'.repeat(64)),
          await f.finish('reserved-operation', HASH, 1),
          await f.orchestrator.report(
            f.runId,
            { ...RESULT, message: 'changed' },
            HASH,
          ),
        ])
          expect(isRefusal(outcome)).toBe(true);
        expect(await f.store.readRun(f.runId)).toEqual(pending);
      });

      it('deadline changed before transaction callback refuses a direct report', async () => {
        const f = await fixture();
        const transact = f.store.transactRun.bind(f.store);
        f.store.transactRun = (input) =>
          transact({
            ...input,
            decide: (state) => {
              f.advance();
              return input.decide(state);
            },
          });
        expect(
          await f.orchestrator.report(f.runId, RESULT, HASH),
        ).toMatchObject({
          refused: true,
          reason: 'stale-lease',
        });
        expect(
          (await f.store.readRun(f.runId))?.credentialOperation,
        ).toBeUndefined();
        expect((await f.store.readRun(f.runId))?.state).not.toBe('finished');
      });

      it('competing finishes commit exactly one successor and one dispatch', async () => {
        const f = await fixture();
        await f.defer();
        const results = await Promise.all([f.finish(), f.finish()]);
        expect(results.filter((result) => !isRefusal(result))).toHaveLength(1);
        const entries = await f.store.claimPendingOutbox({
          limit: 20,
          now: NOW,
          leaseExpiresAt: '2026-10-10T03:00:00.000Z',
        });
        expect(
          entries.filter((entry) => entry.kind === 'report-outcome'),
        ).toHaveLength(1);
        // One original admission dispatch plus exactly one fresh fallback dispatch.
        expect(
          entries.filter((entry) => entry.kind === 'dispatch-run'),
        ).toHaveLength(2);
        expect((await f.store.readActiveRun(TASK))?.pipeline).toBe('claude');
      });
    },
  );
}
