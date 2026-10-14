import { describe, expect, it } from 'vitest';

import { type CapacityAuthority, CapacityProtocol } from './capacity';
import {
  type CapacityPoolPolicy,
  type CapacityReceipt,
  CapacityRefusal,
} from './capacity-model';
import {
  changeCredentialOperation,
  reserveCredentialOperation,
} from './credential-operation';
import { decidedRun, isRefusal, runStartDeadlineAt } from './decide';
import { FirestoreStore } from './firestore-store';
import { MemoryStore } from './memory-store';
import type { QueuePriority } from './model';
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
    it('refuses conflicting ceilings within one policy without replacing it', async () => {
      const store = factory();
      const protocol = new CapacityProtocol(store);
      const a = authority();
      await protocol.configure(a, policy(), now);
      const before = await protocol.read(now);
      await expect(
        protocol.configure(
          a,
          {
            ...policy(),
            version: 2,
            domains: {
              codex: { domainId: 'shared', ceiling: 1 },
              claude: { domainId: 'shared', ceiling: 128 },
            },
          },
          now,
        ),
      ).rejects.toThrow('policy');
      expect(await protocol.read(now)).toEqual(before);
      await expect(
        protocol.configure(
          a,
          {
            ...policy(),
            version: 2,
            domains: {
              codex: { domainId: 'shared', ceiling: 1 },
              claude: { domainId: 'shared', ceiling: 1 },
            },
          },
          now,
        ),
      ).resolves.toMatchObject({ version: 2 });
    });
    it('persists optional retirement fields with the same omission semantics', async () => {
      const store = factory();
      const record = {
        kind: 'retired' as const,
        runId: 'optional-retirement',
        poolId: 'optional-pool',
        nonce: 'optional-nonce-123456',
        jobName: 'optional-job',
        barrier: undefined,
        pendingWrites: [],
        released: false,
      };
      await store.transactCapacity({
        now,
        recordKeys: ['optional-retirement'],
        decide: () => ({
          value: undefined,
          records: new Map([['optional-retirement', record]]),
        }),
      });
      await store.transactCapacity({
        now,
        recordKeys: ['optional-retirement'],
        decide: ({ records }) => {
          expect(records.get('optional-retirement')).toEqual(record);
          expect(records.get('optional-retirement')).not.toHaveProperty(
            'barrier',
          );
          return { value: undefined };
        },
      });
    });
    async function fixture(maxConcurrent = 1) {
      const store = factory();
      const protocol = new CapacityProtocol(store);
      const a = authority();
      await protocol.configure(a, policy(a.poolId, maxConcurrent), now);
      await known(protocol, a);
      await protocol.register(a, 'producer-a', now);
      let instant = now;
      const orchestrator = new Orchestrator(store, { now: () => instant });
      return {
        store,
        protocol,
        a,
        orchestrator,
        setNow: (value: string) => {
          instant = value;
        },
      };
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
      priority: QueuePriority = 'normal',
    ) {
      const result = await orchestrator.request({
        taskId: { repo: 'example/capacity', issue: ++counter },
        requestId: `request-${counter}`,
        pipeline,
        priority,
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
    it('persists weighted priority turns across protocol instances without consuming a turn on waits or receipt replay', async () => {
      const { store, protocol, a, orchestrator, setNow } = await fixture(8);
      const runs = [];
      for (const [index, priority] of (
        [
          'background',
          'normal',
          'urgent',
          'urgent',
          'urgent',
          'urgent',
          'normal',
        ] as const
      ).entries()) {
        setNow(new Date(Date.parse(now) - 60_000 + index * 1000).toISOString());
        runs.push(await enqueue(store, orchestrator, 'claude', priority));
      }
      await protocol.register(a, 'producer-wait', now);
      const first = await claimed(protocol, a, 'priority-first');
      expect(first.run.runId).toBe(runs[2]?.runId);
      // The unplaced receipt blocks a fresh request; neither wait nor replay
      // may spend the second urgent turn.
      expect(await claim(protocol, a, 'waiting', 'producer-wait')).toEqual({
        kind: 'wait',
        reason: 'capacity',
      });
      await bind(protocol, a, first.receipt);
      expect(await claim(protocol, a, 'priority-first')).toMatchObject({
        kind: 'recover-owned-secret',
        receipt: { runId: first.run.runId },
      });
      const restarted = new CapacityProtocol(store);
      const second = await claimed(restarted, a);
      expect(second.run.runId).toBe(runs[3]?.runId);
      await bind(protocol, a, second.receipt);
      const third = await claimed(protocol, a);
      expect(third.run.runId).toBe(runs[1]?.runId);
      await bind(protocol, a, third.receipt);
      const fourth = await claimed(protocol, a);
      expect(fourth.run.runId).toBe(runs[4]?.runId);
      await bind(protocol, a, fourth.receipt);
      const fifth = await claimed(protocol, a);
      expect(fifth.run.runId).toBe(runs[5]?.runId);
      await bind(protocol, a, fifth.receipt);
      const sixth = await claimed(protocol, a);
      expect(sixth.run.runId).toBe(runs[6]?.runId);
      await bind(protocol, a, sixth.receipt);
      const seventh = await claimed(protocol, a);
      expect(seventh.run.runId).toBe(runs[0]?.runId);
    });

    it('keeps physical provider fairness and domain ceilings ahead of priority class selection', async () => {
      const { store, protocol, a, orchestrator, setNow } = await fixture(4);
      const enqueueAt = async (
        offset: number,
        pipeline: string,
        priority: QueuePriority,
      ) => {
        setNow(
          new Date(Date.parse(now) - 60_000 + offset * 1000).toISOString(),
        );
        return enqueue(store, orchestrator, pipeline, priority);
      };
      const background = await enqueueAt(0, 'claude', 'background');
      const codexNormal = await enqueueAt(1, 'codex', 'normal');
      const claudeUrgent = await enqueueAt(2, 'claude', 'urgent');
      const codexUrgent = await enqueueAt(3, 'codex', 'urgent');
      const first = await claimed(protocol, a);
      expect(first.run.runId).toBe(claudeUrgent.runId);
      await bind(protocol, a, first.receipt);
      const second = await claimed(protocol, a);
      expect(second.run.runId).toBe(codexUrgent.runId);
      await bind(protocol, a, second.receipt);
      const third = await claimed(protocol, a);
      expect(third.run.runId).toBe(background.runId);
      await bind(protocol, a, third.receipt);
      expect(await claim(protocol, a)).toEqual({
        kind: 'wait',
        reason: 'queue',
      });
      expect((await store.readRun(codexNormal.runId))?.queue?.state).toBe(
        'queued',
      );
    });

    it('preserves the capacity FIFO run-ID tie-break for normal work', async () => {
      const { store, protocol, a, orchestrator } = await fixture(2);
      const runs = [];
      for (const repo of ['example/a-a', 'example/a_a']) {
        const result = await orchestrator.request({
          taskId: { repo, issue: 1 },
          requestId: `fifo-${repo}`,
          pipeline: 'claude',
          work: { spec: { title: 'Capacity FIFO tie regression' } },
        });
        if (isRefusal(result)) throw new Error(result.reason);
        const run = decidedRun(result);
        await store.enqueueRun({ runId: run.runId, now });
        runs.push(run);
      }
      const first = await claimed(protocol, a);
      expect(first.run.runId).toBe(runs[1]?.runId);
      await bind(protocol, a, first.receipt);
      expect((await claimed(protocol, a)).run.runId).toBe(runs[0]?.runId);
    });

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

    it('fences placement observations against the original receipt Job and committed retirement', async () => {
      const { store, protocol, a, orchestrator, setNow } = await fixture();
      await enqueue(store, orchestrator);
      const result = await protocol.claim(a, {
        version: 1,
        runner: 'runner-a',
        producerId: 'producer-a',
        claimRequestId: 'placement-aware',
        nonce: 'placement-nonce-1234567890',
        tokenHash,
        now,
        placementAware: true,
      });
      if (result.kind !== 'claim') throw new Error('expected claim');
      const { receipt } = result;
      await bind(protocol, a, receipt);
      setNow('2026-10-10T04:00:30.000Z');
      const claimant = {
        runner: 'runner-a',
        subject: a.subject,
        claimFingerprint: tokenHash,
      };
      const observation = {
        jobUid: 'job-original',
        observedAt: '2026-10-10T04:00:30.000Z',
        placed: false,
        poolId: a.poolId,
      };
      const before = await store.readRun(receipt.runId);
      await expect(
        orchestrator.observeStartupPlacement(receipt.runId, claimant, {
          ...observation,
          jobUid: 'replacement-job',
        }),
      ).rejects.toThrow('authority');
      expect(await store.readRun(receipt.runId)).toEqual(before);
      expect(
        isRefusal(
          await orchestrator.observeStartupPlacement(
            receipt.runId,
            claimant,
            observation,
          ),
        ),
      ).toBe(false);
      const updated = await store.readRun(receipt.runId);
      await protocol.retire(a, fence(receipt), {
        recoveryNonce,
        now: observation.observedAt,
      });
      setNow('2026-10-10T04:00:40.000Z');
      await expect(
        orchestrator.observeStartupPlacement(receipt.runId, claimant, {
          ...observation,
          observedAt: '2026-10-10T04:00:40.000Z',
        }),
      ).rejects.toThrow('retired');
      expect(await store.readRun(receipt.runId)).toEqual(updated);
    });

    it('capacity startup deadline survives response loss and expires with one retained physical receipt', async () => {
      const { store, protocol, a, orchestrator, setNow } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt, run } = await claimed(protocol, a, 'startup-replay');
      expect(run.queue?.startDeadlineAt).toBe(runStartDeadlineAt(now));
      await bind(protocol, a, receipt);
      const before = await store.readRun(receipt.runId);
      expect(
        await protocol.claim(a, {
          version: 1,
          runner: 'runner-a',
          producerId: 'producer-a',
          claimRequestId: 'startup-replay',
          nonce: 'changed-replay-nonce-123456',
          tokenHash,
          now: '2026-10-10T04:00:30.000Z',
        }),
      ).toMatchObject({ kind: 'recover-owned-secret' });
      expect(await store.readRun(receipt.runId)).toEqual(before);
      setNow(runStartDeadlineAt(now));
      expect(
        await orchestrator.renew(receipt.runId, tokenHash, true),
      ).toMatchObject({ reason: 'stale-lease' });
      expect(
        await orchestrator.report(receipt.runId, { ok: true }, tokenHash),
      ).toMatchObject({ reason: 'stale-lease' });
      const sweeps = await Promise.all([
        orchestrator.sweepExpired(),
        orchestrator.sweepExpired(),
      ]);
      expect(
        sweeps.flatMap((value) => value.lost).map((value) => value.runId),
      ).toEqual([receipt.runId]);
      const retries = sweeps.flatMap((value) => value.retried);
      expect(retries).toHaveLength(1);
      expect(retries[0]?.newRunId).toBe(receipt.runId.replace(/\/r1$/u, '/r2'));
      expect((await store.readRun(receipt.runId))?.state).toBe('lost');
      expect((await protocol.read(now)).receipts).toHaveLength(1);
      expect(await orchestrator.sweepExpired()).toEqual({
        lost: [],
        retried: [],
      });
      expect(await claim(protocol, a)).toMatchObject({
        kind: 'wait',
        reason: 'capacity',
      });
    });

    it('timely capacity first heartbeat permits callbacks past the original startup deadline', async () => {
      const { store, protocol, a, orchestrator, setNow } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      setNow('2026-10-10T04:14:59.000Z');
      expect(
        isRefusal(await orchestrator.renew(receipt.runId, tokenHash, true)),
      ).toBe(false);
      expect((await store.readRun(receipt.runId))?.queue).toMatchObject({
        startDeadlineAt: runStartDeadlineAt(now),
        firstHeartbeatAt: '2026-10-10T04:14:59.000Z',
        providerProcessStartedAt: '2026-10-10T04:14:59.000Z',
      });
      setNow('2026-10-10T04:16:00.000Z');
      expect(await orchestrator.sweepExpired()).toEqual({
        lost: [],
        retried: [],
      });
      expect(
        isRefusal(
          await orchestrator.report(receipt.runId, { ok: true }, tokenHash),
        ),
      ).toBe(false);
      expect((await protocol.read(now)).receipts).toHaveLength(1);
    });

    it('startup deadline refuses late activation and recovery while retaining physical occupancy', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a, 'late-activation');
      await bind(protocol, a, receipt);
      await protocol.attest(a, fence(receipt), {
        recoveryNonce,
        jobUid: 'job-original',
        podUid: 'pod-original',
        generation: 1,
        owned: true,
        now,
      });
      const before = await store.readRun(receipt.runId);
      await expect(
        protocol.activate({
          fence: fence(receipt),
          jobUid: 'job-original',
          podUid: 'pod-original',
          tokenHash,
          now: runStartDeadlineAt(now),
        }),
      ).rejects.toThrow('retired');
      expect(await store.readRun(receipt.runId)).toEqual(before);
      expect((await protocol.read(now)).receipts[0]?.worker).toBeUndefined();
      expect(
        await protocol.claim(a, {
          version: 1,
          runner: 'runner-a',
          producerId: 'producer-a',
          claimRequestId: 'late-activation',
          nonce: 'late-replay-nonce-123456',
          tokenHash,
          now: runStartDeadlineAt(now),
        }),
      ).toMatchObject({ kind: 'quarantined-unrecoverable-token' });
      expect((await protocol.read(now)).receipts).toHaveLength(1);
      expect(await store.readRun(receipt.runId)).toEqual(before);
    });

    it('timely heartbeat retains activation and recovery eligibility after the startup deadline', async () => {
      const { protocol, a, orchestrator, store, setNow } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a, 'timely-activation');
      await activate(protocol, a, receipt);
      setNow('2026-10-10T04:14:59.000Z');
      expect(
        isRefusal(await orchestrator.renew(receipt.runId, tokenHash, true)),
      ).toBe(false);
      expect(
        await protocol.activate({
          fence: fence(receipt),
          jobUid: 'job-original',
          podUid: 'pod-original',
          tokenHash,
          now: runStartDeadlineAt(now),
        }),
      ).toBe(1);
      expect(
        await protocol.claim(a, {
          version: 1,
          runner: 'runner-a',
          producerId: 'producer-a',
          claimRequestId: 'timely-activation',
          nonce: 'timely-replay-nonce-123456',
          tokenHash,
          now: runStartDeadlineAt(now),
        }),
      ).toMatchObject({ kind: 'recover-owned-secret' });
    });

    it('startup expiry refuses an already active generation replay without retiring its physical worker', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await activate(protocol, a, receipt);
      const before = await store.readRun(receipt.runId);
      await expect(
        protocol.activate({
          fence: fence(receipt),
          jobUid: 'job-original',
          podUid: 'pod-original',
          tokenHash,
          now: runStartDeadlineAt(now),
        }),
      ).rejects.toThrow('retired');
      expect(await store.readRun(receipt.runId)).toEqual(before);
      expect((await protocol.read(now)).receipts).toHaveLength(1);
      expect((await protocol.read(now)).receipts[0]?.worker?.active).toBe(true);
    });

    it('legacy claims without startup deadline retain execution-lease activation and recovery', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a, 'legacy-deadline');
      await activate(protocol, a, receipt);
      await store.transactRun({
        runId: receipt.runId,
        decide: ({ task, run }) => {
          if (task === undefined || run?.queue === undefined)
            throw new Error('missing legacy claim');
          const { startDeadlineAt: _deadline, ...queue } = run.queue;
          return { task: task.task, run: { ...run, queue }, outbox: [] };
        },
      });
      const before = await store.readRun(receipt.runId);
      expect(before?.queue?.startDeadlineAt).toBeUndefined();
      expect(
        await protocol.activate({
          fence: fence(receipt),
          jobUid: 'job-original',
          podUid: 'pod-original',
          tokenHash,
          now: '2026-10-10T04:16:00.000Z',
        }),
      ).toBe(1);
      expect(
        await protocol.claim(a, {
          version: 1,
          runner: 'runner-a',
          producerId: 'producer-a',
          claimRequestId: 'legacy-deadline',
          nonce: 'legacy-replay-nonce-123456',
          tokenHash,
          now: '2026-10-10T04:16:00.000Z',
        }),
      ).toMatchObject({ kind: 'recover-owned-secret' });
      expect(await store.readRun(receipt.runId)).toEqual(before);
    });

    async function credentialFixture() {
      const f = await fixture();
      await enqueue(f.store, f.orchestrator, 'codex');
      const { receipt } = await claimed(f.protocol, f.a);
      await activate(f.protocol, f.a, receipt);
      const permit = {
        poolId: f.a.poolId,
        runId: receipt.runId,
        podUid: 'pod-original',
        generation: 1,
        tokenHash,
      };
      const change = (
        action: Parameters<typeof changeCredentialOperation>[0]['change'],
        id = 'operation',
        fingerprint = tokenHash,
      ) =>
        f.store.transactRun({
          runId: receipt.runId,
          decide: ({ task, run }) => {
            if (task === undefined || run === undefined)
              throw new Error('missing credential claim');
            return changeCredentialOperation({
              now,
              task: task.task,
              run,
              id,
              claimFingerprint: fingerprint,
              change: action,
            });
          },
        });
      const reserve = () =>
        f.store.transactRun({
          runId: receipt.runId,
          workerPermit: permit,
          decide: ({ task, run }) => {
            if (task === undefined || run === undefined)
              throw new Error('missing credential claim');
            return reserveCredentialOperation({
              now,
              task: task.task,
              run,
              id: 'operation',
              kind: 'persist',
              claimFingerprint: tokenHash,
            });
          },
        });
      const retire = async () => {
        await f.protocol.retire(f.a, fence(receipt), { recoveryNonce, now });
        await f.protocol.workerRetired(f.a, fence(receipt), {
          recoveryNonce,
          generation: 1,
          podUid: 'pod-original',
          evidence: 'exact-owned-worker-physically-ended',
          now,
        });
        await f.protocol.stopProducer(f.a, fence(receipt), {
          producerId: 'producer-a',
          producerSubject: f.a.subject,
          fenced: false,
          evidence: 'all-rpcs-definitively-resolved',
          now,
        });
      };
      const release = () =>
        f.protocol.release(f.a, fence(receipt), {
          ...releaseInput(receipt),
          neverStarted: false,
          originalJobUid: 'job-original',
        });
      return { ...f, receipt, permit, change, reserve, retire, release };
    }

    function fulfilled<T>(outcome: PromiseSettledResult<T> | undefined): T {
      if (outcome?.status !== 'fulfilled')
        throw new Error('expected fulfilled transaction');
      return outcome.value;
    }
    async function resolvedRelease<T>(
      outcome: PromiseSettledResult<T> | undefined,
      retry: () => Promise<T>,
    ): Promise<T> {
      if (outcome === undefined) throw new Error('missing release outcome');
      if (outcome.status === 'fulfilled') return outcome.value;
      if (
        !(outcome.reason instanceof CapacityRefusal) ||
        outcome.reason.reason !== 'physical'
      )
        throw outcome.reason;
      return retry();
    }
    it('credential reservation versus final release: reservation-first', async () => {
      const f = await credentialFixture();
      expect(isRefusal(await f.reserve())).toBe(false);
      const before = await f.store.readRun(f.receipt.runId);
      await f.retire();
      await expect(f.release()).rejects.toThrow('physical');
      expect(await f.store.readRun(f.receipt.runId)).toEqual(before);
      expect((await f.protocol.read(now)).receipts).toHaveLength(1);
    });
    it('credential reservation versus final release: release-first', async () => {
      const f = await credentialFixture();
      await f.retire();
      expect(await f.release()).toMatchObject({ released: true });
      const before = await f.store.readRun(f.receipt.runId);
      await expect(f.reserve()).rejects.toThrow('worker');
      expect(await f.store.readRun(f.receipt.runId)).toEqual(before);
    });

    it('unknown prepared CAS and pending completion retain occupancy until exact checked recovery', async () => {
      const f = await credentialFixture();
      await f.reserve();
      const mutation = {
        kind: 'auth-write' as const,
        id: 'operation:1',
        expectedGeneration: '7',
        sha256: 'b'.repeat(64),
      };
      expect(isRefusal(await f.change({ kind: 'prepare', mutation }))).toBe(
        false,
      );
      expect(
        isRefusal(
          await f.orchestrator.report(f.receipt.runId, { ok: true }, tokenHash),
        ),
      ).toBe(false);
      await f.retire();
      const before = await f.store.readRun(f.receipt.runId);
      expect(before?.credentialPendingResult?.result).toEqual({ ok: true });
      expect(
        await f.change({ kind: 'retry-recovery' }, 'wrong-operation'),
      ).toMatchObject({ reason: 'not-claimant' });
      expect(
        await f.change(
          { kind: 'acknowledge', mutationId: mutation.id },
          'operation',
          'c'.repeat(64),
        ),
      ).toMatchObject({ reason: 'not-claimant' });
      expect(
        await f.change({ kind: 'finish', leaseRetiredAtSequence: 1 }),
      ).toMatchObject({ reason: 'credential-operation-pending' });
      await expect(f.release()).rejects.toThrow('physical');
      expect(await f.store.readRun(f.receipt.runId)).toEqual(before);
      expect(isRefusal(await f.change({ kind: 'retry-recovery' }))).toBe(false);
      expect(
        isRefusal(
          await f.change({ kind: 'acknowledge', mutationId: mutation.id }),
        ),
      ).toBe(false);
      expect(
        await f.change({ kind: 'finish', leaseRetiredAtSequence: 0 }),
      ).toMatchObject({ reason: 'credential-operation-pending' });
      const races = await Promise.allSettled([
        f.change({ kind: 'finish', leaseRetiredAtSequence: 1 }),
        f.release(),
      ]);
      expect(isRefusal(fulfilled(races[0]))).toBe(false);
      expect((await f.store.readRun(f.receipt.runId))?.state).toBe('finished');
      expect(await resolvedRelease(races[1], f.release)).toMatchObject({
        released: true,
      });
      expect((await f.protocol.read(now)).receipts).toHaveLength(0);
      expect(await f.change({ kind: 'prepare', mutation })).toMatchObject({
        reason: 'not-claimant',
      });
    });

    it('cleanup preparation invalidates captured proof and survives competing release until checked finish', async () => {
      const f = await credentialFixture();
      expect(
        isRefusal(
          await f.orchestrator.report(f.receipt.runId, { ok: true }, tokenHash),
        ),
      ).toBe(false);
      const operation = (await f.store.readRun(f.receipt.runId))
        ?.credentialOperation;
      if (operation === undefined) throw new Error('missing terminal cleanup');
      const mutation = {
        kind: 'lease-write' as const,
        id: `${operation.id}:1`,
        expectedGeneration: '7',
        repository: 'example/capacity',
        expiresAt: now,
      };
      await f.change({ kind: 'prepare', mutation }, operation.id);
      await f.retire();
      const before = await f.store.readRun(f.receipt.runId);
      expect(
        await f.change(
          { kind: 'finish', leaseRetiredAtSequence: 0 },
          operation.id,
        ),
      ).toMatchObject({ reason: 'credential-operation-pending' });
      await expect(f.release()).rejects.toThrow('physical');
      expect(await f.store.readRun(f.receipt.runId)).toEqual(before);
      await f.change(
        { kind: 'acknowledge', mutationId: mutation.id },
        operation.id,
      );
      expect(
        await f.change(
          { kind: 'finish', leaseRetiredAtSequence: 0 },
          operation.id,
        ),
      ).toMatchObject({ reason: 'credential-operation-pending' });
      const races = await Promise.allSettled([
        f.release(),
        f.change({ kind: 'finish', leaseRetiredAtSequence: 1 }, operation.id),
      ]);
      expect(isRefusal(fulfilled(races[1]))).toBe(false);
      expect(await resolvedRelease(races[0], f.release)).toMatchObject({
        released: true,
      });
      expect((await f.protocol.read(now)).receipts).toHaveLength(0);
      expect(
        await f.change({ kind: 'retry-recovery' }, operation.id),
      ).toMatchObject({ reason: 'not-claimant' });
    });

    it('retried terminal callback keeps one cleanup identity and the current callback clock', async () => {
      const f = await credentialFixture();
      const transact = f.store.transactRun.bind(f.store);
      const ids: (string | undefined)[] = [];
      f.store.transactRun = (input) =>
        transact({
          ...input,
          decide: (snapshot) => {
            const discarded = input.decide(snapshot);
            if (isRefusal(discarded)) throw new Error(discarded.reason);
            ids.push(discarded.run?.credentialOperation?.id);
            f.setNow('2026-10-10T04:00:01.000Z');
            const committed = input.decide(snapshot);
            if (isRefusal(committed)) throw new Error(committed.reason);
            ids.push(committed.run?.credentialOperation?.id);
            return committed;
          },
        });
      const result = await f.orchestrator.report(
        f.receipt.runId,
        { ok: true },
        tokenHash,
      );
      expect(isRefusal(result)).toBe(false);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(ids[0]).toBeDefined();
      expect(new Set(ids).size).toBe(1);
      expect(
        (await f.store.readRun(f.receipt.runId))?.credentialOperation
          ?.startedAt,
      ).toBe('2026-10-10T04:00:01.000Z');
      if (isRefusal(result)) throw new Error(result.reason);
      expect(result.run?.updatedAt).toBe('2026-10-10T04:00:01.000Z');
      expect(
        result.outbox.filter((entry) => entry.kind === 'report-outcome'),
      ).toHaveLength(1);
    });

    it('physical release retains exact claimant exit for a live non-Codex run', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await owner(protocol, a, receipt);
      await protocol.retire(a, fence(receipt), { recoveryNonce, now });
      await protocol.stopProducer(a, fence(receipt), {
        producerId: 'producer-a',
        producerSubject: a.subject,
        fenced: false,
        evidence: 'all-owned-rpcs-definitively-resolved',
        now,
      });
      expect(
        await protocol.release(a, fence(receipt), releaseInput(receipt)),
      ).toMatchObject({ released: true });
      const exit = await orchestrator.executorExited(receipt.runId, {
        subject: a.subject,
        runner: 'runner-a',
        claimFingerprint: tokenHash,
      });
      expect(isRefusal(exit)).toBe(false);
      expect((await store.readRun(receipt.runId))?.state).toBe('lost');
      expect((await protocol.read(now)).receipts).toHaveLength(0);
    });

    it('restored live Codex release refuses until exact exit and checked cleanup finish', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator, 'codex');
      const { receipt } = await claimed(protocol, a);
      await store.transactRun({
        runId: receipt.runId,
        decide: ({ task, run }) => {
          if (task === undefined || run === undefined)
            throw new Error('missing claim');
          return {
            task: task.task,
            run: { ...run, credentialRestoredClaimFingerprint: tokenHash },
            outbox: [],
          };
        },
      });
      await owner(protocol, a, receipt);
      await protocol.retire(a, fence(receipt), { recoveryNonce, now });
      await protocol.stopProducer(a, fence(receipt), {
        producerId: 'producer-a',
        producerSubject: a.subject,
        fenced: false,
        evidence: 'all-owned-rpcs-definitively-resolved',
        now,
      });
      await expect(
        protocol.release(a, fence(receipt), releaseInput(receipt)),
      ).rejects.toThrow('physical');
      expect((await store.readRun(receipt.runId))?.queue?.state).toBe(
        'claimed',
      );
      expect(
        isRefusal(
          await orchestrator.executorExited(receipt.runId, {
            subject: a.subject,
            runner: 'runner-a',
            claimFingerprint: tokenHash,
          }),
        ),
      ).toBe(false);
      const terminal = await store.readRun(receipt.runId);
      const cleanup = terminal?.credentialOperation;
      expect(cleanup?.kind).toBe('cleanup');
      if (cleanup === undefined) throw new Error('missing cleanup authority');
      await expect(
        protocol.release(a, fence(receipt), releaseInput(receipt)),
      ).rejects.toThrow('physical');
      expect(
        isRefusal(
          await orchestrator.finishCredentialOperation({
            runId: receipt.runId,
            operationId: cleanup.id,
            claimFingerprint: tokenHash,
            leaseRetiredAtSequence: cleanup.mutationSequence,
            now: () => now,
          }),
        ),
      ).toBe(false);
      expect(
        await protocol.release(a, fence(receipt), releaseInput(receipt)),
      ).toMatchObject({ released: true });
      expect((await store.readRun(receipt.runId))?.queue?.state).toBe(
        'retired',
      );
      expect((await protocol.read(now)).receipts).toHaveLength(0);
      const repeatExit = await orchestrator.executorExited(receipt.runId, {
        subject: a.subject,
        runner: 'runner-a',
        claimFingerprint: tokenHash,
      });
      expect(repeatExit).toMatchObject({
        refused: true,
        reason: 'run-not-live',
      });
      const changedClaimant = await orchestrator.executorExited(receipt.runId, {
        subject: 'another-executor',
        runner: 'runner-a',
        claimFingerprint: tokenHash,
      });
      expect(changedClaimant).toMatchObject({
        refused: true,
        reason: 'not-claimant',
      });
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
    it('settles the explicit tied issue IDs 99 and 100 by run-ID order', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      const b = authority('pool-b', 'executor-b');
      await protocol.configure(b, policy('pool-b'), now);
      await known(protocol, b);
      await protocol.register(b, 'producer-b', now);
      const enqueueIssue = async (issue: number) => {
        const result = await orchestrator.request({
          taskId: { repo: 'example/capacity', issue },
          requestId: `tied-boundary-${issue}`,
          pipeline: 'codex',
          work: { spec: { title: 'Tied numeric boundary contract' } },
        });
        if (isRefusal(result)) throw new Error(result.reason);
        const run = decidedRun(result);
        await store.enqueueRun({ runId: run.runId, now });
        return run;
      };
      // #99 is requested first on purpose: insertion order and numeric order
      // both name it, so only the run-ID tie-break can settle #100. These
      // issues are literal, so the shared counter cannot move the boundary.
      const insertedFirst = await enqueueIssue(99);
      const insertedSecond = await enqueueIssue(100);
      expect(insertedFirst.createdAt).toBe(insertedSecond.createdAt);
      expect(insertedFirst.runId).toBe('example/capacity#99/r1');
      expect(insertedSecond.runId).toBe('example/capacity#100/r1');
      const settled = await claimed(protocol, a);
      expect(settled.run.runId).toBe(insertedSecond.runId);
      // Negative control: the retired insertion-order assumption settles #99,
      // which is the lexically larger run ID at a tied timestamp, so it cannot
      // pass this boundary by coincidence with the run-ID tie-break.
      expect(
        [insertedFirst.runId, insertedSecond.runId].sort((left, right) =>
          left.localeCompare(right),
        ),
      ).toEqual([insertedSecond.runId, insertedFirst.runId]);
      expect(settled.run.runId).not.toBe(insertedFirst.runId);
      await orchestrator.report(settled.run.runId, { ok: true });
      expect((await store.readRun(settled.run.runId))?.state).toBe('finished');
      expect(await claim(protocol, b, undefined, 'producer-b')).toMatchObject({
        kind: 'wait',
        reason: 'queue',
      });
      const receipts = (await protocol.read(now)).receipts;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        runId: settled.run.runId,
        domainId: 'codex-global',
      });
      expect((await store.readRun(insertedFirst.runId))?.queue?.state).toBe(
        'queued',
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
    it('pending attestation retains occupancy and grants no permit until the exact Pod is attested', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await bind(protocol, a, receipt);
      const input = {
        fence: fence(receipt),
        jobUid: 'job-original',
        podUid: 'pod-original',
        tokenHash,
        now,
      };
      const before = await protocol.read(now);
      await expect(protocol.activate(input)).rejects.toThrow('worker');
      await expect(
        protocol.activate({ ...input, tokenHash: '0'.repeat(64) }),
      ).rejects.toThrow('authority');
      await expect(
        protocol.activate({ ...input, jobUid: 'foreign-job' }),
      ).rejects.toThrow('authority');
      expect(await protocol.read(now)).toEqual(before);
      expect(before.receipts[0]?.worker).toBeUndefined();
      expect(await activate(protocol, a, receipt)).toBe(1);
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
      ).rejects.toThrow('worker');
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
      expect(
        isRefusal(
          await orchestrator.renew(receipt.runId, tokenHash, undefined, permit),
        ),
      ).toBe(false);
      await expect(
        orchestrator.report(receipt.runId, { ok: true }, tokenHash, undefined, {
          ...permit,
          generation: 2,
        }),
      ).rejects.toThrow('worker');
      await protocol.retire(a, fence(receipt), { recoveryNonce, now });
      await expect(
        orchestrator.renew(receipt.runId, tokenHash, undefined, permit),
      ).rejects.toThrow('worker');
      expect((await protocol.read(now)).receipts).toHaveLength(1);
    });
    it('a valid active worker permit cannot authorize another Run transaction', async () => {
      const { store, protocol, a, orchestrator } = await fixture(2);
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await activate(protocol, a, receipt);
      const other = await enqueue(store, orchestrator);
      const before = await store.readRun(other.runId);
      let decided = false;
      await expect(
        store.transactRun({
          runId: other.runId,
          workerPermit: {
            poolId: a.poolId,
            runId: receipt.runId,
            podUid: 'pod-original',
            generation: 1,
            tokenHash,
          },
          decide: () => {
            decided = true;
            return { refused: true, reason: 'unknown-run' };
          },
        }),
      ).rejects.toThrow('worker');
      expect(decided).toBe(false);
      expect(await store.readRun(other.runId)).toEqual(before);
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
        orchestrator.renew(receipt.runId, tokenHash, undefined, permit),
        protocol.retire(a, fence(receipt), { recoveryNonce, now }),
      ]);
      expect(results[1]?.status).toBe('fulfilled');
      const heartbeatOutcome = results[0];
      expect(
        heartbeatOutcome?.status === 'fulfilled'
          ? !isRefusal(heartbeatOutcome.value)
          : String(heartbeatOutcome?.reason).includes('worker'),
      ).toBe(true);
      await expect(
        orchestrator.renew(receipt.runId, tokenHash, undefined, permit),
      ).rejects.toThrow('worker');
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
      await expect(
        protocol.importInventory(a, {
          ...input,
          receipts: [{ ...observation, taskKey: 'example/other#123' }],
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
    it('producer bounds refuse new identities while preserving full-set replay', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await owner(protocol, a, receipt);
      for (let index = 1; index <= 8; index++) {
        const producerId = `producer-${index}`;
        await protocol.register(a, producerId, now);
        if (index < 8)
          await protocol.authorizeProducer(a, fence(receipt), {
            producerId,
            recoveryNonce,
            now,
          });
      }
      const before = await protocol.read(now);
      await expect(
        protocol.authorizeProducer(a, fence(receipt), {
          producerId: 'producer-8',
          recoveryNonce,
          now,
        }),
      ).rejects.toThrow('Capacity protocol refused: bounds');
      expect(await protocol.read(now)).toEqual(before);
      await protocol.authorizeProducer(a, fence(receipt), {
        producerId: 'producer-7',
        recoveryNonce,
        now,
      });
      expect((await protocol.read(now)).receipts).toEqual(before.receipts);
    });
    it('pending-write bounds preserve replay and recover space after a definitive outcome', async () => {
      const { store, protocol, a, orchestrator } = await fixture();
      await enqueue(store, orchestrator);
      const { receipt } = await claimed(protocol, a);
      await owner(protocol, a, receipt);
      const operation = (operationId: string, resolved = false) =>
        protocol.operation(a, fence(receipt), {
          producerId: 'producer-a',
          operationId,
          resolved,
          recoveryNonce,
          now,
        });
      for (let index = 0; index < 32; index++)
        await operation(`write-${index}`);
      const before = await protocol.read(now);
      await expect(operation('write-32')).rejects.toThrow(
        'Capacity protocol refused: bounds',
      );
      expect(await protocol.read(now)).toEqual(before);
      await operation('write-31');
      expect((await protocol.read(now)).receipts).toEqual(before.receipts);
      await operation('write-0', true);
      await operation('write-32');
      const pending = (await protocol.read(now)).receipts[0]?.producers[0]
        ?.pendingWrites;
      expect(pending).toHaveLength(32);
      expect(pending).not.toContain('write-0');
      expect(pending).toContain('write-32');
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
      expect(
        isRefusal(
          await orchestrator.report(receipt.runId, { ok: true }, tokenHash),
        ),
      ).toBe(false);
      const cleanup = (await store.readRun(receipt.runId))?.credentialOperation;
      if (cleanup === undefined) throw new Error('missing terminal cleanup');
      expect(
        isRefusal(
          await orchestrator.finishCredentialOperation({
            runId: receipt.runId,
            operationId: cleanup.id,
            claimFingerprint: tokenHash,
            leaseRetiredAtSequence: cleanup.mutationSequence,
            now: () => now,
          }),
        ),
      ).toBe(false);
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
