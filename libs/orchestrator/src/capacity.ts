import { createHash } from 'node:crypto';

import {
  type CapacityFence,
  type CapacityPoolPolicy,
  capacityPoolPolicySchema,
  type CapacityReceipt,
  type CapacityRecord,
  CapacityRefusal,
  producerKey,
  requestKey,
  retiredKey,
} from './capacity-model';
import { runLeaseExpiresAt } from './decide';
import { isLive, type Run } from './model';
import {
  isQueueAdmissionCandidate,
  QUEUE_PIPELINE_MAX_LIVE_CLAIMS,
} from './queue-admission-status';
import type { CapacityTransactionSnapshot, OrchestratorStore } from './store';

/** Only a resolved server grant can construct this authority. Recovery and
 * fencing are separate capabilities, never inferred from claimant exit rights. */
export interface CapacityAuthority {
  poolId: string;
  subject: string;
  pipelines: readonly string[];
  capabilities: ReadonlySet<'claim' | 'recover' | 'fence' | 'operator'>;
}
export type CapacityClaim =
  | { kind: 'claim'; receipt: CapacityReceipt; run: Run }
  | { kind: 'recover-owned-secret'; receipt: CapacityReceipt }
  | { kind: 'quarantined-unrecoverable-token'; runId: string; jobName: string }
  | { kind: 'wait'; reason: 'capacity' | 'queue' };

function requireCapability(
  authority: CapacityAuthority,
  capability: 'claim' | 'recover' | 'fence' | 'operator',
) {
  if (!authority.capabilities.has(capability))
    throw new CapacityRefusal('authority');
}
function policyFor(
  snapshot: CapacityTransactionSnapshot,
  authority: CapacityAuthority,
) {
  const policy = snapshot.state.policies.find(
    (value) => value.poolId === authority.poolId,
  );
  if (policy === undefined || !policy.enforced)
    throw new CapacityRefusal('policy');
  return policy;
}
function exactReceipt(
  snapshot: CapacityTransactionSnapshot,
  authority: CapacityAuthority,
  fence: CapacityFence,
) {
  if (authority.poolId !== fence.poolId) throw new CapacityRefusal('authority');
  const receipt = snapshot.state.receipts.find(
    (value) => value.poolId === fence.poolId && value.slot === fence.slot,
  );
  if (
    receipt === undefined ||
    receipt.revision !== fence.revision ||
    receipt.runId !== fence.runId ||
    receipt.nonce !== fence.nonce
  ) {
    throw new CapacityRefusal('stale');
  }
  if (!authority.pipelines.includes(receipt.pipeline))
    throw new CapacityRefusal('authority');
  return receipt;
}
function commit(snapshot: CapacityTransactionSnapshot) {
  snapshot.state.revision++;
  return snapshot.state;
}
const mutations = (records: Iterable<[string, CapacityRecord]>) =>
  new Map(records);

/** Server-owned protocol. Every transition below is a single store transaction.
 * External Kubernetes evidence is accepted only from the separately granted
 * inventory/recovery authority; worker-provided UID strings cannot attest it. */
export class CapacityProtocol {
  constructor(readonly store: OrchestratorStore) {}

  async read(now: string) {
    return this.store.transactCapacity({
      now,
      recordKeys: [],
      decide: (snapshot) => ({ value: snapshot.state }),
    });
  }

  /** Dry-run is a read-only application operation. Its digest binds the exact
   * active revision, claimed-run inventory and operator-supplied physical
   * observations. A changed claim/configuration requires a fresh review. */
  async importInventory(
    authority: CapacityAuthority,
    input: {
      now: string;
      dryRun: boolean;
      reviewedDigest?: string;
      known: boolean;
      evidence: string;
      receipts: CapacityReceipt[];
    },
  ) {
    requireCapability(authority, 'operator');
    return this.store.transactCapacity({
      now: input.now,
      recordKeys: input.receipts.flatMap((receipt) => [
        producerKey(receipt.poolId, receipt.subject, receipt.producerId),
        retiredKey(receipt.runId),
      ]),
      claimPipelines: [],
      decide: (snapshot) => {
        const policy = snapshot.state.policies.find(
          (value) => value.poolId === authority.poolId,
        );
        if (policy === undefined) throw new CapacityRefusal('policy');
        const imported = structuredClone(input.receipts);
        if (
          imported.some(
            (receipt) =>
              receipt.poolId !== policy.poolId ||
              receipt.slot >= policy.maxConcurrent ||
              policy.domains[receipt.pipeline]?.domainId !== receipt.domainId ||
              !authority.pipelines.includes(receipt.pipeline),
          )
        )
          throw new CapacityRefusal('policy');
        if (
          new Set(imported.map((receipt) => receipt.slot)).size !==
            imported.length ||
          new Set(imported.map((receipt) => receipt.runId)).size !==
            imported.length
        )
          throw new CapacityRefusal('stale');
        if (
          imported.some((receipt) =>
            snapshot.state.receipts.some(
              (current) => current.runId === receipt.runId,
            ),
          )
        )
          throw new CapacityRefusal('physical');
        const existing = snapshot.state.receipts.filter(
          (receipt) => receipt.poolId === policy.poolId,
        );
        if (existing.length !== 0) throw new CapacityRefusal('physical');
        const claimed = snapshot.runs.filter(
          (run) =>
            run.queue?.state === 'claimed' &&
            !snapshot.state.receipts.some(
              (receipt) => receipt.runId === run.runId,
            ),
        );
        const missing = claimed.filter(
          (run) =>
            policy.domains[run.pipeline] !== undefined &&
            !imported.some((receipt) => receipt.runId === run.runId),
        );
        for (const receipt of imported) {
          const run = snapshot.runs.find(
            (value) => value.runId === receipt.runId,
          );
          if (
            run !== undefined &&
            (run.queue?.tokenHash !== receipt.tokenHash ||
              run.pipeline !== receipt.pipeline ||
              (run.queue.claimedBySubject !== undefined &&
                run.queue.claimedBySubject !== receipt.subject) ||
              (run.queue.claimedBy !== undefined &&
                run.queue.claimedBy !== receipt.runner))
          )
            throw new CapacityRefusal('stale');
          if (snapshot.records.has(retiredKey(receipt.runId)))
            throw new CapacityRefusal('retired');
        }
        const known = input.known && missing.length === 0;
        const digest = createHash('sha256')
          .update(
            JSON.stringify({
              revision: snapshot.state.revision,
              policy,
              claimed,
              imported,
              known,
              evidence: input.evidence,
            }),
          )
          .digest('hex');
        const report = {
          digest,
          inventoryKnown: known,
          missingRunIds: missing.map((run) => run.runId),
          imported: imported.length,
          revision: snapshot.state.revision,
        };
        if (input.dryRun) return { value: report };
        if (input.reviewedDigest !== digest) throw new CapacityRefusal('stale');
        policy.inventoryKnown = known;
        const records = new Map<string, CapacityRecord>();
        for (const receipt of imported) {
          const key = producerKey(
            receipt.poolId,
            receipt.subject,
            receipt.producerId,
          );
          const prior = snapshot.records.get(key);
          if (prior?.kind === 'producer' && prior.closed)
            throw new CapacityRefusal('producer');
          records.set(key, {
            kind: 'producer',
            poolId: receipt.poolId,
            subject: receipt.subject,
            producerId: receipt.producerId,
            closed: false,
          });
          receipt.state = 'quarantined';
          snapshot.state.receipts.push(receipt);
          snapshot.state.slotRevisions[
            JSON.stringify([receipt.poolId, receipt.slot])
          ] = receipt.revision;
        }
        return { value: report, state: commit(snapshot), records };
      },
    });
  }

  async authorizeProducer(
    authority: CapacityAuthority,
    fence: CapacityFence,
    input: { producerId: string; recoveryNonce: string; now: string },
  ) {
    requireCapability(authority, 'recover');
    const key = producerKey(
      authority.poolId,
      authority.subject,
      input.producerId,
    );
    return this.store.transactCapacity({
      now: input.now,
      recordKeys: [key, retiredKey(fence.runId)],
      decide: (snapshot) => {
        const receipt = exactReceipt(snapshot, authority, fence);
        this.recoveryOwner(receipt, authority, input.recoveryNonce, input.now);
        const producer = snapshot.records.get(key);
        if (
          receipt.state === 'retiring' ||
          producer?.kind !== 'producer' ||
          producer.closed
        )
          throw new CapacityRefusal('producer');
        if (
          !receipt.producers.some(
            (value) =>
              value.producerId === input.producerId &&
              value.subject === authority.subject,
          )
        )
          receipt.producers.push({
            producerId: input.producerId,
            subject: authority.subject,
            stopped: false,
            fenced: false,
            pendingWrites: [],
          });
        return { value: receipt, state: commit(snapshot) };
      },
    });
  }

  async configure(
    authority: CapacityAuthority,
    proposed: CapacityPoolPolicy,
    now: string,
  ) {
    requireCapability(authority, 'operator');
    const policy = capacityPoolPolicySchema.parse(proposed);
    for (const [pipeline, domain] of Object.entries(policy.domains)) {
      const maximum = QUEUE_PIPELINE_MAX_LIVE_CLAIMS[pipeline];
      if (maximum !== undefined && domain.ceiling > maximum)
        throw new CapacityRefusal('policy');
    }
    if (authority.poolId !== policy.poolId)
      throw new CapacityRefusal('authority');
    return this.store.transactCapacity({
      now,
      recordKeys: [],
      claimPipelines: [],
      decide: (snapshot) => {
        const current = snapshot.state.policies.find(
          (value) => value.poolId === policy.poolId,
        );
        if (
          current !== undefined &&
          (policy.version <= current.version ||
            policy.cluster !== current.cluster ||
            policy.namespace !== current.namespace)
        )
          throw new CapacityRefusal('policy');
        const occupied = snapshot.state.receipts.filter(
          (value) => value.poolId === policy.poolId,
        );
        if (
          current?.enforced &&
          !policy.enforced &&
          (!current.inventoryKnown ||
            occupied.length !== 0 ||
            snapshot.runs.some(
              (run) =>
                run.queue?.state === 'claimed' &&
                current.domains[run.pipeline] !== undefined,
            ))
        )
          throw new CapacityRefusal('physical');
        // A configuration update cannot declare migration inventory known. The
        // operator-reviewed import owns that evidence, not a boolean in config.
        policy.inventoryKnown = current?.inventoryKnown ?? false;
        if (
          occupied.some(
            (receipt) =>
              policy.domains[receipt.pipeline]?.domainId !== receipt.domainId,
          )
        )
          throw new CapacityRefusal('policy');
        const policies = snapshot.state.policies.filter(
          (value) => value.poolId !== policy.poolId,
        );
        for (const other of policies)
          for (const domain of Object.values(other.domains)) {
            for (const proposedDomain of Object.values(policy.domains)) {
              if (
                domain.domainId === proposedDomain.domainId &&
                domain.ceiling !== proposedDomain.ceiling
              )
                throw new CapacityRefusal('policy');
            }
          }
        if (
          policies.length >= 16 ||
          [...policies, policy].reduce(
            (sum, value) => sum + value.maxConcurrent,
            0,
          ) > 128
        )
          throw new CapacityRefusal('bounds');
        snapshot.state.policies = [...policies, policy];
        return { value: policy, state: commit(snapshot) };
      },
    });
  }

  async register(
    authority: CapacityAuthority,
    producerId: string,
    now: string,
  ) {
    requireCapability(authority, 'claim');
    const key = producerKey(authority.poolId, authority.subject, producerId);
    return this.store.transactCapacity({
      now,
      recordKeys: [key],
      decide: (snapshot) => {
        policyFor(snapshot, authority);
        const existing = snapshot.records.get(key);
        if (existing?.kind === 'producer' && existing.closed)
          throw new CapacityRefusal('producer');
        const record: CapacityRecord = {
          kind: 'producer',
          poolId: authority.poolId,
          producerId,
          subject: authority.subject,
          closed: false,
        };
        return {
          value: record,
          state: commit(snapshot),
          records: mutations([[key, record]]),
        };
      },
    });
  }

  async claim(
    authority: CapacityAuthority,
    input: {
      version: number;
      runner: string;
      producerId: string;
      claimRequestId: string;
      tokenHash: string;
      nonce: string;
      now: string;
    },
  ): Promise<CapacityClaim> {
    requireCapability(authority, 'claim');
    const producer = producerKey(
      authority.poolId,
      authority.subject,
      input.producerId,
    );
    const request = requestKey(
      authority.poolId,
      authority.subject,
      input.producerId,
      input.claimRequestId,
    );
    return this.store.transactCapacity<CapacityClaim>({
      now: input.now,
      recordKeys: [producer, request],
      claimPipelines: authority.pipelines,
      decide: (snapshot) => {
        const policy = policyFor(snapshot, authority);
        if (policy.version !== input.version)
          throw new CapacityRefusal('policy');
        const incarnation = snapshot.records.get(producer);
        if (incarnation?.kind !== 'producer')
          throw new CapacityRefusal('producer');
        const replay = snapshot.records.get(request);
        if (incarnation.closed && replay?.kind !== 'request')
          throw new CapacityRefusal('producer');
        if (replay?.kind === 'request') {
          const receipt = snapshot.state.receipts.find(
            (value) =>
              value.runId === replay.runId && value.nonce === replay.nonce,
          );
          if (
            receipt !== undefined &&
            receipt.state !== 'retiring' &&
            !incarnation.closed &&
            receipt.secretUid !== undefined &&
            snapshot.runs.some(
              (run) =>
                run.runId === receipt.runId &&
                isLive(run.state) &&
                run.leaseExpiresAt > input.now,
            )
          ) {
            return {
              value: { kind: 'recover-owned-secret' as const, receipt },
            };
          }
          if (receipt !== undefined && receipt.state !== 'retiring')
            receipt.state = 'quarantined';
          return {
            value: {
              kind: 'quarantined-unrecoverable-token' as const,
              runId: replay.runId,
              jobName: replay.jobName,
            },
            ...(receipt === undefined || receipt.state === 'retiring'
              ? {}
              : { state: commit(snapshot) }),
          };
        }
        if (
          snapshot.state.receipts.some(
            (receipt) =>
              receipt.poolId === authority.poolId &&
              receipt.producerId === input.producerId &&
              receipt.subject === authority.subject &&
              receipt.secretUid === undefined,
          )
        )
          throw new CapacityRefusal('producer');
        if (!policy.inventoryKnown) throw new CapacityRefusal('inventory');
        const poolReceipts = snapshot.state.receipts.filter(
          (value) => value.poolId === policy.poolId,
        );
        if (
          poolReceipts.length >= policy.maxConcurrent ||
          poolReceipts.filter((value) => value.unplaced).length >=
            policy.maxUnplaced
        ) {
          return {
            value: { kind: 'wait' as const, reason: 'capacity' as const },
          };
        }
        const receiptRuns = new Set(
          snapshot.state.receipts.map((value) => value.runId),
        );
        const occupancy = new Map<string, Set<string>>();
        const occupy = (domain: string, runId: string) => {
          const set = occupancy.get(domain) ?? new Set<string>();
          set.add(runId);
          occupancy.set(domain, set);
        };
        for (const receipt of snapshot.state.receipts)
          occupy(receipt.domainId, receipt.runId);
        // Legacy claims (even logically terminal) remain occupied until imported
        // and physically retired. Unknown domain mappings fail closed.
        for (const run of snapshot.runs) {
          const retirement = snapshot.records.get(retiredKey(run.runId));
          if (
            run.queue?.state === 'claimed' &&
            !receiptRuns.has(run.runId) &&
            !(retirement?.kind === 'retired' && retirement.released)
          ) {
            const domains = new Set(
              snapshot.state.policies.flatMap(
                (value) => value.domains[run.pipeline]?.domainId ?? [],
              ),
            );
            for (const domain of domains) occupy(domain, run.runId);
          }
        }
        const candidates = snapshot.runs
          .filter((run) => {
            const domain = policy.domains[run.pipeline];
            if (
              domain === undefined ||
              !authority.pipelines.includes(run.pipeline) ||
              snapshot.coolingPipelines.has(run.pipeline) ||
              !isQueueAdmissionCandidate(run, input.now) ||
              receiptRuns.has(run.runId) ||
              snapshot.records.has(retiredKey(run.runId))
            )
              return false;
            if (
              snapshot.state.policies.some(
                (value) =>
                  value.enforced &&
                  !value.inventoryKnown &&
                  Object.values(value.domains).some(
                    (other) => other.domainId === domain.domainId,
                  ),
              )
            )
              return false;
            return (occupancy.get(domain.domainId)?.size ?? 0) < domain.ceiling;
          })
          .sort((left, right) => {
            const a =
              occupancy.get(policy.domains[left.pipeline]?.domainId ?? '')
                ?.size ?? 0;
            const b =
              occupancy.get(policy.domains[right.pipeline]?.domainId ?? '')
                ?.size ?? 0;
            return (
              a - b ||
              left.createdAt.localeCompare(right.createdAt) ||
              left.runId.localeCompare(right.runId)
            );
          });
        const run = candidates[0];
        if (run === undefined)
          return { value: { kind: 'wait' as const, reason: 'queue' as const } };
        let slot = 0;
        while (poolReceipts.some((receipt) => receipt.slot === slot)) slot++;
        if (slot >= policy.maxConcurrent)
          return {
            value: { kind: 'wait' as const, reason: 'capacity' as const },
          };
        const slotKey = JSON.stringify([policy.poolId, slot]);
        const revision = (snapshot.state.slotRevisions[slotKey] ?? 0) + 1;
        snapshot.state.slotRevisions[slotKey] = revision;
        const receipt: CapacityReceipt = {
          poolId: policy.poolId,
          slot,
          revision,
          runId: run.runId,
          nonce: input.nonce,
          domainId: policy.domains[run.pipeline]?.domainId ?? '',
          pipeline: run.pipeline,
          subject: authority.subject,
          runner: input.runner,
          producerId: input.producerId,
          tokenHash: input.tokenHash,
          retiredWorkers: [],
          claimedAt: input.now,
          state: 'unplaced',
          unplaced: true,
          jobName: `lcars-work-${createHash('sha256').update(run.runId).digest('hex').slice(0, 40)}`,
          producers: [
            {
              producerId: input.producerId,
              subject: authority.subject,
              stopped: false,
              fenced: false,
              pendingWrites: [],
            },
          ],
        };
        snapshot.state.receipts.push(receipt);
        const claimed: Run = {
          ...run,
          leaseExpiresAt: runLeaseExpiresAt(input.now),
          updatedAt: input.now,
          queue: {
            state: 'claimed',
            claimedAt: input.now,
            claimedBy: input.runner,
            claimedBySubject: authority.subject,
            tokenHash: input.tokenHash,
          },
        };
        const record: CapacityRecord = {
          kind: 'request',
          poolId: policy.poolId,
          producerId: input.producerId,
          subject: authority.subject,
          requestId: input.claimRequestId,
          runId: run.runId,
          slot,
          nonce: input.nonce,
          tokenHash: input.tokenHash,
          jobName: receipt.jobName,
        };
        return {
          value: { kind: 'claim' as const, receipt, run: claimed },
          state: commit(snapshot),
          run: claimed,
          records: mutations([[request, record]]),
        };
      },
    });
  }

  private async change<T>(
    authority: CapacityAuthority,
    fence: CapacityFence,
    now: string,
    decide: (
      receipt: CapacityReceipt,
      snapshot: CapacityTransactionSnapshot,
    ) => T,
    writeRun = false,
  ) {
    return this.store.transactCapacity({
      now,
      runId: fence.runId,
      recordKeys: [retiredKey(fence.runId)],
      decide: (snapshot) => {
        policyFor(snapshot, authority);
        const receipt = exactReceipt(snapshot, authority, fence);
        const value = decide(receipt, snapshot);
        return {
          value,
          state: commit(snapshot),
          records: snapshot.records,
          ...(writeRun ? { run: snapshot.runs[0] } : {}),
        };
      },
    });
  }

  async quarantine(
    authority: CapacityAuthority,
    fence: CapacityFence,
    now: string,
  ) {
    requireCapability(authority, 'claim');
    return this.change(authority, fence, now, (receipt) => {
      if (receipt.subject !== authority.subject || receipt.state === 'retiring')
        throw new CapacityRefusal('authority');
      receipt.state = 'quarantined';
      return receipt;
    });
  }

  async recover(
    authority: CapacityAuthority,
    fence: CapacityFence,
    input: {
      nonce: string;
      now: string;
      expiresAt: string;
      purpose?: 'recover' | 'retire';
    },
  ) {
    requireCapability(authority, 'recover');
    if (
      Date.parse(input.expiresAt) <= Date.parse(input.now) ||
      Date.parse(input.expiresAt) - Date.parse(input.now) > 60_000
    )
      throw new CapacityRefusal('stale');
    return this.change(authority, fence, input.now, (receipt) => {
      if (receipt.state === 'retiring' && input.purpose !== 'retire')
        throw new CapacityRefusal('retired');
      if (
        receipt.recovery !== undefined &&
        receipt.recovery.expiresAt > input.now &&
        (receipt.recovery.subject !== authority.subject ||
          receipt.recovery.nonce !== input.nonce)
      )
        throw new CapacityRefusal('stale');
      receipt.recovery = {
        subject: authority.subject,
        nonce: input.nonce,
        expiresAt: input.expiresAt,
      };
      return receipt;
    });
  }

  private recoveryOwner(
    receipt: CapacityReceipt,
    authority: CapacityAuthority,
    nonce: string,
    now: string,
  ) {
    requireCapability(authority, 'recover');
    if (
      receipt.recovery?.subject !== authority.subject ||
      receipt.recovery.nonce !== nonce ||
      receipt.recovery.expiresAt <= now
    )
      throw new CapacityRefusal('stale');
  }

  async bind(
    authority: CapacityAuthority,
    fence: CapacityFence,
    input: {
      recoveryNonce: string;
      jobUid: string;
      jobName: string;
      podUid?: string;
      secretUid?: string;
      secretTokenHash?: string;
      placed: boolean;
      deleting: boolean;
      owned: boolean;
      now: string;
    },
  ) {
    return this.change(authority, fence, input.now, (receipt) => {
      this.recoveryOwner(receipt, authority, input.recoveryNonce, input.now);
      if (receipt.state === 'retiring') throw new CapacityRefusal('retired');
      if (
        !input.owned ||
        input.deleting ||
        input.jobName !== receipt.jobName ||
        (receipt.jobUid !== undefined && receipt.jobUid !== input.jobUid)
      )
        throw new CapacityRefusal('physical');
      if (input.secretUid !== undefined) {
        if (
          input.secretTokenHash !== receipt.tokenHash ||
          (receipt.secretUid !== undefined &&
            receipt.secretUid !== input.secretUid)
        )
          throw new CapacityRefusal('physical');
        receipt.secretUid = input.secretUid;
      }
      receipt.jobUid = input.jobUid;
      if (input.placed && input.podUid !== undefined) {
        receipt.state = 'placed';
        receipt.unplaced = false;
      }
      return receipt;
    });
  }

  async attest(
    authority: CapacityAuthority,
    fence: CapacityFence,
    input: {
      recoveryNonce: string;
      jobUid: string;
      podUid: string;
      generation: number;
      owned: boolean;
      now: string;
    },
  ) {
    return this.change(authority, fence, input.now, (receipt) => {
      this.recoveryOwner(receipt, authority, input.recoveryNonce, input.now);
      if (
        receipt.state === 'retiring' ||
        receipt.jobUid !== input.jobUid ||
        !input.owned
      )
        throw new CapacityRefusal('physical');
      if (
        receipt.retiredWorkers.some((worker) => worker.podUid === input.podUid)
      )
        throw new CapacityRefusal('worker');
      if (receipt.worker?.active && receipt.worker.podUid !== input.podUid)
        throw new CapacityRefusal('worker');
      if (!receipt.worker?.active && receipt.retiredWorkers.length >= 32)
        throw new CapacityRefusal('bounds');
      const generation = receipt.worker?.active
        ? receipt.worker.generation
        : (receipt.worker?.generation ?? 0) + 1;
      if (input.generation !== generation) throw new CapacityRefusal('stale');
      receipt.attestedPod = {
        jobUid: input.jobUid,
        podUid: input.podUid,
        generation,
      };
      return receipt;
    });
  }

  /** podUid is derived from a verified Kubernetes bound workload JWT by the
   * HTTP owner. A run token plus arbitrary caller-provided UID is insufficient. */
  async activate(input: {
    fence: CapacityFence;
    podUid: string;
    jobUid: string;
    tokenHash: string;
    now: string;
  }) {
    return this.store.transactCapacity({
      now: input.now,
      runId: input.fence.runId,
      recordKeys: [retiredKey(input.fence.runId)],
      decide: (snapshot) => {
        const receipt = snapshot.state.receipts.find(
          (value) => value.runId === input.fence.runId,
        );
        if (receipt === undefined) throw new CapacityRefusal('stale');
        const authority: CapacityAuthority = {
          poolId: receipt.poolId,
          subject: receipt.subject,
          pipelines: [receipt.pipeline],
          capabilities: new Set(),
        };
        exactReceipt(snapshot, authority, input.fence);
        const run = snapshot.runs[0];
        if (
          snapshot.records.has(retiredKey(receipt.runId)) ||
          receipt.state === 'retiring' ||
          run === undefined ||
          !isLive(run.state) ||
          run.leaseExpiresAt <= input.now
        )
          throw new CapacityRefusal('retired');
        if (
          input.tokenHash !== receipt.tokenHash ||
          receipt.attestedPod?.podUid !== input.podUid ||
          receipt.attestedPod.jobUid !== input.jobUid ||
          receipt.jobUid !== input.jobUid
        )
          throw new CapacityRefusal('authority');
        if (
          receipt.retiredWorkers.some(
            (worker) => worker.podUid === input.podUid,
          )
        )
          throw new CapacityRefusal('worker');
        if (receipt.worker?.active) {
          if (
            receipt.worker.podUid !== input.podUid ||
            receipt.worker.jobUid !== input.jobUid
          )
            throw new CapacityRefusal('worker');
          return { value: receipt.worker.generation };
        }
        if (
          receipt.worker !== undefined &&
          receipt.worker.retiredEvidence === undefined
        )
          throw new CapacityRefusal('physical');
        const generation = (receipt.worker?.generation ?? 0) + 1;
        if (receipt.attestedPod.generation !== generation)
          throw new CapacityRefusal('stale');
        receipt.worker = {
          generation,
          podUid: input.podUid,
          jobUid: input.jobUid,
          active: true,
        };
        return { value: receipt.worker.generation, state: commit(snapshot) };
      },
    });
  }

  async workerRetired(
    authority: CapacityAuthority,
    fence: CapacityFence,
    input: {
      recoveryNonce: string;
      generation: number;
      podUid: string;
      evidence: string;
      now: string;
    },
  ) {
    return this.change(authority, fence, input.now, (receipt) => {
      this.recoveryOwner(receipt, authority, input.recoveryNonce, input.now);
      if (
        receipt.worker?.generation !== input.generation ||
        receipt.worker.podUid !== input.podUid
      )
        throw new CapacityRefusal('stale');
      if (
        !receipt.retiredWorkers.some((worker) => worker.podUid === input.podUid)
      )
        receipt.retiredWorkers.push({
          podUid: input.podUid,
          generation: input.generation,
          evidence: input.evidence,
        });
      receipt.worker.active = false;
      receipt.worker.retiredEvidence = input.evidence;
      return receipt;
    });
  }

  async operation(
    authority: CapacityAuthority,
    fence: CapacityFence,
    input: {
      producerId: string;
      operationId: string;
      resolved: boolean;
      recoveryNonce: string;
      now: string;
    },
  ) {
    return this.change(authority, fence, input.now, (receipt) => {
      this.recoveryOwner(receipt, authority, input.recoveryNonce, input.now);
      const producer = receipt.producers.find(
        (value) =>
          value.producerId === input.producerId &&
          value.subject === authority.subject,
      );
      if (
        producer === undefined ||
        (!input.resolved &&
          (producer.stopped || producer.fenced || receipt.state === 'retiring'))
      )
        throw new CapacityRefusal('producer');
      if (input.resolved)
        producer.pendingWrites = producer.pendingWrites.filter(
          (value) => value !== input.operationId,
        );
      else if (!producer.pendingWrites.includes(input.operationId))
        producer.pendingWrites.push(input.operationId);
      return receipt;
    });
  }

  async stopProducer(
    authority: CapacityAuthority,
    fence: CapacityFence,
    input: {
      producerId: string;
      producerSubject: string;
      fenced: boolean;
      evidence: string;
      now: string;
    },
  ) {
    requireCapability(authority, input.fenced ? 'fence' : 'recover');
    if (!input.fenced && input.producerSubject !== authority.subject)
      throw new CapacityRefusal('authority');
    const key = producerKey(
      authority.poolId,
      input.producerSubject,
      input.producerId,
    );
    return this.store.transactCapacity({
      now: input.now,
      recordKeys: [key],
      decide: (snapshot) => {
        exactReceipt(snapshot, authority, fence);
        const record = snapshot.records.get(key);
        if (record?.kind !== 'producer') throw new CapacityRefusal('producer');
        const groups = snapshot.state.receipts
          .filter((receipt) => receipt.poolId === authority.poolId)
          .flatMap((receipt) => receipt.producers)
          .filter(
            (producer) =>
              producer.producerId === input.producerId &&
              producer.subject === input.producerSubject,
          );
        if (
          !input.fenced &&
          groups.some((producer) => producer.pendingWrites.length !== 0)
        )
          throw new CapacityRefusal('physical');
        for (const producer of groups) {
          producer.stopped = true;
          producer.fenced ||= input.fenced;
        }
        record.closed = true;
        return {
          value: { closed: true },
          state: commit(snapshot),
          records: mutations([[key, record]]),
        };
      },
    });
  }

  async retiredWriteResolved(
    authority: CapacityAuthority,
    input: {
      runId: string;
      nonce: string;
      barrierUid: string;
      operationId: string;
      producerId: string;
      producerSubject: string;
      evidence: string;
      now: string;
    },
  ) {
    requireCapability(authority, 'recover');
    const key = retiredKey(input.runId);
    return this.store.transactCapacity({
      now: input.now,
      recordKeys: [key],
      decide: (snapshot) => {
        const record = snapshot.records.get(key);
        if (
          record?.kind !== 'retired' ||
          record.poolId !== authority.poolId ||
          record.nonce !== input.nonce ||
          record.barrier?.uid !== input.barrierUid ||
          !record.released
        )
          throw new CapacityRefusal('stale');
        record.pendingWrites = record.pendingWrites.filter(
          (value) =>
            value !==
            JSON.stringify([
              input.producerSubject,
              input.producerId,
              input.operationId,
            ]),
        );
        return {
          value: { retainBarrier: record.pendingWrites.length !== 0 },
          state: commit(snapshot),
          records: mutations([[key, record]]),
        };
      },
    });
  }

  async retire(
    authority: CapacityAuthority,
    fence: CapacityFence,
    input: { recoveryNonce: string; now: string },
  ) {
    return this.change(authority, fence, input.now, (receipt, snapshot) => {
      this.recoveryOwner(receipt, authority, input.recoveryNonce, input.now);
      receipt.state = 'retiring';
      snapshot.records.set(retiredKey(receipt.runId), {
        kind: 'retired',
        runId: receipt.runId,
        poolId: receipt.poolId,
        nonce: receipt.nonce,
        jobName: receipt.jobName,
        pendingWrites: receipt.producers.flatMap((value) =>
          value.pendingWrites.map((operationId) =>
            JSON.stringify([value.subject, value.producerId, operationId]),
          ),
        ),
        released: false,
      });
      return receipt;
    });
  }

  async release(
    authority: CapacityAuthority,
    fence: CapacityFence,
    input: {
      recoveryNonce: string;
      barrierUid: string;
      barrierRunId: string;
      barrierNonce: string;
      resourceVersion: string;
      jobName: string;
      evidence: string;
      inert: boolean;
      physicalWorkersEnded: boolean;
      neverStarted: boolean;
      originalJobUid?: string;
      now: string;
    },
  ) {
    return this.change(
      authority,
      fence,
      input.now,
      (receipt, snapshot) => {
        this.recoveryOwner(receipt, authority, input.recoveryNonce, input.now);
        if (
          receipt.state !== 'retiring' ||
          receipt.producers.some((value) => !value.stopped) ||
          !input.inert ||
          !input.physicalWorkersEnded ||
          input.jobName !== receipt.jobName ||
          input.barrierRunId !== receipt.runId ||
          input.barrierNonce !== receipt.nonce ||
          receipt.worker?.active
        )
          throw new CapacityRefusal('physical');
        if (
          receipt.jobUid !== undefined &&
          input.originalJobUid !== receipt.jobUid
        )
          throw new CapacityRefusal('stale');
        if (
          receipt.worker !== undefined &&
          receipt.worker.retiredEvidence === undefined
        )
          throw new CapacityRefusal('physical');
        if (input.neverStarted && receipt.worker !== undefined)
          throw new CapacityRefusal('physical');
        const barrier = {
          uid: input.barrierUid,
          resourceVersion: input.resourceVersion,
          evidence: input.evidence,
        };
        snapshot.records.set(retiredKey(receipt.runId), {
          kind: 'retired',
          runId: receipt.runId,
          poolId: receipt.poolId,
          nonce: receipt.nonce,
          jobName: receipt.jobName,
          barrier,
          pendingWrites: receipt.producers.flatMap((value) =>
            value.pendingWrites.map((operationId) =>
              JSON.stringify([value.subject, value.producerId, operationId]),
            ),
          ),
          released: true,
        });
        const run = snapshot.runs[0];
        if (run?.queue !== undefined) {
          run.queue.state = 'retired';
          run.updatedAt = input.now;
        }
        snapshot.state.receipts = snapshot.state.receipts.filter(
          (value) => value !== receipt,
        );
        return {
          released: true,
          retainBarrier: receipt.producers.some(
            (value) => value.pendingWrites.length !== 0,
          ),
        };
      },
      true,
    );
  }
}
