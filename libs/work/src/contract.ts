import { oc } from '@orpc/contract';
import { openapi } from '@orpc/openapi';
import { z } from 'zod';

import { parseCron } from './cron';
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

/** `tick` accepts only a GitHub Actions OIDC bearer -- `work-auth.ts` never
 *  grants `work.cron` from a Google-authenticated principal, so declaring
 *  `bearerAuth` here too would document an operator token as valid when it
 *  is refused at runtime. This replaces (not adds to) `withBearer`'s
 *  `security`. */
const githubOidcSecurity = { security: [{ githubOidc: [] }] };
const withGithubOidc = <T extends object>(current: T) => ({
  ...current,
  ...githubOidcSecurity,
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
        // One status for one operation. A replay of the same id and spec
        // also answers 201, carrying the item that already exists rather
        // than starting a second run -- oRPC's OpenAPI codec resolves the
        // success status from this meta alone, so a handler cannot vary it
        // per call, and idempotency (one run per id) is the guarantee
        // worth stating, not a 200/201 distinction the client cannot act
        // on differently anyway.
        successStatus: 201,
        successDescription:
          'Created. A replay of the same id and spec returns the existing item.',
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
      // Redispatch mints a fresh run, so it re-checks the same two
      // capabilities `create` did -- the pipeline grant and control-plane
      // membership of the target repo -- against the grants and repository
      // list as they stand NOW, not as they stood when the item was
      // created. Declared here so the published document lists 403 for
      // this path.
      FORBIDDEN: {
        message: 'Principal may not request this pipeline or repository',
      },
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

/** A `cron` field is only accepted once it parses: `parseCron` throws on
 *  anything malformed, so a bad expression is refused at the API's input
 *  validation boundary (400) rather than reaching the store. */
const cronExpressionSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      try {
        parseCron(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid 5-field UTC cron expression' },
  );

const scheduleViewSchema = z.strictObject({
  id: workIdSchema,
  cron: z.string(),
  spec: workSpecSchema,
  enabled: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSlotAt: z.string().optional(),
  lastItemId: workIdSchema.optional(),
  disabledReason: z.enum(['grant-revoked', 'operator', 'invalid']).optional(),
});

const scheduleBase = oc.meta(
  openapi({ tags: ['schedules'], spec: withBearer }),
);

export const schedulesContract = {
  create: scheduleBase
    .meta(
      openapi({
        method: 'PUT',
        path: '/schedules/{id}',
        operationId: 'createSchedule',
        summary: 'Create a cron schedule (idempotent by client ULID)',
        successStatus: 201,
        successDescription:
          'Created. A replay of the same id, cron, and spec returns the existing schedule.',
      }),
    )
    .errors({
      FORBIDDEN: { message: 'Principal may not request this pipeline' },
      CONFLICT: {
        message: 'Schedule exists with a different cron or spec',
      },
      // Declared explicitly (rather than left to oRPC's automatic 400 on
      // a zod input-validation failure) so the generated OpenAPI document
      // lists 400 for this route -- see `contract.spec.ts`'s "documents
      // every status" test. The router's create handler (Task 5) also
      // throws this explicitly for the one case zod's `cronExpressionSchema`
      // cannot catch: a syntactically valid cron that never fires.
      BAD_REQUEST: { message: 'Malformed cron expression' },
    })
    .input(
      z.strictObject({
        id: workIdSchema,
        cron: cronExpressionSchema,
        spec: workSpecSchema,
        enabled: z.boolean().optional(),
      }),
    )
    .output(scheduleViewSchema),
  get: scheduleBase
    .meta(
      openapi({
        method: 'GET',
        path: '/schedules/{id}',
        operationId: 'getSchedule',
        summary: 'Read a cron schedule',
      }),
    )
    .errors({ NOT_FOUND: { message: 'No such schedule' } })
    .input(z.strictObject({ id: workIdSchema }))
    .output(scheduleViewSchema),
  list: scheduleBase
    .meta(
      openapi({
        method: 'GET',
        path: '/schedules',
        operationId: 'listSchedules',
        summary: 'List cron schedules',
      }),
    )
    .input(
      z.strictObject({
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    )
    .output(z.strictObject({ schedules: z.array(scheduleViewSchema) })),
  enable: scheduleBase
    .meta(
      openapi({
        method: 'POST',
        path: '/schedules/{id}/enable',
        operationId: 'enableSchedule',
        summary: 'Enable a cron schedule',
      }),
    )
    .errors({ NOT_FOUND: { message: 'No such schedule' } })
    .input(z.strictObject({ id: workIdSchema }))
    .output(scheduleViewSchema),
  disable: scheduleBase
    .meta(
      openapi({
        method: 'POST',
        path: '/schedules/{id}/disable',
        operationId: 'disableSchedule',
        summary: 'Disable a cron schedule',
      }),
    )
    .errors({ NOT_FOUND: { message: 'No such schedule' } })
    .input(z.strictObject({ id: workIdSchema }))
    .output(scheduleViewSchema),
  tick: scheduleBase
    .meta(
      openapi({
        method: 'POST',
        path: '/schedules/tick',
        operationId: 'tickSchedules',
        summary:
          "Mint items for every enabled schedule's latest due slot (GitHub Actions OIDC only)",
        // Distinct presentation from the rest of `schedules`: this route
        // has no human/service-account caller and a different security
        // scheme (see `withGithubOidc` below), so it also carries the
        // `cron` tag -- `openapi()`'s tags merge, so this becomes
        // `['schedules', 'cron']` alongside `scheduleBase`'s own tag.
        tags: ['cron'],
        spec: withGithubOidc,
      }),
    )
    .input(z.strictObject({}))
    .output(
      z.strictObject({
        ticked: z.number(),
        minted: z.array(
          z.strictObject({ scheduleId: workIdSchema, itemId: workIdSchema }),
        ),
        skippedCap: z.array(workIdSchema),
        disabled: z.array(workIdSchema),
        // One schedule's unexpected failure (a `mintItem` or store-write
        // rejection -- anything not already handled by `disabled` or
        // `skippedCap`) never aborts the rest of the tick; it lands here
        // instead so the caller (and its logs) can see which schedule and
        // why without the whole route failing closed.
        errors: z.array(
          z.strictObject({ scheduleId: workIdSchema, message: z.string() }),
        ),
      }),
    ),
};
export type SchedulesContract = typeof schedulesContract;
