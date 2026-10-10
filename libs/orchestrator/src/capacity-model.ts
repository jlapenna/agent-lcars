import { z } from 'zod';

const identity = z.string().min(1).max(175);
const metricIdentity = identity.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/u);
const time = z.iso.datetime();
const revision = z.number().int().nonnegative();
const nonce = z.string().min(16).max(128);

export const CAPACITY_RECEIPT_MAX_PRODUCERS = 8;
export const CAPACITY_PRODUCER_MAX_PENDING_WRITES = 32;

/** Deployment declares these identities. Requests cannot select a domain. */
export const capacityPoolPolicySchema = z.strictObject({
  poolId: metricIdentity,
  cluster: identity,
  namespace: identity,
  version: z.number().int().positive(),
  maxConcurrent: z.number().int().min(1).max(128),
  maxUnplaced: z.literal(1),
  enforced: z.boolean(),
  inventoryKnown: z.boolean(),
  domains: z.record(
    identity,
    z.strictObject({
      domainId: metricIdentity,
      ceiling: z.number().int().min(1).max(128),
    }),
  ),
});
export type CapacityPoolPolicy = z.infer<typeof capacityPoolPolicySchema>;

export const capacityReceiptSchema = z.strictObject({
  poolId: identity,
  slot: revision,
  revision,
  runId: identity,
  /** Bound from the canonical Run, never an operator-supplied lineage hint.
   * Missing historical/orphan identity retains a global admission fence. */
  taskKey: identity.optional(),
  nonce,
  domainId: identity,
  pipeline: identity,
  subject: identity,
  runner: identity,
  producerId: identity,
  claimedAt: time,
  state: z.enum(['unplaced', 'placed', 'quarantined', 'retiring']),
  unplaced: z.boolean(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/u),
  jobUid: identity.optional(),
  secretUid: identity.optional(),
  jobName: identity,
  worker: z
    .strictObject({
      generation: z.number().int().positive(),
      podUid: identity,
      jobUid: identity,
      active: z.boolean(),
      retiredEvidence: identity.optional(),
    })
    .optional(),
  retiredWorkers: z
    .array(
      z.strictObject({
        podUid: identity,
        generation: z.number().int().positive(),
        evidence: identity,
      }),
    )
    .max(32)
    .default([]),
  attestedPod: z
    .strictObject({
      podUid: identity,
      jobUid: identity,
      generation: z.number().int().positive(),
    })
    .optional(),
  recovery: z
    .strictObject({ subject: identity, nonce, expiresAt: time })
    .optional(),
  /** Each authorized producer records definitive write outcomes. Unknown
   * outcomes retain the Kubernetes barrier even after positive fencing. */
  producers: z
    .array(
      z.strictObject({
        producerId: identity,
        subject: identity,
        stopped: z.boolean(),
        fenced: z.boolean(),
        pendingWrites: z
          .array(identity)
          .max(CAPACITY_PRODUCER_MAX_PENDING_WRITES),
      }),
    )
    .min(1)
    .max(CAPACITY_RECEIPT_MAX_PRODUCERS),
  barrier: z
    .strictObject({
      uid: identity,
      resourceVersion: identity,
      evidence: identity,
    })
    .optional(),
});
export type CapacityReceipt = z.infer<typeof capacityReceiptSchema>;

/** Bounded active state only. Permanent replay/incarnation/retirement records
 * are separate documents, so history cannot exhaust Firestore's document limit. */
export const capacityStateSchema = z
  .strictObject({
    revision,
    policies: z.array(capacityPoolPolicySchema).max(16),
    receipts: z.array(capacityReceiptSchema).max(128),
    slotRevisions: z
      .record(identity, revision)
      .refine((value) => Object.keys(value).length <= 2048),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length < 900_000,
    'Capacity state exceeds storage bound',
  );
export type CapacityState = z.infer<typeof capacityStateSchema>;
export const emptyCapacityState = (): CapacityState => ({
  revision: 0,
  policies: [],
  receipts: [],
  slotRevisions: {},
});

export const capacityRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('producer'),
    poolId: identity,
    producerId: identity,
    subject: identity,
    closed: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('request'),
    poolId: identity,
    producerId: identity,
    subject: identity,
    requestId: identity,
    runId: identity,
    slot: revision,
    nonce,
    tokenHash: z.string(),
    jobName: identity,
  }),
  z.strictObject({
    kind: z.literal('retired'),
    runId: identity,
    poolId: identity,
    nonce,
    jobName: identity,
    barrier: z
      .strictObject({
        uid: identity,
        resourceVersion: identity,
        evidence: identity,
      })
      .optional(),
    pendingWrites: z.array(z.string().min(1).max(768)).max(256),
    released: z.boolean(),
  }),
]);
export type CapacityRecord = z.infer<typeof capacityRecordSchema>;

/** Capacity documents contain only JSON values. Validate before normalization
 * so undefined optionals are omitted without hiding invalid numbers or shapes.
 * Both stores use these boundaries to keep durable omission semantics equal. */
export function capacityStateForStorage(value: CapacityState): CapacityState {
  const validated = capacityStateSchema.parse(value);
  return capacityStateSchema.parse(JSON.parse(JSON.stringify(validated)));
}

export function capacityRecordForStorage(
  value: CapacityRecord,
): CapacityRecord {
  const validated = capacityRecordSchema.parse(value);
  return capacityRecordSchema.parse(JSON.parse(JSON.stringify(validated)));
}

export const producerKey = (
  pool: string,
  subject: string,
  incarnation: string,
) => JSON.stringify(['producer', pool, subject, incarnation]);
export const requestKey = (
  pool: string,
  subject: string,
  incarnation: string,
  request: string,
) => JSON.stringify(['request', pool, subject, incarnation, request]);
export const retiredKey = (run: string) => JSON.stringify(['retired', run]);

export interface CapacityFence {
  poolId: string;
  slot: number;
  revision: number;
  runId: string;
  nonce: string;
}

export interface CapacityWorkerPermit {
  poolId: string;
  runId: string;
  podUid: string;
  generation: number;
  tokenHash: string;
}
export function assertCapacityWorkerPermit(
  state: CapacityState,
  retired: CapacityRecord | undefined,
  permit: CapacityWorkerPermit,
) {
  const receipt = state.receipts.find(
    (value) => value.poolId === permit.poolId && value.runId === permit.runId,
  );
  if (
    retired !== undefined ||
    receipt === undefined ||
    receipt.state === 'retiring' ||
    receipt.tokenHash !== permit.tokenHash ||
    !receipt.worker?.active ||
    receipt.worker.generation !== permit.generation ||
    receipt.worker.podUid !== permit.podUid
  )
    throw new CapacityRefusal('worker');
}
export class CapacityRefusal extends Error {
  constructor(
    readonly reason:
      | 'policy'
      | 'inventory'
      | 'capacity'
      | 'producer'
      | 'stale'
      | 'authority'
      | 'worker'
      | 'physical'
      | 'retired'
      | 'bounds',
  ) {
    super(`Capacity protocol refused: ${reason}`);
  }
}
