/**
 * Normalized recovery observations and stable operation keys for the
 * consumer-repository delivery lifecycle: CI retry, PR healing, merge
 * follow-through, deployment follow-through, and post-deploy verification.
 *
 * [#645](https://github.com/jlapenna/agent-lcars/issues/645) built five
 * systems for the *agent dispatch* lifecycle (signal through projection) and
 * this package already publishes that vocabulary (`failure.ts`'s
 * `OwningSystem`/`FailurePhase`, `ledger.ts`'s `LedgerTaskRef`). It does not
 * cover what happens to a PR *after* an agent (or a human) opens it: whether
 * its CI got infra-killed, whether a failing check needs an auto-heal
 * attempt, whether a `GITHUB_TOKEN`-created merge needs its suppressed
 * `workflow_run` chain bridged back to deploy, and whether a shipped fix
 * still needs its post-deploy verification dispatched.
 *
 * [#864](https://github.com/jlapenna/agent-lcars/issues/864) found that every
 * consumer repository re-solved that second lifecycle independently —
 * `supersprinklesracing/sprinkles` and `jlapenna/homelab` each carry their own
 * `ci-auto-rerun.yml`, `pr-heal.yml`, `post-deploy-verify.yml` and similar,
 * roughly 1,590 lines total, none sharing a definition of what makes an
 * operation idempotent.
 *
 * This module is that shared format, published once so the hosted ingestion
 * path (and the consumer workflows themselves) can agree on it instead of
 * each re-deriving their own. Validation is zod schemas (#884): each wire
 * type is defined once as a schema and its TypeScript type inferred from it,
 * so the validator and the type can never drift apart.
 */

import { z } from 'zod';

/**
 * The delivery-lifecycle recovery domains #864 found duplicated across
 * consumer repositories. Deliberately excludes claim/dispatch/reconciliation
 * of the agent-dispatch signal itself, and excludes parking/retry
 * exhaustion, which are dispositions of a domain's outcome
 * (`RetryDisposition`/`needsMaintainer` in `failure.ts`), not domains of
 * their own.
 */
export const RECOVERY_DOMAINS = [
  /** A CI run was cancelled under capacity pressure or killed at the
   *  infrastructure level (every step's own conclusion `null`) and needs a
   *  bounded, exactly-once rerun. */
  'ci_retry',
  /** A PR's required checks failed and needs a bounded, exactly-once
   *  diagnose-and-repair agent dispatch. */
  'pr_healing',
  /** A `GITHUB_TOKEN`-created merge cannot emit the downstream `workflow_run`
   *  event the next stage depends on, and needs that chain bridged. */
  'merge_follow_through',
  /** A `GITHUB_TOKEN`-restored CI success needs the deploy workflow bridged
   *  the same way. */
  'deployment_follow_through',
  /** A shipped fix needs its recorded post-deploy verification steps
   *  dispatched exactly once per deployed commit. */
  'post_deploy_verification',
] as const;

export const recoveryDomainSchema = z.enum(RECOVERY_DOMAINS);
export type RecoveryDomain = z.infer<typeof recoveryDomainSchema>;

export function isRecoveryDomain(value: unknown): value is RecoveryDomain {
  return recoveryDomainSchema.safeParse(value).success;
}

/**
 * How an observation reached the reconciler. #864 requires that "webhook
 * replay, scheduled reconciliation, API polling, and operator requests may
 * all observe the same fact without duplicating its side effect" — this is
 * the closed vocabulary for "how", so the operation key (below) can be the
 * closed vocabulary for "which side effect", independently of source.
 */
export const RECOVERY_SOURCE_KINDS = [
  'webhook',
  'schedule',
  'poll',
  'operator',
] as const;

export const recoverySourceKindSchema = z.enum(RECOVERY_SOURCE_KINDS);
export type RecoverySourceKind = z.infer<typeof recoverySourceKindSchema>;

export function isRecoverySourceKind(
  value: unknown,
): value is RecoverySourceKind {
  return recoverySourceKindSchema.safeParse(value).success;
}

const nonNegativeSafeInteger = z.number().int().nonnegative().safe();

/**
 * What a recovery operation is scoped to and what makes it idempotent.
 *
 * `exactIdentity` is the load-bearing field: it must be the exact fact that
 * makes reprocessing safe, never an actor or a time window (#864's own
 * required behavior). Concretely, per domain:
 *
 * - `ci_retry`: the exact run ID and run attempt (`run:<id>:<attempt>`).
 * - `pr_healing`: the PR number and its exact head SHA (`pr:<n>:<sha>`).
 * - `merge_follow_through` / `deployment_follow_through`: the exact merge or
 *   validated deploy-baseline SHA (`sha:<sha>`).
 * - `post_deploy_verification`: the issue number and the latest deployed
 *   merge SHA that satisfies it (`issue:<n>:<sha>`).
 *
 * This module does not enforce those per-domain shapes: the exact identity a
 * domain needs is that domain's own knowledge, not this shared package's.
 * What it enforces is that some non-empty identity is present at all, in
 * canonical form, so `formatOperationKey`/`parseOperationKey` round-trip
 * losslessly for every field except `repository` — see
 * `ParsedRecoveryOperationKey`.
 */
export const recoveryOperationTargetSchema = z.object({
  domain: recoveryDomainSchema,
  repositoryId: nonNegativeSafeInteger,
  /** `owner/name`. Not itself part of the operation key string (only the
   *  rename-proof `repositoryId` is) — see `ParsedRecoveryOperationKey`. */
  repository: z.string(),
  /** The issue or PR number the recovery action is scoped to. */
  anchor: nonNegativeSafeInteger,
  exactIdentity: z.string().min(1),
});
export type RecoveryOperationTarget = z.infer<
  typeof recoveryOperationTargetSchema
>;

const OPERATION_KEY_PREFIX = 'recovery/v1';

/**
 * Render a target's stable operation key.
 *
 * This is the idempotency key #864 requires be written "before producing the
 * side effect" — two observations of the same fact render the identical
 * key, so a caller can de-duplicate by string equality alone rather than by
 * re-deriving meaning from actor/time-window heuristics.
 */
export function formatOperationKey(target: RecoveryOperationTarget): string {
  const parsed = recoveryOperationTargetSchema.parse(target);
  return [
    OPERATION_KEY_PREFIX,
    parsed.domain,
    String(parsed.repositoryId),
    String(parsed.anchor),
    parsed.exactIdentity,
  ].join(':');
}

const OPERATION_KEY_RE =
  /^recovery\/v1:([a-z_]+):(0|[1-9]\d*):(0|[1-9]\d*):(.+)$/u;

/**
 * Parse a canonical non-negative integer component of an operation key.
 *
 * The regex above already rejects a leading-zero string like `01`, but not
 * one that is syntactically canonical yet outside `Number.isSafeInteger` —
 * `9007199254740993` parses as a canonical decimal literal and `Number()`
 * silently rounds it to `9007199254740992`, so the parsed value would no
 * longer identify the same repository or anchor the stored key named. Both
 * checks are required: canonical form catches leading zeros, safe-integer
 * range catches silent rounding.
 */
function parseCanonicalNonNegativeInteger(digits: string): number | undefined {
  const value = Number(digits);
  return nonNegativeSafeInteger.safeParse(value).success ? value : undefined;
}

/**
 * What `parseOperationKey` can recover from the key string alone: everything
 * in `RecoveryOperationTarget` except `repository`. The key deliberately
 * encodes only the rename-proof `repositoryId` (the same choice
 * `LedgerTaskRef` makes) — the `owner/name` slug is never part of the string,
 * so a parser has no source to recover it from; requiring callers to resolve
 * or attach the slug themselves surfaces that as a compile error instead of
 * an empty-slug runtime failure.
 */
export type ParsedRecoveryOperationKey = Omit<
  RecoveryOperationTarget,
  'repository'
>;

/**
 * Recover the target an operation key names, re-validating the domain and
 * both numeric components against canonical form rather than trusting the
 * string. A key read back from durable storage did not necessarily come from
 * `formatOperationKey`.
 */
export function parseOperationKey(
  value: string | undefined | null,
): ParsedRecoveryOperationKey | undefined {
  const match = value?.match(OPERATION_KEY_RE);
  if (!match) return undefined;
  const [, domain, repositoryIdText, anchorText, exactIdentity] = match;
  if (!isRecoveryDomain(domain)) return undefined;
  const repositoryId = parseCanonicalNonNegativeInteger(repositoryIdText);
  const anchor = parseCanonicalNonNegativeInteger(anchorText);
  if (repositoryId === undefined || anchor === undefined) return undefined;
  return { domain, repositoryId, anchor, exactIdentity };
}

/**
 * A normalized recovery observation: one system's evidence that a recovery
 * fact is true, independent of how many times or by which transport it was
 * observed.
 *
 * `operationKey` is always `formatOperationKey(target)` — the two fields
 * cannot disagree; the schema's `check` re-derives the key from the target
 * and rejects any value where they differ. Use `buildRecoveryObservation`
 * rather than constructing this object literally.
 */
export const recoveryObservationSchema = z
  .object({
    operationKey: z.string(),
    target: recoveryOperationTargetSchema,
    sourceKind: recoverySourceKindSchema,
    /** ISO-8601 timestamp of when this observation was made — not when the
     *  underlying fact occurred, which `evidence` may separately carry. */
    observedAt: z.string().min(1),
    /** Human-checkable proof: a run URL, a delivery UUID, a comment URL.
     *  Never parsed as a decision input — only `exactIdentity` is. */
    evidence: z.string().min(1),
    detail: z.string().optional(),
  })
  .check((ctx) => {
    if (ctx.value.operationKey !== formatOperationKey(ctx.value.target)) {
      ctx.issues.push({
        code: 'custom',
        message: 'operationKey does not match formatOperationKey(target)',
        input: ctx.value.operationKey,
        path: ['operationKey'],
      });
    }
  });
export type RecoveryObservation = z.infer<typeof recoveryObservationSchema>;

/**
 * Build a well-formed observation, deriving `operationKey` from `target`
 * rather than accepting it as a separate argument.
 */
export function buildRecoveryObservation({
  target,
  sourceKind,
  observedAt,
  evidence,
  detail,
}: {
  target: RecoveryOperationTarget;
  sourceKind: RecoverySourceKind;
  observedAt: string;
  evidence: string;
  detail?: string;
}): RecoveryObservation {
  return recoveryObservationSchema.parse({
    operationKey: formatOperationKey(target),
    target,
    sourceKind,
    observedAt,
    evidence,
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * Whether an arbitrary parsed value is a `RecoveryObservation` worth
 * trusting — re-validates every field against the closed vocabulary via the
 * schema rather than assuming a value that merely has the right shape came
 * from `buildRecoveryObservation`.
 */
export function isWellFormedRecoveryObservation(
  value: unknown,
): value is RecoveryObservation {
  return recoveryObservationSchema.safeParse(value).success;
}
