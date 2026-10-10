import { oc } from '@orpc/contract';
import { openapi } from '@orpc/openapi';
import { z } from 'zod';

const id = z.string().min(1).max(175);
const metricId = id.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/u);
const nonce = z.string().min(16).max(128);
const natural = z.number().int().nonnegative();
export const capacityFenceSchema = z.strictObject({
  poolId: id,
  slot: natural,
  revision: natural,
  runId: id,
  nonce,
});
const recover = { fence: capacityFenceSchema, recoveryNonce: nonce };
export const capacityPolicyInputSchema = z.strictObject({
  poolId: metricId,
  cluster: id,
  namespace: id,
  version: z.number().int().positive(),
  maxConcurrent: z.number().int().min(1).max(128),
  maxUnplaced: z.literal(1),
  enforced: z.boolean(),
  inventoryKnown: z.boolean(),
  domains: z.record(
    id,
    z.strictObject({
      domainId: metricId,
      ceiling: z.number().int().min(1).max(128),
    }),
  ),
});
export const capacityCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('register'), producerId: id }),
  z.strictObject({
    action: z.literal('configure'),
    policy: capacityPolicyInputSchema,
  }),
  z.strictObject({
    action: z.literal('recover'),
    purpose: z.enum(['recover', 'retire']).optional(),
    fence: capacityFenceSchema,
    recoveryNonce: nonce,
  }),
  z.strictObject({
    action: z.literal('authorize-producer'),
    ...recover,
    producerId: id,
  }),
  z.strictObject({
    action: z.literal('bind'),
    ...recover,
    jobUid: id,
    jobName: id,
    podUid: id.optional(),
    secretUid: id.optional(),
    secretTokenHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    placed: z.boolean(),
    deleting: z.boolean(),
    owned: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('attest'),
    ...recover,
    jobUid: id,
    podUid: id,
    generation: z.number().int().positive(),
    owned: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('worker-retired'),
    ...recover,
    generation: z.number().int().positive(),
    podUid: id,
    evidence: id,
  }),
  z.strictObject({
    action: z.literal('operation'),
    ...recover,
    producerId: id,
    operationId: id,
    resolved: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('stop-producer'),
    fence: capacityFenceSchema,
    producerId: id,
    producerSubject: id,
    fenced: z.boolean(),
    evidence: id,
  }),
  z.strictObject({ action: z.literal('retire'), ...recover }),
  z.strictObject({
    action: z.literal('release'),
    ...recover,
    barrierUid: id,
    barrierRunId: id,
    barrierNonce: nonce,
    resourceVersion: id,
    jobName: id,
    evidence: id,
    inert: z.boolean(),
    physicalWorkersEnded: z.boolean(),
    neverStarted: z.boolean(),
    originalJobUid: id.optional(),
  }),
  z.strictObject({
    action: z.literal('resolve-retired-write'),
    runId: id,
    nonce,
    barrierUid: id,
    operationId: id,
    producerId: id,
    producerSubject: id,
    evidence: id,
  }),
  z.strictObject({
    action: z.literal('import'),
    dryRun: z.boolean(),
    reviewedDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    known: z.boolean(),
    evidence: id,
    inventory: z
      .array(
        z.strictObject({
          runId: id,
          observedAt: z.iso.datetime(),
          pipeline: id,
          slot: natural,
          revision: z.number().int().positive(),
          nonce,
          producerId: id,
          producerSubject: id,
          runner: id,
          jobUid: id.optional(),
          secretUid: id.optional(),
          unplaced: z.boolean(),
          pendingWrites: z.array(id).max(32),
        }),
      )
      .max(128),
  }),
]);

export const capacityClaimResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('claim'),
    receipt: capacityFenceSchema,
    runId: id,
    pipeline: id,
    token: z.string(),
    expiresAt: z.string(),
    jobName: id,
  }),
  z.strictObject({
    kind: z.literal('recover-owned-secret'),
    receipt: capacityFenceSchema,
    runId: id,
    jobName: id,
    jobUid: id.optional(),
    secretUid: id,
  }),
  z.strictObject({
    kind: z.literal('quarantined-unrecoverable-token'),
    receipt: capacityFenceSchema.optional(),
    runId: id,
    jobName: id,
  }),
  z.strictObject({
    kind: z.literal('wait'),
    reason: z.enum(['queue', 'capacity']),
  }),
]);

export const capacityContract = oc
  .meta(
    openapi({
      tags: ['capacity'],
      spec: (current) => ({ ...current, security: [{ bearerAuth: [] }] }),
    }),
  )
  .meta(
    openapi({
      method: 'POST',
      path: '/runs/capacity',
      operationId: 'changeCapacity',
      summary: 'Receipt lifecycle under separately granted capacity authority',
    }),
  )
  .errors({
    UNAUTHORIZED: { message: 'Capacity authority required' },
    CONFLICT: { message: 'Capacity protocol refused' },
  })
  .input(capacityCommandSchema)
  .output(
    z.strictObject({
      ok: z.boolean(),
      receipt: capacityFenceSchema.optional(),
      jobName: id.optional(),
      released: z.boolean().optional(),
      retainBarrier: z.boolean().optional(),
      digest: z.string().optional(),
      inventoryKnown: z.boolean().optional(),
      missingRunIds: z.array(id).optional(),
      imported: natural.optional(),
      revision: natural.optional(),
    }),
  );

export const activationContract = oc
  .meta(openapi({ tags: ['capacity'] }))
  .meta(
    openapi({
      method: 'POST',
      path: '/runs/activate',
      operationId: 'activateWorker',
      summary:
        'Activate an attested worker using a bound Kubernetes workload identity',
      spec: (current) => ({
        ...current,
        security: [{ runToken: [], capacityWorkerIdentity: [] }],
      }),
    }),
  )
  .errors({
    UNAUTHORIZED: { message: 'Bound worker identity required' },
    CONFLICT: { message: 'Capacity protocol refused' },
  })
  .input(z.strictObject({ fence: capacityFenceSchema, jobUid: id }))
  .output(z.strictObject({ generation: z.number().int().positive() }));

export const capacityMetricsContract = oc
  .meta(
    openapi({
      tags: ['capacity'],
      spec: (current) => ({
        ...current,
        security: [{ bearerAuth: [] }],
        responses: {
          ...current.responses,
          '200': {
            description: 'Prometheus exposition',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      }),
    }),
  )
  .meta(
    openapi({
      method: 'GET',
      path: '/runs/capacity/metrics',
      operationId: 'getCapacityMetrics',
      summary: 'Bounded authenticated capacity metrics',
    }),
  )
  .errors({
    UNAUTHORIZED: { message: 'Capacity inventory authority required' },
  })
  .input(z.strictObject({}))
  .output(z.string());

const inventoryReceiptSchema = capacityFenceSchema.extend({
  domainId: id,
  pipeline: id,
  subject: id,
  runner: id,
  producerId: id,
  claimedAt: z.iso.datetime(),
  state: z.enum(['unplaced', 'placed', 'quarantined', 'retiring']),
  unplaced: z.boolean(),
  jobUid: id.optional(),
  secretUid: id.optional(),
  jobName: id,
  worker: z
    .strictObject({
      generation: z.number().int().positive(),
      podUid: id,
      jobUid: id,
      active: z.boolean(),
      retiredEvidence: id.optional(),
    })
    .optional(),
  retiredWorkers: z
    .array(
      z.strictObject({
        podUid: id,
        generation: z.number().int().positive(),
        evidence: id,
      }),
    )
    .max(32),
  attestedPod: z
    .strictObject({
      podUid: id,
      jobUid: id,
      generation: z.number().int().positive(),
    })
    .optional(),
  recovery: z
    .strictObject({ subject: id, nonce, expiresAt: z.iso.datetime() })
    .optional(),
  producers: z
    .array(
      z.strictObject({
        producerId: id,
        subject: id,
        stopped: z.boolean(),
        fenced: z.boolean(),
        pendingWrites: z.array(id).max(32),
      }),
    )
    .min(1)
    .max(8),
  barrier: z
    .strictObject({ uid: id, resourceVersion: id, evidence: id })
    .optional(),
});
export const capacityInventoryContract = oc
  .meta(
    openapi({
      tags: ['capacity'],
      spec: (current) => ({ ...current, security: [{ bearerAuth: [] }] }),
    }),
  )
  .meta(
    openapi({
      method: 'GET',
      path: '/runs/capacity',
      operationId: 'getCapacityInventory',
      summary: 'Bounded redacted inventory for the server-granted pool',
    }),
  )
  .errors({
    UNAUTHORIZED: { message: 'Capacity inventory authority required' },
  })
  .input(z.strictObject({}))
  .output(
    z.strictObject({
      revision: natural,
      policy: capacityPolicyInputSchema.optional(),
      receipts: z.array(inventoryReceiptSchema).max(128),
    }),
  );
