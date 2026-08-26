import { oc } from '@orpc/contract';
import { openapi } from '@orpc/openapi';
import { z } from 'zod';

import { workOriginSchema, workSpecSchema } from './spec';

/**
 * Crockford base32, 26 characters: a ULID. Excludes I, L, O, U.
 *
 * Kept as a literal here (rather than imported from
 * `@agent-lcars/orchestrator`) so this module — and everything that only
 * needs the contract, like a future CLI bundle — never pulls in the
 * orchestrator's Firestore store. `contract.spec.ts` pins this equal to the
 * orchestrator's own `WORK_ID_RE` via a test-only import.
 */
export const WORK_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export const workIdSchema = z.string().regex(WORK_ID_PATTERN);

const runResultSchema = z.strictObject({
  ok: z.boolean(),
  summary: z.string().max(4_096).optional(),
  ref: z.string().max(1_024).optional(),
});

export const itemRunViewSchema = z.strictObject({
  runId: z.string(),
  state: z.enum(['pending', 'running', 'finished', 'canceled', 'lost']),
  pipeline: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  result: runResultSchema.optional(),
});

export const itemSessionViewSchema = z.strictObject({
  sessionId: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  title: z.string().optional(),
  status: z.string().optional(),
  transcriptGcsUri: z.string().optional(),
});

export const itemStateSchema = z.enum([
  'running',
  'done',
  'parked',
  'canceled',
]);

export const itemViewSchema = z.strictObject({
  id: workIdSchema,
  state: itemStateSchema,
  spec: workSpecSchema,
  origin: workOriginSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
  runs: z.array(itemRunViewSchema),
  sessions: z.array(itemSessionViewSchema),
});

const bearer = { security: [{ bearerAuth: [] }] };
const withBearer = <T extends object>(current: T) => ({
  ...current,
  ...bearer,
});

const base = oc.meta(openapi({ tags: ['items'], spec: withBearer }));

export const itemsContract = {
  create: base
    .meta(
      openapi({
        method: 'PUT',
        path: '/items/{id}',
        operationId: 'createItem',
        summary: 'Create a work item (idempotent by client ULID)',
      }),
    )
    .errors({
      FORBIDDEN: { message: 'Principal may not request this pipeline' },
      TOO_MANY_REQUESTS: {
        message: 'Fleet is at its live-run cap',
        data: z.object({ retryAfterSeconds: z.number() }),
      },
      CONFLICT: { message: 'Item exists with a different spec' },
    })
    .input(z.strictObject({ id: workIdSchema, spec: workSpecSchema }))
    .output(itemViewSchema),
  get: base
    .meta(
      openapi({
        method: 'GET',
        path: '/items/{id}',
        operationId: 'getItem',
        summary: 'Read a work item',
      }),
    )
    .errors({ NOT_FOUND: { message: 'No such item' } })
    .input(z.strictObject({ id: workIdSchema }))
    .output(itemViewSchema),
  list: base
    .meta(
      openapi({
        method: 'GET',
        path: '/items',
        operationId: 'listItems',
        summary: 'List work items',
      }),
    )
    .input(
      z.strictObject({
        state: itemStateSchema.optional(),
        principal: z.string().max(128).optional(),
        repo: z.string().max(256).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    )
    .output(z.strictObject({ items: z.array(itemViewSchema) })),
  cancel: base
    .meta(
      openapi({
        method: 'POST',
        path: '/items/{id}/cancel',
        operationId: 'cancelItem',
        summary: 'Cancel a work item',
      }),
    )
    .errors({
      NOT_FOUND: { message: 'No such item' },
      CONFLICT: { message: 'Item already settled' },
    })
    .input(z.strictObject({ id: workIdSchema }))
    .output(itemViewSchema),
  redispatch: base
    .meta(
      openapi({
        method: 'POST',
        path: '/items/{id}/redispatch',
        operationId: 'redispatchItem',
        summary: 'Mint a fresh run for a parked item',
      }),
    )
    .errors({
      NOT_FOUND: { message: 'No such item' },
      CONFLICT: { message: 'Only a parked item can be redispatched' },
      TOO_MANY_REQUESTS: {
        message: 'Fleet is at its live-run cap',
        data: z.object({ retryAfterSeconds: z.number() }),
      },
    })
    .input(z.strictObject({ id: workIdSchema }))
    .output(itemViewSchema),
};
export type ItemsContract = typeof itemsContract;
