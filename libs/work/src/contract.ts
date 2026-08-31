import { oc } from '@orpc/contract';
import { openapi } from '@orpc/openapi';
import { z } from 'zod';

import { parseCron } from './cron';
import {
  PIPELINES,
  WORK_TITLE_MAX,
  workOriginSchema,
  workSpecSchema,
  workTargetSchema,
} from './spec';

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
  queue: z
    .strictObject({
      state: z.enum(['queued', 'claimed']),
      claimedBy: z.string().optional(),
    })
    .optional(),
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
        description:
          'Pages over native items newest-first. A response carrying ' +
          '`nextCursor` may still have more behind it -- pass that value ' +
          'back as `cursor` to continue. `state`/`principal`/`repo` filter ' +
          'each page after it is read, so an empty `items` array with a ' +
          '`nextCursor` present means "none on this page", not "no more ' +
          'pages" -- keep paging until `nextCursor` is absent to see every ' +
          'matching item (issue #1546).',
      }),
    )
    .input(
      z.strictObject({
        state: itemStateSchema.optional(),
        principal: z.string().max(128).optional(),
        repo: z.string().max(256).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        // Additive (issue #1546): the previous `workId` page's *last* raw
        // native task, i.e. a prior response's `nextCursor`. Omitted, a
        // caller sees the first (newest) page exactly as before this
        // field existed -- an old client that never sends it is
        // unaffected.
        cursor: workIdSchema.optional(),
      }),
    )
    .output(
      z.strictObject({
        items: z.array(itemViewSchema),
        // Present only when more native tasks may exist behind this page
        // (see `description` above); absent means the underlying store is
        // exhausted, not that this page happened to come back non-empty.
        nextCursor: workIdSchema.optional(),
      }),
    ),
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
      CONFLICT: {
        message:
          'Only a parked item can be redispatched, or the named session has no archived transcript',
      },
      TOO_MANY_REQUESTS: {
        message: 'Fleet is at its live-run cap',
        data: z.object({ retryAfterSeconds: z.number() }),
      },
      // Sub-project 6: `resumeSessionId` names a session that either
      // doesn't exist, doesn't belong to a run of this item, or isn't a
      // claude-code session -- a malformed request, not a state conflict.
      BAD_REQUEST: {
        message:
          'resumeSessionId does not name a resumable session for this item',
      },
    })
    .input(
      z.strictObject({
        id: workIdSchema,
        // Session ids are opaque UUIDs from the agent CLI, not ULIDs --
        // bounded generously above any real id.
        resumeSessionId: z.string().min(1).max(256).optional(),
      }),
    )
    .output(itemViewSchema),
};
export type ItemsContract = typeof itemsContract;

/** A GitHub issue or pull request is one durable orchestrator task anchor.
 * Pull requests use GitHub's issue number, so no separate `type` selector is
 * needed at the Work API boundary. */
export const githubDispatchAnchorSchema = z.strictObject({
  repo: z
    .string()
    .max(140)
    .regex(/^[\w.-]+\/[\w.-]+$/u),
  issue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const githubDispatchModeSchema = z.enum(['implement', 'review']);

/** GitHub permits issue and pull-request bodies up to 65,536 characters.
 * GitHub-anchor dispatch accepts that complete caller shape, then the server
 * normalizes it into the smaller stored `workSpecSchema` budget. Native Work
 * item creation deliberately keeps its own stricter description bound. */
export const GITHUB_DISPATCH_DESCRIPTION_MAX = 65_536;

/** The ingress-only spec for a GitHub anchor. Title, pipeline, and target use
 * the ordinary Work constraints; description is intentionally wider and may
 * be empty because an empty GitHub body is valid. The route turns it into a
 * stored `WorkSpec` before grant checks or orchestrator storage. */
export const githubDispatchSpecSchema = z.strictObject({
  title: z.string().min(1).max(WORK_TITLE_MAX),
  description: z.string().max(GITHUB_DISPATCH_DESCRIPTION_MAX),
  pipeline: z.enum(PIPELINES),
  target: workTargetSchema,
});

/** One explicit response shape for the GitHub-anchor admission path. A
 * duplicate or busy result is a successful, actionable idempotency/mutex
 * answer rather than an HTTP failure: both name the existing durable run. */
const githubDispatchResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('accepted'),
    runId: z.string(),
    dispatched: z.boolean(),
  }),
  z.strictObject({ outcome: z.literal('duplicate'), runId: z.string() }),
  z.strictObject({ outcome: z.literal('busy'), runId: z.string() }),
]);

const dispatchBase = oc.meta(
  openapi({ tags: ['dispatches'], spec: withBearer }),
);

/**
 * Contract-first GitHub-anchor admission. The explicit Work spec means this
 * has the same stored Work payload and QueueExecutor brief as every other
 * Work API admission.
 */
export const dispatchesContract = {
  github: dispatchBase
    .meta(
      openapi({
        method: 'POST',
        path: '/dispatches/github',
        operationId: 'dispatchGithubAnchor',
        summary: 'Request a run for a GitHub issue or pull-request anchor',
      }),
    )
    .errors({
      FORBIDDEN: {
        message:
          'Principal may not request this pipeline, repository, or anchor',
      },
      BAD_REQUEST: {
        message: 'Anchor repository must equal the Work target repository',
      },
    })
    .input(
      z.strictObject({
        anchor: githubDispatchAnchorSchema,
        spec: githubDispatchSpecSchema,
        mode: githubDispatchModeSchema,
        reply: z.string().max(8_192).optional(),
        runbook: z.string().min(1).max(128).optional(),
        context: z.string().max(4_096).optional(),
        /** Caller-controlled idempotency key. A retry with this same value
         * receives the existing durable run instead of minting another. */
        requestId: z.string().min(1).max(128),
      }),
    )
    .output(githubDispatchResultSchema),
};
export type DispatchesContract = typeof dispatchesContract;

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
  // Optional, not required: a stored `spec` that no longer validates
  // (a schema tightened out from under an already-stored schedule, or a
  // hand-edited document -- the same case the tick handler's own
  // `workSpecSchema.parse` guards against) must not 500 `list`/`get`, or
  // block `enable`/`disable` on a schedule an operator needs to touch
  // precisely because it is broken. See `viewSafe` (`schedule-router.ts`).
  spec: workSpecSchema.optional(),
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
          "Mint items for every enabled schedule's latest due slot (work.cron required)",
        // The route remains visibly distinct from schedule CRUD: only a
        // Google-authenticated service principal with work.cron may tick it.
        // The ordinary bearer scheme is accurate because authorization is
        // the server-owned grant, not a GitHub workflow identity.
        tags: ['cron'],
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

/** A broker run id, owned and minted by the orchestrator. The orchestrator's
 * longest legal GitHub run ID is 175 characters (140-char owner/repository,
 * 16-digit issue, and 16-digit generation); keep this standalone contract
 * literal in sync without importing the storage-oriented orchestrator lib. */
const runIdSchema = z.string().min(1).max(175);

export const runClaimResponseSchema = z.strictObject({
  runId: runIdSchema,
  /** Present for native Work anchors only. */
  workId: workIdSchema.optional(),
  pipeline: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});

const runBriefSharedSchema = {
  pipeline: z.string(),
  /** The worker behavior requested at admission, never inferred from labels. */
  mode: z.string(),
  reply: z.string(),
  runbook: z.string(),
  context: z.string(),
  attemptId: z.string(),
  generation: z.number().int().positive(),
  intentId: z.string(),
  // Present iff the run's params carried a resume request. The same shape the
  // old hosted `work` input carried, so one provider adapter can consume it.
  resume: z
    .strictObject({
      sessionId: z.string(),
      transcriptGcsUri: z.string(),
    })
    .optional(),
};

/** Native Work preserves its existing top-level `id`/`spec` fields so an
 * already-deployed direct runner can consume the brief while the GitHub-anchor
 * branch rolls out. */
const nativeRunBriefSchema = z.strictObject({
  id: workIdSchema,
  spec: workSpecSchema,
  anchor: z.strictObject({
    type: z.literal('work'),
    id: workIdSchema,
    title: z.string(),
    body: z.string(),
    target_repo: z.string(),
    html_url: z.string(),
  }),
  ...runBriefSharedSchema,
});

/** GitHub issue and PR anchors carry the Work specification that every
 * QueueExecutor direct runner uses to prepare its dispatch. */
const githubRunBriefSchema = z.strictObject({
  anchor: z.strictObject({
    type: z.literal('github'),
    repo: z.string(),
    issue: z.number().int().positive(),
    html_url: z.string(),
  }),
  work: z.strictObject({ spec: workSpecSchema }),
  ...runBriefSharedSchema,
});

export const runBriefSchema = z.union([
  nativeRunBriefSchema,
  githubRunBriefSchema,
]);

/** `claim` is called by a runner authenticating with its own console
 *  bearer token (the same `bearerAuth` scheme `itemsContract` uses) --
 *  there is no run token yet, since claiming a run is what mints one. The
 *  other run routes are called by the runner presenting the token
 *  `claim` returned, hence the distinct `runToken` scheme. */
const runToken = { security: [{ runToken: [] }] };
const withRunToken = <T extends object>(current: T) => ({
  ...current,
  ...runToken,
});

const runBase = oc.meta(openapi({ tags: ['runs'] }));

export const runsContract = {
  claim: runBase
    .meta(
      openapi({
        method: 'POST',
        path: '/runs/claim',
        operationId: 'claimRun',
        summary:
          'Claim the oldest queued run allowed to the executor principal',
        successStatus: 200,
        spec: withBearer,
      }),
    )
    // oRPC's OpenAPI *doc generator* (unlike its runtime error encoder)
    // only documents a status for an error the contract names explicitly
    // -- it does not fall back to `COMMON_ERROR_STATUS_MAP` the way the
    // request-time handler does. `claim`'s 401 comes from the router-level
    // `executor` middleware (Task 7), which throws a bare
    // `ORPCError('UNAUTHORIZED')`; naming it here is what makes the
    // published document list 401 for this route at all.
    .errors({
      UNAUTHORIZED: { message: 'work.executor scope required' },
    })
    .input(
      z.strictObject({
        runner: z.string().min(1).max(256),
      }),
    )
    .output(runClaimResponseSchema.optional()),
  brief: runBase
    .meta(
      openapi({
        method: 'GET',
        path: '/runs/{runId}/brief',
        operationId: 'getRunBrief',
        summary: "Fetch a claimed run's dispatch brief",
        spec: withRunToken,
      }),
    )
    .errors({ UNAUTHORIZED: { message: 'Invalid or expired run token' } })
    .input(z.strictObject({ runId: runIdSchema }))
    .output(runBriefSchema),
  heartbeat: runBase
    .meta(
      openapi({
        method: 'POST',
        path: '/runs/{runId}/heartbeat',
        operationId: 'heartbeatRun',
        summary: "Renew a claimed run's lease",
        spec: withRunToken,
      }),
    )
    .errors({ UNAUTHORIZED: { message: 'Invalid or expired run token' } })
    .input(z.strictObject({ runId: runIdSchema }))
    .output(z.strictObject({ runId: runIdSchema, expiresAt: z.string() })),
  complete: runBase
    .meta(
      openapi({
        method: 'POST',
        path: '/runs/{runId}/complete',
        operationId: 'completeRun',
        summary: "Report a claimed run's outcome",
        spec: withRunToken,
      }),
    )
    .errors({ UNAUTHORIZED: { message: 'Invalid or expired run token' } })
    .input(
      z.strictObject({
        runId: runIdSchema,
        outcome: z.unknown(),
        outcomeReference: z.unknown().optional(),
      }),
    )
    .output(z.strictObject({ runId: runIdSchema, state: z.string() })),
  checkoutToken: runBase
    .meta(
      openapi({
        method: 'GET',
        path: '/runs/{runId}/checkout-token',
        operationId: 'getRunCheckoutToken',
        summary:
          "Mint a short-lived GitHub token for a claimed run's target repo",
        spec: withRunToken,
      }),
    )
    .errors({ UNAUTHORIZED: { message: 'Invalid or expired run token' } })
    .input(z.strictObject({ runId: runIdSchema }))
    .output(
      z.strictObject({
        token: z.string(),
        expiresAt: z.string(),
        repository: z.string(),
      }),
    ),
  codexAuth: runBase
    .meta(
      openapi({
        method: 'GET',
        path: '/runs/{runId}/codex-auth',
        operationId: 'getRunCodexAuth',
        summary:
          'Restore the centrally owned Codex lineage for an authorized run',
        spec: withRunToken,
      }),
    )
    .errors({
      UNAUTHORIZED: { message: 'Invalid, expired, or non-Codex run token' },
      NOT_FOUND: { message: 'Codex authentication is not seeded' },
      CONFLICT: { message: 'Codex subscription authentication is in use' },
      INTERNAL_SERVER_ERROR: {
        message: 'Codex authentication storage is unavailable',
      },
    })
    .input(z.strictObject({ runId: runIdSchema }))
    .output(
      z.strictObject({
        authBase64: z
          .string()
          .min(1)
          .max(512 * 1024),
        generation: z.string().regex(/^\d+$/u),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      }),
    ),
  persistCodexAuth: runBase
    .meta(
      openapi({
        method: 'PUT',
        path: '/runs/{runId}/codex-auth',
        operationId: 'persistRunCodexAuth',
        summary:
          "Persist an authorized Codex run's conditionally rotated central lineage",
        spec: withRunToken,
      }),
    )
    .errors({
      UNAUTHORIZED: { message: 'Invalid, expired, or non-Codex run token' },
      BAD_REQUEST: { message: 'Codex authentication payload is invalid' },
      CONFLICT: { message: 'Codex authentication was already rotated' },
      INTERNAL_SERVER_ERROR: {
        message: 'Codex authentication storage is unavailable',
      },
    })
    .input(
      z.strictObject({
        runId: runIdSchema,
        generation: z.string().regex(/^\d+$/u),
        restoredSha256: z.string().regex(/^[0-9a-f]{64}$/u),
        authBase64: z
          .string()
          .min(1)
          .max(512 * 1024),
        authFailure: z
          .enum([
            'access-token-refresh-failed',
            'refresh-token-reused',
            'codex-login-401',
          ])
          .optional(),
      }),
    )
    .output(
      z.strictObject({
        status: z.enum(['updated', 'unchanged', 'skipped-burned']),
      }),
    ),
};
export type RunsContract = typeof runsContract;
