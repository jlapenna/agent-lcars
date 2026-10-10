import { describe, expect, it } from 'vitest';

import { type CapacityAuthority, CapacityProtocol } from './capacity';
import {
  type CapacityPoolPolicy,
  type CapacityReceipt,
} from './capacity-model';
import { decidedRun, isRefusal } from './decide';
import { FirestoreStore } from './firestore-store';
import { MemoryStore } from './memory-store';
import { Orchestrator } from './orchestrator';
import type { OrchestratorStore } from './store';

const now = '2026-10-10T04:00:00.000Z';
const recoveryNonce = 'recovery-nonce-123456';
const tokenHash = 'a'.repeat(64);
const authority = (
  poolId = 'pool-a',
  subject = 'executor-a',
): CapacityAuthority => ({
  poolId,
  subject,
  pipelines: ['claude', 'codex', 'opencode'],
  capabilities: new Set(['claim', 'recover', 'operator']),
});
const policy = (poolId = 'pool-a', maxConcurrent = 1): CapacityPoolPolicy => ({
  poolId,
  cluster: 'cluster-a',
  namespace: 'lcars',
  version: 1,
  maxConcurrent,
  maxUnplaced: 1,
  enforced: true,
  inventoryKnown: false,
  domains: {
    claude: { domainId: 'claude-global', ceiling: 128 },
    codex: { domainId: 'codex-global', ceiling: 1 },
    opencode: { domainId: 'local-global', ceiling: 1 },
  },
});
const fence = (receipt: CapacityReceipt) => ({
  poolId: receipt.poolId,
  slot: receipt.slot,
  revision: receipt.revision,
  nonce: receipt.nonce,
  runId: receipt.runId,
});
let counter = 0;

function contract(
  name: string,
  factory: () => OrchestratorStore,
  enabled = true,
) {
  describe.skipIf(!enabled)(`Capacity store contract: ${name}`, () => {
    async function fixture(maxConcurrent = 1) {
      const store = factory();
      const protocol = new CapacityProtocol(store);
      const a = authority();
      await protocol.configure(a, policy(a.poolId, maxConcurrent), now);
      await known(protocol, a);
      await protocol.register(a, 'producer-a', now);
      const orchestrator = new Orchestrator(store, { now: () => now });
      return { store, protocol, a, orchestrator };
    }
    async function known(protocol: CapacityProtocol, a: CapacityAuthority) {
      const input = {
        now,
        receipts: [],
        known: true,
        evidence: 'complete-reviewed-inventory',
        dryRun: true,
      };
      const report = await protocol.importInventory(a, input);
      await protocol.importInventory(a, {
        ...input,
        dryRun: false,
        reviewedDigest: report.digest,
      });
    }
    async function enqueue(
      store: OrchestratorStore,
      orchestrator: Orchestrator,
      pipeline = 'claude',
    ) {
      const result = await orchestrator.request({
        taskId: { repo: 'example/capacity', issue: ++counter },
        requestId: `request-${counter}`,
        pipeline,
        work: { spec: { title: 'Capacity integration contract' } },
      });
      if (isRefusal(result)) throw new Error(result.reason);
      const run = decidedRun(result);
      await store.enqueueRun({ runId: run.runId, now });
      return run;
    }
    const claim = (
      protocol: CapacityProtocol,
      a: CapacityAuthority,
      request = `claim-${++counter}`,
      producerId = 'producer-a',
    ) =>
      protocol.claim(a, {
        version: 1,
        runner: 'runner-a',
        producerId,
        claimRequestId: request,
        nonce: `receipt-nonce-${++counter}`.padEnd(32, 'x'),
        tokenHash,
        now,
      });
    async function claimed(
      protocol: CapacityProtocol,
      a: CapacityAuthority,
      request?: string,
    ) {
      const result = await claim(protocol, a, request);
      if (result.kind !== 'claim')
        throw new Error(`Expected claim, got ${result.kind}`);
      return result;
    }
    async function owner(
      protocol: CapacityProtocol,
      a: CapacityAuthority,
      receipt: CapacityReceipt,
    ) {
      await protocol.recover(a, fence(receipt), {
        nonce: recoveryNonce,
        now,
        expiresAt: '2026-10-10T04:01:00.000Z',
      });
    }
    async function bind(
      protocol: CapacityProtocol,
      a: CapacityAuthority,
      receipt: CapacityReceipt,
    ) {
      await owner(protocol, a, receipt);
      return protocol.bind(a, fence(receipt), {
        recoveryNonce,
        jobUid: 'job-original',
        jobName: receipt.jobName,
        podUid: 'pod-original',
        secretUid: 'secret-original',
        secretTokenHash: tokenHash,
        placed: true,
        deleting: false,
        owned: true,
        now,
      });
    }
    async function activate(
      protocol: CapacityProtocol,
      a: CapacityAuthority,
      receipt: CapacityReceipt,
    ) {
      await bind(protocol, a, receipt);
      await protocol.attest(a, fence(receipt), {
        recoveryNonce,
        jobUid: 'job-original',
        podUid: 'pod-original',
        generation: 1,
        owned: true,
        now,
      });
      return protocol.activate({
        fence: fence(receipt),
        jobUid: 'job-original',
        podUid: 'pod-original',
        tokenHash,
        now,
      });
    }
    const releaseInput = (receipt: CapacityReceipt) => ({
      recoveryNonce,
      barrierUid: 'job-tombstone',
      barrierRunId: receipt.runId,
      barrierNonce: receipt.nonce,
      resourceVersion: 'rv-inert',
      jobName: receipt.jobName,
      evidence: 'exact-readback-and-owned-pods-ended',
      inert: true,
      physicalWorkersEnded: true,
      neverStarted: true,
      originalJobUid: receipt.jobUid,
      now,
    });

    it('N=1 competing transactions commit one run and one receipt', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      await enqueue(store, orchestrator);
      const b = authority('pool-a', 'executor-b');
      await protocol.register(b, 'producer-b', now);
      const result = await Promise.all([
        claim(protocol, a),
        claim(protocol, b, undefined, 'producer-b'),
      ]);
      expect(result.filter((value) => value.kind === 'claim')).toHaveLength(1);
      expect((await protocol.read(now)).receipts).toHaveLength(1);
      expect(await store.listQueuedRuns()).toHaveLength(1);
    });
    it('two pools share a physical provider ceiling, including after logical completion', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      const b = authority('pool-b', 'executor-b');
      await protocol.configure(b, policy('pool-b'), now);
      await known(protocol, b);
      await protocol.register(b, 'producer-b', now);
      await enqueue(store, orchestrator, 'codex');
      await enqueue(store, orchestrator, 'codex');
      const result = await claimed(protocol, a);
      // Equal creation timestamps use deterministic run-ID ordering, not
      // insertion order (for example #100 sorts before #99).
      expect(result.run.pipeline).toBe('codex');
      await orchestrator.report(result.run.runId, { ok: true });
      expect(await claim(protocol, b, undefined, 'producer-b')).toMatchObject({
        kind: 'wait',
      });
      expect((await protocol.read(now)).receipts[0]?.runId).toBe(
        result.run.runId,
      );
    });
    it('response-loss replay cannot mint another token/run and missing Secret is explicit', async () => {
      const { store, protocol, a, orchestrator } = await fixture(2);
      await enqueue(store, orchestrator);
      await enqueue(store, orchestrator);
      const first = await claimed(protocol, a, 'same-request');
      expect(await claim(protocol, a, 'same-request')).toEqual({
        kind: 'quarantined-unrecoverable-token',
        receipt: fence(first.receipt),
        runId: first.run.runId,
        jobName: first.receipt.jobName,
      });
      await expect(claim(protocol, a, 'different-request')).rejects.toThrow(
        'producer',
      );
      await bind(protocol, a, first.receipt);
      const replay = await claim(protocol, a, 'same-request');
      expect(replay).toMatchObject({
        kind: 'recover-owned-secret',
        receipt: { runId: first.run.runId, secretUid: 'secret-original' },
      });
      expect(replay).not.toHaveProperty('token');
      expect((await protocol.read(now)).receipts).toHaveLength(1);
    });
    it('the pool-wide unplaced allowance remains occupied after another producer times out', async () => {
      const { store, protocol, a, orchestrator } = await fixture(2);
      await enqueue(store, orchestrator);
      await enqueue(store, orchestrator);
      const b = authority('pool-a', 'executor-b');
      await protocol.register(b, 'producer-b', now);
      await claimed(protocol, a);
      expect(await claim(protocol, b, undefined, 'producer-b')).toMatchObject({
        kind: 'wait',
        reason: 'capacity',
      });
    });
    it('deferred and cooling runs do not hide another eligible provider', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      const deferred = await enqueue(store, orchestrator, 'claude');
      await orchestrator.cancel(deferred.runId);
      // Another completed run supplies the real cooldown owner.
      const limit = await enqueue(store, orchestrator, 'claude');
      await orchestrator.report(limit.runId, {
        ok: false,
        summary: 'provider-limit',
      });
      await enqueue(store, orchestrator, 'claude');
      const codex = await enqueue(store, orchestrator, 'codex');
      expect((await claimed(protocol, a)).run.runId).toBe(codex.runId);
    });
    it('deferred FIFO head is skipped in the same receipt claim transaction', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      const deferred = await enqueue(store, orchestrator, 'claude');
      await store.transactRun({
        runId: deferred.runId,
        decide: ({ task, run }) => {
          if (task === undefined || run === undefined)
            throw new Error('Missing deferred run');
          return {
            task: task.task,
            run: {
              ...run,
              queue: {
                state: 'queued',
                deferredUntil: '2026-10-10T05:00:00.000Z',
              },
            },
            outbox: [],
          };
        },
      });
      const eligible = await enqueue(store, orchestrator, 'claude');
      expect((await claimed(protocol, a)).run.runId).toBe(eligible.runId);
    });
    it('logical lease loss retains provider and pool occupancy while retry waits', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator, 'codex');
      const first = await claimed(protocol, a);
      await activate(protocol, a, first.receipt);
      const later = '2026-10-10T07:00:00.000Z';
      const sweep = await new Orchestrator(store, {
        now: () => later,
      }).sweepExpired();
      expect(sweep.lost.map((run) => run.runId)).toContain(first.run.runId);
      expect((await protocol.read(later)).receipts[0]?.worker?.active).toBe(
        true,
      );
      const b = authority('pool-b', 'executor-b');
      await protocol.configure(b, policy('pool-b'), later);
      const report = await protocol.importInventory(b, {
        now: later,
        receipts: [],
        known: true,
        evidence: 'complete-pool-b-inventory',
        dryRun: true,
      });
      await protocol.importInventory(b, {
        now: later,
        receipts: [],
        known: true,
        evidence: 'complete-pool-b-inventory',
        dryRun: false,
        reviewedDigest: report.digest,
      });
      await protocol.register(b, 'producer-b', later);
      await enqueue(store, orchestrator, 'codex');
      const result = await protocol.claim(b, {
        version: 1,
        runner: 'runner-b',
        producerId: 'producer-b',
        claimRequestId: 'post-expiry',
        tokenHash,
        nonce: 'post-expiry-receipt-nonce',
        now: later,
      });
      expect(result).toMatchObject({ kind: 'wait' });
    });
    it('one exact attested Pod activates; duplicate Pod/generation/UID cannot acquire the permit', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await bind(protocol, a, receipt);
      const observedJob = {
        recoveryNonce,
        jobUid: 'replacement-job',
        jobName: receipt.jobName,
        placed: false,
        deleting: false,
        owned: true,
        now,
      };
      await expect(
        protocol.bind(a, fence(receipt), observedJob),
      ).rejects.toThrow('physical');
      await expect(
        protocol.bind(
          a,
          { ...fence(receipt), revision: receipt.revision + 1 },
          { ...observedJob, jobUid: 'job-original' },
        ),
      ).rejects.toThrow('stale');
      await expect(
        protocol.activate({
          fence: fence(receipt),
          jobUid: 'job-original',
          podUid: 'forged-pod',
          tokenHash,
          now,
        }),
      ).rejects.toThrow('authority');
      const results = await Promise.allSettled([
        protocol
          .attest(a, fence(receipt), {
            recoveryNonce,
            jobUid: 'job-original',
            podUid: 'pod-original',
            generation: 1,
            owned: true,
            now,
          })
          .then(() =>
            protocol.activate({
              fence: fence(receipt),
              jobUid: 'job-original',
              podUid: 'pod-original',
              tokenHash,
              now,
            }),
          ),
        protocol.activate({
          fence: fence(receipt),
          jobUid: 'job-original',
          podUid: 'duplicate-pod',
          tokenHash,
          now,
        }),
      ]);
      expect(
        results.filter((value) => value.status === 'fulfilled'),
      ).toHaveLength(1);
      await expect(
        protocol.attest(a, fence(receipt), {
          recoveryNonce,
          jobUid: 'job-original',
          podUid: 'duplicate-pod',
          generation: 1,
          owned: true,
          now,
        }),
      ).rejects.toThrow('worker');
      await expect(
        protocol.attest(a, fence(receipt), {
          recoveryNonce,
          jobUid: 'job-replaced',
          podUid: 'pod-original',
          generation: 1,
          owned: true,
          now,
        }),
      ).rejects.toThrow('physical');
    });
    it('expired recovery lease cannot transfer a surviving worker generation', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      expect(await activate(protocol, a, receipt)).toBe(1);
      const later = '2026-10-10T04:02:00.000Z';
      const b = authority('pool-a', 'executor-b');
      await protocol.recover(b, fence(receipt), {
        nonce: 'successor-recovery-nonce',
        now: later,
        expiresAt: '2026-10-10T04:03:00.000Z',
      });
      await expect(
        protocol.attest(b, fence(receipt), {
          recoveryNonce: 'successor-recovery-nonce',
          jobUid: 'job-original',
          podUid: 'successor-pod',
          generation: 2,
          owned: true,
          now: later,
        }),
      ).rejects.toThrow('worker');
    });
    it('worker generation is fenced atomically with heartbeat/completion and retiring blocks old tokens', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await activate(protocol, a, receipt);
      const permit = {
        poolId: a.poolId,
        runId: receipt.runId,
        podUid: 'pod-original',
        generation: 1,
        tokenHash,
      };
      expect(isRefusal(await orchestrator.renew(receipt.runId, permit))).toBe(
        false,
      );
      await expect(
        orchestrator.report(
          receipt.runId,
          { ok: true },
          { ...permit, generation: 2 },
        ),
      ).rejects.toThrow('worker');
      await protocol.retire(a, fence(receipt), { recoveryNonce, now });
      await expect(orchestrator.renew(receipt.runId, permit)).rejects.toThrow(
        'worker',
      );
      expect((await protocol.read(now)).receipts).toHaveLength(1);
    });
    it('positive worker retirement permits a new generation but never reattests an older Pod UID', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await activate(protocol, a, receipt);
      for (const generation of [1, 2]) {
        const priorPod = generation === 1 ? 'pod-original' : 'pod-second';
        await protocol.workerRetired(a, fence(receipt), {
          recoveryNonce,
          generation,
          podUid: priorPod,
          evidence: 'owned-terminal-pod-and-physical-exit-confirmed',
          now,
        });
        const nextPod = generation === 1 ? 'pod-second' : 'pod-third';
        await protocol.attest(a, fence(receipt), {
          recoveryNonce,
          jobUid: 'job-original',
          podUid: nextPod,
          generation: generation + 1,
          owned: true,
          now,
        });
        expect(
          await protocol.activate({
            fence: fence(receipt),
            jobUid: 'job-original',
            podUid: nextPod,
            tokenHash,
            now,
          }),
        ).toBe(generation + 1);
      }
      await protocol.workerRetired(a, fence(receipt), {
        recoveryNonce,
        generation: 3,
        podUid: 'pod-third',
        evidence: 'owned-terminal-pod-and-physical-exit-confirmed',
        now,
      });
      await expect(
        protocol.attest(a, fence(receipt), {
          recoveryNonce,
          jobUid: 'job-original',
          podUid: 'pod-original',
          generation: 4,
          owned: true,
          now,
        }),
      ).rejects.toThrow('worker');
      await expect(
        protocol.activate({
          fence: fence(receipt),
          jobUid: 'job-original',
          podUid: 'pod-third',
          tokenHash,
          now,
        }),
      ).rejects.toThrow('worker');
      expect(
        (await protocol.read(now)).receipts[0]?.retiredWorkers,
      ).toHaveLength(3);
    });
    it('heartbeat racing physical retirement never commits through a retired permit', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await activate(protocol, a, receipt);
      const permit = {
        poolId: a.poolId,
        runId: receipt.runId,
        podUid: 'pod-original',
        generation: 1,
        tokenHash,
      };
      const results = await Promise.allSettled([
        orchestrator.renew(receipt.runId, permit),
        protocol.retire(a, fence(receipt), { recoveryNonce, now }),
      ]);
      expect(results[1]?.status).toBe('fulfilled');
      const heartbeatOutcome = results[0];
      expect(
        heartbeatOutcome?.status === 'fulfilled'
          ? !isRefusal(heartbeatOutcome.value)
          : String(heartbeatOutcome?.reason).includes('worker'),
      ).toBe(true);
      await expect(orchestrator.renew(receipt.runId, permit)).rejects.toThrow(
        'worker',
      );
      expect((await protocol.read(now)).receipts[0]?.state).toBe('retiring');
    });
    it('unknown inventory in an overlapping pool blocks a known pool across a global domain', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator, 'codex');
      await protocol.configure(authority('pool-b'), policy('pool-b'), now);
      expect(await claim(protocol, a)).toMatchObject({ kind: 'wait' });
      expect((await protocol.read(now)).receipts).toHaveLength(0);
      await known(protocol, authority('pool-b'));
      expect((await claimed(protocol, a)).run.pipeline).toBe('codex');
    });
    it('a reviewed migration imports a legacy physical claim conservatively and refuses claimant substitution', async () => {
      const store = factory();
      const orchestrator = new Orchestrator(store, { now: () => now });
      await enqueue(store, orchestrator, 'codex');
      const legacy = await store.claimQueuedRun({
        pipelines: ['codex'],
        now,
        claimedBy: 'legacy-runner',
        claimedBySubject: 'legacy-subject',
        tokenHash,
      });
      if (legacy === undefined) throw new Error('Expected legacy claim');
      const protocol = new CapacityProtocol(store);
      const a = authority();
      await protocol.configure(a, policy(), now);
      expect(
        await store.releaseQueuedRunClaim({
          runId: legacy.runId,
          now,
          claimedBy: 'legacy-runner',
          tokenHash,
        }),
      ).toBe(false);
      expect((await store.readRun(legacy.runId))?.queue?.state).toBe('claimed');
      const observation: CapacityReceipt = {
        poolId: a.poolId,
        slot: 0,
        revision: 1,
        runId: legacy.runId,
        nonce: 'legacy-receipt-nonce-12345',
        domainId: 'codex-global',
        pipeline: 'codex',
        subject: 'legacy-subject',
        runner: 'legacy-runner',
        producerId: 'legacy-producer',
        claimedAt: now,
        tokenHash,
        jobName: 'owned-legacy-job',
        state: 'quarantined',
        unplaced: false,
        producers: [
          {
            producerId: 'legacy-producer',
            subject: 'legacy-subject',
            stopped: false,
            fenced: false,
            pendingWrites: [],
          },
        ],
        retiredWorkers: [],
      };
      const input = {
        now,
        receipts: [observation],
        known: true,
        evidence: 'read-only-owned-job-and-pod-inventory',
        dryRun: true,
      };
      await expect(
        protocol.importInventory(a, {
          ...input,
          receipts: [{ ...observation, subject: 'substituted-subject' }],
        }),
      ).rejects.toThrow('stale');
      const report = await protocol.importInventory(a, input);
      expect((await protocol.read(now)).receipts).toHaveLength(0);
      await protocol.importInventory(a, {
        ...input,
        dryRun: false,
        reviewedDigest: report.digest,
      });
      expect((await protocol.read(now)).receipts[0]).toMatchObject({
        state: 'quarantined',
        runId: legacy.runId,
        subject: 'legacy-subject',
      });
      expect(
        await store.releaseQueuedRunClaim({
          runId: legacy.runId,
          now,
          claimedBy: 'legacy-runner',
          tokenHash,
        }),
      ).toBe(false);
      await protocol.configure(authority('pool-b'), policy('pool-b'), now);
      await known(protocol, authority('pool-b'));
      await protocol.register(authority('pool-b'), 'producer-b', now);
      await enqueue(store, orchestrator, 'codex');
      expect(
        await claim(protocol, authority('pool-b'), undefined, 'producer-b'),
      ).toMatchObject({ kind: 'wait' });
    });
    it('ordinary executor cannot fence another incarnation or quiesce ambiguous writes', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await owner(protocol, a, receipt);
      await protocol.operation(a, fence(receipt), {
        recoveryNonce,
        producerId: 'producer-a',
        operationId: 'ambiguous-create',
        resolved: false,
        now,
      });
      await expect(
        protocol.stopProducer(a, fence(receipt), {
          producerId: 'producer-a',
          producerSubject: a.subject,
          fenced: false,
          evidence: 'timeout',
          now,
        }),
      ).rejects.toThrow('physical');
      await expect(
        protocol.stopProducer(a, fence(receipt), {
          producerId: 'producer-a',
          producerSubject: a.subject,
          fenced: true,
          evidence: 'claimed-dead',
          now,
        }),
      ).rejects.toThrow('authority');
    });
    it('positive fence plus inert barrier releases capacity but retains unknown-write storage debt', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await owner(protocol, a, receipt);
      await protocol.operation(a, fence(receipt), {
        recoveryNonce,
        producerId: 'producer-a',
        operationId: 'ambiguous-create',
        resolved: false,
        now,
      });
      await protocol.retire(a, fence(receipt), { recoveryNonce, now });
      await expect(
        protocol.release(a, fence(receipt), releaseInput(receipt)),
      ).rejects.toThrow('physical');
      const fencer: CapacityAuthority = {
        ...a,
        subject: 'positive-fencing-authority',
        capabilities: new Set(['fence']),
      };
      await protocol.stopProducer(fencer, fence(receipt), {
        producerId: 'producer-a',
        producerSubject: a.subject,
        fenced: true,
        evidence: 'exact-incarnation-terminated-and-restart-prevented',
        now,
      });
      expect(
        await protocol.release(a, fence(receipt), releaseInput(receipt)),
      ).toEqual({ released: true, retainBarrier: true });
      expect((await protocol.read(now)).receipts).toHaveLength(0);
      expect(await protocol.inspectProducer(a, 'producer-a', now)).toEqual({
        poolId: a.poolId,
        subject: a.subject,
        producerId: 'producer-a',
        closed: true,
      });
      expect(
        await protocol.inspectProducer(
          { ...a, subject: 'foreign' },
          'producer-a',
          now,
        ),
      ).toBeNull();
      expect(await protocol.inspectProducer(a, 'unknown', now)).toBeNull();
      await expect(
        protocol.inspectProducer(
          { ...a, capabilities: new Set(['claim']) },
          'producer-a',
          now,
        ),
      ).rejects.toThrow('authority');

      expect(
        await protocol.inspectRetired(a, receipt.runId, now),
      ).toMatchObject({
        runId: receipt.runId,
        nonce: receipt.nonce,
        jobName: receipt.jobName,
        released: true,
        retainBarrier: true,
        barrier: { uid: 'job-tombstone' },
      });
      await expect(
        protocol.inspectRetired(
          { ...a, capabilities: new Set(['claim']) },
          receipt.runId,
          now,
        ),
      ).rejects.toThrow('authority');
      await expect(protocol.register(a, 'producer-a', now)).rejects.toThrow(
        'producer',
      );
      await expect(
        protocol.activate({
          fence: fence(receipt),
          podUid: 'late-pod',
          jobUid: 'late-job',
          tokenHash,
          now,
        }),
      ).rejects.toThrow();
      expect(
        await protocol.retiredWriteResolved(a, {
          runId: receipt.runId,
          nonce: receipt.nonce,
          barrierUid: 'job-tombstone',
          operationId: 'ambiguous-create',
          evidence: 'definitive-already-exists-response',
          producerId: 'producer-a',
          producerSubject: a.subject,
          now,
        }),
      ).toEqual({ retainBarrier: false });
    });
    it('retired response debt distinguishes the same operation ID from different immutable producers', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await owner(protocol, a, receipt);
      for (const producerId of ['producer-a', 'producer-successor']) {
        if (producerId !== 'producer-a') {
          await protocol.register(a, producerId, now);
          await protocol.authorizeProducer(a, fence(receipt), {
            producerId,
            recoveryNonce,
            now,
          });
        }
        await protocol.operation(a, fence(receipt), {
          recoveryNonce,
          producerId,
          operationId: 'same-rpc-id',
          resolved: false,
          now,
        });
      }
      await protocol.retire(a, fence(receipt), { recoveryNonce, now });
      const fencer: CapacityAuthority = {
        ...a,
        subject: 'inventory-fencer',
        capabilities: new Set(['fence']),
      };
      for (const producerId of ['producer-a', 'producer-successor']) {
        await protocol.stopProducer(fencer, fence(receipt), {
          producerId,
          producerSubject: a.subject,
          fenced: true,
          evidence: 'exact-incarnation-stopped-and-unable-to-restart',
          now,
        });
      }
      expect(
        await protocol.release(a, fence(receipt), releaseInput(receipt)),
      ).toEqual({ released: true, retainBarrier: true });
      const resolution = {
        runId: receipt.runId,
        nonce: receipt.nonce,
        barrierUid: 'job-tombstone',
        operationId: 'same-rpc-id',
        producerSubject: a.subject,
        evidence: 'definitive-response-observed',
        now,
      };
      expect(
        await protocol.retiredWriteResolved(a, {
          ...resolution,
          producerId: 'producer-a',
        }),
      ).toEqual({ retainBarrier: true });
      expect(
        await protocol.retiredWriteResolved(a, {
          ...resolution,
          producerId: 'producer-a',
        }),
      ).toEqual({ retainBarrier: true });
      expect(
        await protocol.retiredWriteResolved(a, {
          ...resolution,
          producerId: 'producer-successor',
        }),
      ).toEqual({ retainBarrier: false });
    });
    it('stale release cannot free a newer slot, and physical proof frees the domain once', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator, 'codex');
      const { receipt } = await claimed(protocol, a);
      await owner(protocol, a, receipt);
      await protocol.stopProducer(a, fence(receipt), {
        producerId: 'producer-a',
        producerSubject: a.subject,
        fenced: false,
        evidence: 'all-operations-definitive',
        now,
      });
      await protocol.retire(a, fence(receipt), { recoveryNonce, now });
      await orchestrator.report(receipt.runId, { ok: true });
      await expect(
        protocol.release(a, fence(receipt), {
          ...releaseInput(receipt),
          barrierNonce: 'different-receipt-nonce',
        }),
      ).rejects.toThrow('physical');
      await expect(
        protocol.release(a, fence(receipt), {
          ...releaseInput(receipt),
          physicalWorkersEnded: false,
        }),
      ).rejects.toThrow('physical');
      expect((await protocol.read(now)).receipts).toHaveLength(1);
      expect(
        await protocol.release(a, fence(receipt), releaseInput(receipt)),
      ).toMatchObject({ released: true });
      await protocol.register(a, 'producer-new', now);
      await enqueue(store, orchestrator, 'codex');
      const next = await claim(protocol, a, 'new-request', 'producer-new');
      expect(next.kind).toBe('claim');
      await expect(
        protocol.release(a, fence(receipt), releaseInput(receipt)),
      ).rejects.toThrow('stale');
      expect((await protocol.read(now)).receipts).toHaveLength(1);
    });
    it('migration starts unknown, dry-run never writes, stale review refuses, legacy claims cannot bypass', async () => {
      const store = factory();
      const protocol = new CapacityProtocol(store);
      const a = authority();
      await protocol.configure(a, { ...policy(), inventoryKnown: true }, now);
      expect((await protocol.read(now)).policies[0]?.inventoryKnown).toBe(
        false,
      );
      await protocol.register(a, 'producer-a', now);
      await expect(
        protocol.configure(
          a,
          { ...policy(), version: 2, enforced: false },
          now,
        ),
      ).rejects.toThrow('physical');
      await expect(claim(protocol, a)).rejects.toThrow('inventory');
      await expect(
        store.claimQueuedRun({
          pipelines: ['claude'],
          now,
          claimedBy: 'legacy',
          tokenHash,
        }),
      ).rejects.toThrow('policy');
      const before = await protocol.read(now);
      const input = {
        now,
        receipts: [],
        known: true,
        evidence: 'reviewed-empty-inventory',
        dryRun: true,
      };
      const report = await protocol.importInventory(a, input);
      expect(await protocol.read(now)).toEqual(before);
      await expect(
        protocol.importInventory(a, {
          ...input,
          dryRun: false,
          reviewedDigest: 'wrong',
        }),
      ).rejects.toThrow('stale');
      expect(await protocol.read(now)).toEqual(before);
      await protocol.importInventory(a, {
        ...input,
        dryRun: false,
        reviewedDigest: report.digest,
      });
      expect((await protocol.read(now)).policies[0]?.inventoryKnown).toBe(true);
    });
    it('expanding managed pipelines invalidates reviewed inventory around a legacy physical claim', async () => {
      const store = factory();
      const protocol = new CapacityProtocol(store);
      const a = authority();
      const narrow = {
        ...policy(),
        domains: { codex: { domainId: 'codex-global', ceiling: 1 } },
      };
      await protocol.configure(a, narrow, now);
      await known(protocol, a);
      const orchestrator = new Orchestrator(store, { now: () => now });
      const legacy = await enqueue(store, orchestrator, 'claude');
      expect(
        await store.claimQueuedRun({
          pipelines: ['claude'],
          now,
          claimedBy: 'legacy-runner',
          tokenHash,
        }),
      ).toMatchObject({ runId: legacy.runId });
      await enqueue(store, orchestrator, 'claude');
      await protocol.configure(
        a,
        { ...policy(), version: 2, inventoryKnown: true },
        now,
      );
      expect((await protocol.read(now)).policies[0]?.inventoryKnown).toBe(
        false,
      );
      await protocol.register(a, 'producer-a', now);
      const request = {
        version: 2,
        runner: 'runner-a',
        producerId: 'producer-a',
        claimRequestId: 'expanded-policy-claim',
        nonce: 'expanded-policy-nonce',
        tokenHash,
        now,
      };
      await expect(protocol.claim(a, request)).rejects.toThrow('inventory');
      const input = {
        now,
        dryRun: true,
        known: true,
        evidence: 'incomplete-expanded-inventory',
        receipts: [],
      };
      const report = await protocol.importInventory(a, input);
      expect(report).toMatchObject({
        inventoryKnown: false,
        missingRunIds: [legacy.runId],
      });
      await protocol.importInventory(a, {
        ...input,
        dryRun: false,
        reviewedDigest: report.digest,
      });
      await expect(protocol.claim(a, request)).rejects.toThrow('inventory');
      expect((await protocol.read(now)).receipts).toHaveLength(0);
      expect((await store.readRun(legacy.runId))?.queue?.state).toBe('claimed');
    });
    it('domain changes and re-enforcement require new inventory review while limit-only changes preserve it', async () => {
      const store = factory();
      const protocol = new CapacityProtocol(store);
      const a = authority();
      await protocol.configure(a, policy(), now);
      await known(protocol, a);
      await protocol.configure(a, { ...policy('pool-a', 2), version: 2 }, now);
      expect((await protocol.read(now)).policies[0]?.inventoryKnown).toBe(true);
      await protocol.configure(
        a,
        {
          ...policy(),
          version: 3,
          domains: {
            ...policy().domains,
            claude: { domainId: 'different-credential-domain', ceiling: 128 },
          },
        },
        now,
      );
      expect((await protocol.read(now)).policies[0]?.inventoryKnown).toBe(
        false,
      );
      await known(protocol, a);
      const renamed = (await protocol.read(now)).policies[0];
      if (renamed === undefined) throw new Error('Expected configured policy');
      await protocol.configure(
        a,
        { ...renamed, version: 4, enforced: false },
        now,
      );
      expect((await protocol.read(now)).policies[0]?.inventoryKnown).toBe(
        false,
      );
      await known(protocol, a);
      expect((await protocol.read(now)).policies[0]?.inventoryKnown).toBe(true);
      await protocol.configure(
        a,
        { ...renamed, version: 5, enforced: true },
        now,
      );
      expect((await protocol.read(now)).policies[0]?.inventoryKnown).toBe(
        false,
      );
    });
    it('unknown migration in another shared-domain pool blocks admission; downward policy drains without freeing', async () => {
      const { store, protocol, a, orchestrator } = await fixture(2);
      await enqueue(store, orchestrator);
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await bind(protocol, a, receipt);
      await claimed(protocol, a);
      await protocol.configure(a, { ...policy('pool-a', 1), version: 2 }, now);
      expect((await protocol.read(now)).receipts).toHaveLength(2);
      await expect(claim(protocol, a)).rejects.toThrow('policy');
      await protocol.configure(authority('pool-b'), policy('pool-b'), now);
      const b = authority('pool-b');
      await protocol.register(b, 'producer-b', now);
      await expect(claim(protocol, b, undefined, 'producer-b')).rejects.toThrow(
        'inventory',
      );
    });
  });
}
contract('capacity MemoryStore', () => new MemoryStore());
const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
if (
  process.env['REQUIRE_FIRESTORE_EMULATOR'] === '1' &&
  emulatorHost === undefined
)
  throw new Error('Capacity races require Firestore emulator');
contract(
  'capacity FirestoreStore emulator',
  () =>
    new FirestoreStore({
      projectId: 'demo-capacity-2311',
      databaseId: '(default)',
      collectionPrefix: `capacity-2311-${Date.now()}-${++counter}-`,
      emulatorHost,
    }),
  emulatorHost !== undefined,
);
