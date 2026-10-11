import { describe, expect, it } from 'vitest';

import { type CapacityAuthority, CapacityProtocol } from './capacity';
import {
  assertCapacityWorkerPermit,
  type CapacityPoolPolicy,
  type CapacityReceipt,
  retiredKey,
} from './capacity-model';
import { decidedRun, isRefusal } from './decide';
import { FirestoreStore } from './firestore-store';
import { MemoryStore } from './memory-store';
import { Orchestrator } from './orchestrator';
import type { OrchestratorStore } from './store';

const START = '2026-10-10T04:00:00.000Z',
  LATER = '2026-10-10T07:00:00.000Z';
const A: CapacityAuthority = {
  poolId: 'pool-two',
  subject: 'executor-original',
  pipelines: ['claude', 'codex', 'opencode'],
  capabilities: new Set(['claim', 'recover', 'operator']),
};
const B: CapacityAuthority = { ...A, subject: 'executor-successor' };
const POLICY: CapacityPoolPolicy = {
  poolId: A.poolId,
  cluster: 'cluster-a',
  namespace: 'lcars',
  version: 1,
  maxConcurrent: 2,
  maxUnplaced: 1,
  enforced: true,
  inventoryKnown: false,
  domains: {
    claude: { domainId: 'claude-roomy', ceiling: 128 },
    codex: { domainId: 'codex-domain', ceiling: 1 },
    opencode: { domainId: 'opencode-domain', ceiling: 1 },
  },
};
const HASH_A = 'a'.repeat(64),
  HASH_B = 'b'.repeat(64);
const F = (r: CapacityReceipt) => ({
  poolId: r.poolId,
  slot: r.slot,
  revision: r.revision,
  nonce: r.nonce,
  runId: r.runId,
});
async function claim(
  protocol: CapacityProtocol,
  a: CapacityAuthority,
  producerId: string,
  request: string,
  time: string,
  hash: string,
) {
  return protocol.claim(a, {
    version: 1,
    runner: producerId,
    producerId,
    claimRequestId: request,
    nonce: `nonce-${request}-unique-12345678`,
    tokenHash: hash,
    now: time,
  });
}
async function activate(
  protocol: CapacityProtocol,
  a: CapacityAuthority,
  r: CapacityReceipt,
  tag: string,
  time: string,
  hash: string,
) {
  const nonce = `recovery-${tag}-123456789`;
  await protocol.recover(a, F(r), {
    nonce,
    now: time,
    expiresAt: new Date(Date.parse(time) + 60000).toISOString(),
  });
  await protocol.bind(a, F(r), {
    recoveryNonce: nonce,
    jobUid: `job-${tag}`,
    jobName: r.jobName,
    podUid: `pod-${tag}`,
    secretUid: `secret-${tag}`,
    secretTokenHash: hash,
    placed: true,
    deleting: false,
    owned: true,
    now: time,
  });
  await protocol.attest(a, F(r), {
    recoveryNonce: nonce,
    jobUid: `job-${tag}`,
    podUid: `pod-${tag}`,
    generation: 1,
    owned: true,
    now: time,
  });
  expect(
    await protocol.activate({
      fence: F(r),
      podUid: `pod-${tag}`,
      jobUid: `job-${tag}`,
      tokenHash: hash,
      now: time,
    }),
  ).toBe(1);
}
async function fixture(factory: () => OrchestratorStore) {
  const store = factory(),
    protocol = new CapacityProtocol(store),
    orchestrator = new Orchestrator(store, { now: () => START });
  await protocol.configure(A, POLICY, START);
  const inventory = {
    now: START,
    receipts: [],
    known: true,
    evidence: 'reviewed-no-legacy-inventory',
    dryRun: true,
  };
  const report = await protocol.importInventory(A, inventory);
  await protocol.importInventory(A, {
    ...inventory,
    dryRun: false,
    reviewedDigest: report.digest,
  });
  await protocol.register(A, 'producer-original', START);
  await protocol.register(B, 'producer-successor', START);
  const requested = await orchestrator.request({
    taskId: { repo: 'example/lineage', issue: 2313 },
    requestId: 'original-request',
    pipeline: 'claude',
    work: { spec: { title: 'Same task lineage' } },
  });
  if (isRefusal(requested)) throw new Error(requested.reason);
  const original = decidedRun(requested);
  await store.enqueueRun({ runId: original.runId, now: START });
  const first = await claim(
    protocol,
    A,
    'producer-original',
    'first',
    START,
    HASH_A,
  );
  if (first.kind !== 'claim') throw new Error('original failed to claim');
  await activate(protocol, A, first.receipt, 'original', START, HASH_A);
  return { store, protocol, orchestrator, original, first };
}
async function retry(
  f: Awaited<ReturnType<typeof fixture>>,
  crossProvider = false,
) {
  const later = new Orchestrator(f.store, { now: () => LATER });
  const sweep = await later.sweepExpired();
  expect(sweep.lost.map((r) => r.runId)).toContain(f.original.runId);
  expect(sweep.retried).toHaveLength(1);
  const r2 = await f.store.readActiveRun(f.original.task);
  if (!r2) throw new Error('retry missing');
  await f.store.enqueueRun({ runId: r2.runId, now: LATER });
  if (!crossProvider) return r2;
  const switched = await later.request({
    taskId: f.original.task,
    requestId: 'explicit-cross-provider-retry',
    pipeline: 'codex',
    replaceQueuedRunId: r2.runId,
  });
  if (isRefusal(switched)) throw new Error(switched.reason);
  const r3 = decidedRun(switched);
  await f.store.enqueueRun({ runId: r3.runId, now: LATER });
  return r3;
}
function contract(
  name: string,
  factory: () => OrchestratorStore,
  enabled = true,
) {
  describe.skipIf(!enabled)(`Task lineage receipt retirement: ${name}`, () => {
    it.each([false, true])(
      'must refuse a successor with free second slot before predecessor retirement (crossProvider=%s)',
      async (crossProvider) => {
        const f = await fixture(factory);
        const successor = await retry(f, crossProvider);
        const prior = await f.protocol.read(LATER);
        expect(prior.receipts).toHaveLength(1);
        expect(prior.receipts[0]?.worker?.active).toBe(true);
        expect(prior.receipts[0]?.unplaced).toBe(false);
        const records = await f.store.transactCapacity({
          now: LATER,
          runId: f.original.runId,
          recordKeys: [retiredKey(f.original.runId)],
          decide: (s) => ({
            value: s.records.get(retiredKey(f.original.runId)),
          }),
        });
        expect(records).toBeUndefined();
        const oldPermit = {
          poolId: A.poolId,
          runId: f.original.runId,
          podUid: 'pod-original',
          generation: 1,
          tokenHash: HASH_A,
        };
        assertCapacityWorkerPermit(prior, records, oldPermit);
        const result = await claim(
          f.protocol,
          B,
          'producer-successor',
          'second',
          LATER,
          HASH_B,
        );
        if (result.kind === 'claim')
          await activate(
            f.protocol,
            B,
            result.receipt,
            'successor',
            LATER,
            HASH_B,
          );
        expect(result.kind).toBe('wait');
        expect((await f.store.readRun(successor.runId))?.queue?.state).toBe(
          'queued',
        );
      },
    );
    it('admits an unrelated task in the free second Claude slot as the roomy-capacity control', async () => {
      const f = await fixture(factory);
      const other = await f.orchestrator.request({
        taskId: { repo: 'example/lineage', issue: 999 },
        requestId: 'other',
        pipeline: 'claude',
        work: { spec: { title: 'Unrelated task' } },
      });
      if (isRefusal(other)) throw new Error(other.reason);
      const run = decidedRun(other);
      await f.store.enqueueRun({ runId: run.runId, now: START });
      const second = await claim(
        f.protocol,
        B,
        'producer-successor',
        'independent',
        START,
        HASH_B,
      );
      expect(second.kind).toBe('claim');
      if (second.kind === 'claim')
        await activate(
          f.protocol,
          B,
          second.receipt,
          'independent',
          START,
          HASH_B,
        );
      expect(
        (await f.protocol.read(START)).receipts.filter((r) => r.worker?.active),
      ).toHaveLength(2);
    });
    it('retains task lineage across pools with unrelated spare capacity', async () => {
      const f = await fixture(factory);
      await retry(f, true);
      const c = { ...B, poolId: 'other-pool' };
      await f.protocol.configure(c, { ...POLICY, poolId: c.poolId }, LATER);
      const inventory = {
        now: LATER,
        receipts: [],
        known: true,
        evidence: 'complete-other-pool',
        dryRun: true,
      };
      const dry = await f.protocol.importInventory(c, inventory);
      await f.protocol.importInventory(c, {
        ...inventory,
        dryRun: false,
        reviewedDigest: dry.digest,
      });
      await f.protocol.register(c, 'producer-other-pool', LATER);
      expect(
        (
          await claim(
            f.protocol,
            c,
            'producer-other-pool',
            'other-pool-retry',
            LATER,
            HASH_B,
          )
        ).kind,
      ).toBe('wait');
      const other = await new Orchestrator(f.store, {
        now: () => LATER,
      }).request({
        taskId: { repo: 'example/lineage', issue: 998 },
        requestId: 'unrelated-other-pool',
        pipeline: 'claude',
        work: { spec: { title: 'Unrelated other pool' } },
      });
      if (isRefusal(other)) throw new Error(other.reason);
      const run = decidedRun(other);
      await f.store.enqueueRun({ runId: run.runId, now: LATER });
      const admitted = await claim(
        f.protocol,
        c,
        'producer-other-pool',
        'other-pool-unrelated',
        LATER,
        HASH_B,
      );
      expect(admitted.kind).toBe('claim');
      if (admitted.kind !== 'claim')
        throw new Error('Expected unrelated claim');
      expect(admitted.run.runId).toBe(run.runId);
    });
    it('recovers historical receipt identity from a canonical Run outside the queue queries', async () => {
      const f = await fixture(factory);
      const successor = await retry(f);
      await f.store.transactRun({
        runId: f.original.runId,
        decide: ({ task, run }) => {
          if (task === undefined || run?.queue === undefined)
            throw new Error('Original canonical Run missing');
          return {
            task: task.task,
            run: { ...run, queue: { ...run.queue, state: 'retired' } },
            outbox: [],
          };
        },
      });
      await f.store.transactCapacity({
        now: LATER,
        recordKeys: [],
        decide: (snapshot) => {
          for (const receipt of snapshot.state.receipts) delete receipt.taskKey;
          snapshot.state.revision++;
          return { value: undefined, state: snapshot.state };
        },
      });
      expect(
        (
          await claim(
            f.protocol,
            B,
            'producer-successor',
            'historical-retry',
            LATER,
            HASH_B,
          )
        ).kind,
      ).toBe('wait');
      expect((await f.store.readRun(successor.runId))?.queue?.state).toBe(
        'queued',
      );
      const other = await new Orchestrator(f.store, {
        now: () => LATER,
      }).request({
        taskId: { repo: 'example/lineage', issue: 997 },
        requestId: 'historical-unrelated',
        pipeline: 'claude',
        work: { spec: { title: 'Known unrelated historical lineage' } },
      });
      if (isRefusal(other)) throw new Error(other.reason);
      const run = decidedRun(other);
      await f.store.enqueueRun({ runId: run.runId, now: LATER });
      const admitted = await claim(
        f.protocol,
        B,
        'producer-successor',
        'historical-unrelated',
        LATER,
        HASH_B,
      );
      expect(admitted.kind).toBe('claim');
      if (admitted.kind !== 'claim')
        throw new Error('Expected unrelated claim');
      expect(admitted.run.runId).toBe(run.runId);
    });
    it('discards orphan lineage hints and globally fences until positive physical retirement', async () => {
      const f = await fixture(factory);
      const c = { ...A, poolId: 'orphan-pool' };
      const orphanPolicy = {
        ...POLICY,
        poolId: c.poolId,
        domains: {
          opencode: { domainId: 'separate-orphan-domain', ceiling: 1 },
        },
      };
      await f.protocol.configure(c, orphanPolicy, START);
      const orphan: CapacityReceipt = {
        ...f.first.receipt,
        poolId: c.poolId,
        slot: 0,
        runId: 'unrecoverable-orphan/r1',
        taskKey: 'example/spoof#1',
        pipeline: 'opencode',
        domainId: 'separate-orphan-domain',
        state: 'quarantined',
        unplaced: false,
        producerId: 'orphan-producer',
        runner: 'orphan-runner',
        jobUid: 'orphan-job',
        secretUid: undefined,
        worker: undefined,
        attestedPod: undefined,
        recovery: undefined,
        producers: [
          {
            producerId: 'orphan-producer',
            subject: c.subject,
            stopped: false,
            fenced: false,
            pendingWrites: [],
          },
        ],
      };
      const inventory = {
        now: START,
        receipts: [orphan],
        known: true,
        evidence: 'observed-orphan-job',
        dryRun: true,
      };
      const dry = await f.protocol.importInventory(c, inventory);
      expect(dry.inventoryKnown).toBe(false);
      await f.protocol.importInventory(c, {
        ...inventory,
        dryRun: false,
        reviewedDigest: dry.digest,
      });
      const stored = (await f.protocol.read(START)).receipts.find(
        (r) => r.runId === orphan.runId,
      );
      expect(stored).not.toHaveProperty('taskKey');
      for (const field of ['secretUid', 'worker', 'attestedPod', 'recovery'])
        expect(stored).not.toHaveProperty(field);
      const other = await f.orchestrator.request({
        taskId: { repo: 'example/lineage', issue: 996 },
        requestId: 'orphan-unrelated',
        pipeline: 'claude',
        work: { spec: { title: 'Cannot prove unrelated to orphan' } },
      });
      if (isRefusal(other)) throw new Error(other.reason);
      const run = decidedRun(other);
      await f.store.enqueueRun({ runId: run.runId, now: START });
      await expect(
        claim(
          f.protocol,
          B,
          'producer-successor',
          'orphan-blocked',
          START,
          HASH_B,
        ),
      ).rejects.toThrow('inventory');
      const recoveryNonce = 'orphan-retirement-123456';
      await f.protocol.recover(c, F(orphan), {
        nonce: recoveryNonce,
        now: START,
        expiresAt: '2026-10-10T04:01:00.000Z',
      });
      await f.protocol.retire(c, F(orphan), { recoveryNonce, now: START });
      await f.protocol.stopProducer(c, F(orphan), {
        producerId: orphan.producerId,
        producerSubject: c.subject,
        fenced: false,
        evidence: 'orphan-producer-definitively-stopped',
        now: START,
      });
      await f.protocol.release(c, F(orphan), {
        recoveryNonce,
        barrierUid: 'orphan-inert-barrier',
        barrierRunId: orphan.runId,
        barrierNonce: orphan.nonce,
        resourceVersion: 'orphan-rv',
        jobName: orphan.jobName,
        evidence: 'owned-orphan-job-inert-and-pods-ended',
        inert: true,
        physicalWorkersEnded: true,
        neverStarted: true,
        originalJobUid: 'orphan-job',
        now: START,
      });
      const admitted = await claim(
        f.protocol,
        B,
        'producer-successor',
        'orphan-retired',
        START,
        HASH_B,
      );
      expect(admitted.kind).toBe('claim');
      if (admitted.kind !== 'claim')
        throw new Error('Expected unrelated claim');
      expect(admitted.run.runId).toBe(run.runId);
    });
    it('admits the retry only after exact worker/producer retirement and permanent released receipt', async () => {
      const f = await fixture(factory);
      const successor = await retry(f);
      const recoveryNonce = 'recovery-release-proof-123456';
      await f.protocol.recover(A, F(f.first.receipt), {
        nonce: recoveryNonce,
        now: LATER,
        expiresAt: '2026-10-10T07:01:00.000Z',
      });
      await f.protocol.retire(A, F(f.first.receipt), {
        recoveryNonce,
        now: LATER,
      });
      await f.protocol.workerRetired(A, F(f.first.receipt), {
        recoveryNonce,
        generation: 1,
        podUid: 'pod-original',
        evidence: 'exact-old-pod-ended',
        now: LATER,
      });
      await f.protocol.stopProducer(A, F(f.first.receipt), {
        producerId: 'producer-original',
        producerSubject: A.subject,
        fenced: false,
        evidence: 'definitive-producer-stop',
        now: LATER,
      });
      expect(
        await f.protocol.release(A, F(f.first.receipt), {
          recoveryNonce,
          barrierUid: 'old-job-barrier',
          barrierRunId: f.original.runId,
          barrierNonce: f.first.receipt.nonce,
          resourceVersion: 'old-job-rv',
          jobName: f.first.receipt.jobName,
          evidence: 'exact-inert-job-and-ended-worker',
          inert: true,
          physicalWorkersEnded: true,
          neverStarted: false,
          originalJobUid: 'job-original',
          now: LATER,
        }),
      ).toEqual({ released: true, retainBarrier: false });
      const record = await f.store.transactCapacity({
        now: LATER,
        runId: f.original.runId,
        recordKeys: [retiredKey(f.original.runId)],
        decide: (s) => ({ value: s.records.get(retiredKey(f.original.runId)) }),
      });
      expect(record).toMatchObject({
        kind: 'retired',
        runId: f.original.runId,
        released: true,
      });
      const second = await claim(
        f.protocol,
        B,
        'producer-successor',
        'after-retirement',
        LATER,
        HASH_B,
      );
      expect(second.kind).toBe('claim');
      if (second.kind !== 'claim')
        throw new Error('Expected retired successor claim');
      expect(second.run.runId).toBe(successor.runId);
      {
        await activate(
          f.protocol,
          B,
          second.receipt,
          'successor',
          LATER,
          HASH_B,
        );
      }
      expect(
        (await f.protocol.read(LATER)).receipts.filter((r) => r.worker?.active),
      ).toHaveLength(1);
    });
  });
}
contract('MemoryStore', () => new MemoryStore());
const emulatorHost = process.env['FIRESTORE_EMULATOR_HOST'];
if (
  process.env['REQUIRE_FIRESTORE_EMULATOR'] === '1' &&
  emulatorHost === undefined
)
  throw new Error('Lineage contracts require Firestore emulator');
let counter = 0;
contract(
  'FirestoreStore',
  () =>
    new FirestoreStore({
      projectId: 'demo-capacity-lineage',
      databaseId: '(default)',
      collectionPrefix: `lineage-${Date.now()}-${++counter}-`,
      emulatorHost,
    }),
  emulatorHost !== undefined,
);
