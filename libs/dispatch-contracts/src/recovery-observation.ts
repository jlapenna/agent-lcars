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
 * operation idempotent. Two of them independently reinvented the same fix:
 * `pr-heal.yml` stores `attempts`/`last-head` in a hidden `pr-heal-ledger:v1`
 * comment keyed by PR head SHA; `post-deploy-verify.yml` stores a
 * `post-deploy-verify-dispatch:<sha>` marker keyed by the latest deployed
 * merge SHA. Both are already doing the right thing — keying on an exact
 * artifact identity, never an actor or a time window — just with two
 * independent, hand-rolled formats a third workflow could not reuse.
 *
 * This module is that shared format, published once so a future hosted
 * ingestion path (and, in the meantime, the consumer workflows themselves)
 * can agree on it instead of each re-deriving their own. It does not itself
 * ingest, store, or act on anything — see #864's migration plan for the
 * shadow-mode and cutover phases that come after this contract exists.
 */

/**
 * The delivery-lifecycle recovery domains #864 found duplicated across
 * consumer repositories. Deliberately excludes claim/dispatch/reconciliation
 * of the agent-dispatch signal itself — homelab's `agent-router.yml` and
 * `dispatch-reconcile.yml` are a forked pre-hosted-cutover copy of exactly
 * what `apps/dispatch-broker` already does in this repo (`controller`'s
 * `signal`/`authorization`/`intent`/`scheduling`/`launch`/`reconciliation`
 * phases in `failure.ts`), not a new domain — and excludes parking/retry
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

export type RecoveryDomain = (typeof RECOVERY_DOMAINS)[number];

const DOMAINS: ReadonlySet<string> = new Set(RECOVERY_DOMAINS);

export function isRecoveryDomain(value: unknown): value is RecoveryDomain {
  return typeof value === 'string' && DOMAINS.has(value);
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

export type RecoverySourceKind = (typeof RECOVERY_SOURCE_KINDS)[number];

const SOURCE_KINDS: ReadonlySet<string> = new Set(RECOVERY_SOURCE_KINDS);

export function isRecoverySourceKind(
  value: unknown,
): value is RecoverySourceKind {
  return typeof value === 'string' && SOURCE_KINDS.has(value);
}

/**
 * What a recovery operation is scoped to and what makes it idempotent.
 *
 * `exactIdentity` is the load-bearing field: it must be the exact fact that
 * makes reprocessing safe, never an actor or a time window (#864's own
 * required behavior). Concretely, per domain:
 *
 * - `ci_retry`: the exact run ID and run attempt (`run:<id>:<attempt>`) —
 *   GitHub's own `run_attempt` counter is already the only-once guard
 *   `rerun-infra-killed-runs` relies on; this just gives it a shared key.
 * - `pr_healing`: the PR number and its exact head SHA (`pr:<n>:<sha>`) —
 *   what `pr-heal.yml`'s own ledger already keys attempts on.
 * - `merge_follow_through` / `deployment_follow_through`: the exact merge or
 *   validated deploy-baseline SHA (`sha:<sha>`) — never `head_sha` alone,
 *   per the deployed-baseline marker note carried over from #2161.
 * - `post_deploy_verification`: the issue number and the latest deployed
 *   merge SHA that satisfies it (`issue:<n>:<sha>`) — what
 *   `post-deploy-verify.yml`'s own dispatch marker already keys on.
 *
 * This module does not enforce those per-domain shapes: the exact identity a
 * domain needs is that domain's own knowledge, not this shared package's.
 * What it enforces is that some non-empty, colon-free-at-the-boundary
 * identity is present at all, so `formatOperationKey`/`parseOperationKey`
 * round-trip losslessly.
 */
export interface RecoveryOperationTarget {
  domain: RecoveryDomain;
  repositoryId: number;
  /** `owner/name`. */
  repository: string;
  /** The issue or PR number the recovery action is scoped to. */
  anchor: number;
  exactIdentity: string;
}

const OPERATION_KEY_PREFIX = 'recovery/v1';

/**
 * Render a target's stable operation key.
 *
 * This is the idempotency key #864 requires be written "before producing the
 * side effect" — two observations of the same fact (a replayed webhook and a
 * scheduled sweep both seeing the same infra-killed run) render the identical
 * key, so a caller can de-duplicate by string equality alone rather than by
 * re-deriving meaning from actor/time-window heuristics.
 */
export function formatOperationKey(target: RecoveryOperationTarget): string {
  if (!isRecoveryDomain(target.domain)) {
    throw new Error(`Unknown recovery domain: ${String(target.domain)}`);
  }
  if (!Number.isSafeInteger(target.repositoryId) || target.repositoryId < 0) {
    throw new Error(`Invalid repositoryId: ${String(target.repositoryId)}`);
  }
  if (!Number.isSafeInteger(target.anchor) || target.anchor < 0) {
    throw new Error(`Invalid anchor: ${String(target.anchor)}`);
  }
  if (typeof target.exactIdentity !== 'string' || target.exactIdentity === '') {
    throw new Error('exactIdentity must be a non-empty string');
  }
  return [
    OPERATION_KEY_PREFIX,
    target.domain,
    String(target.repositoryId),
    String(target.anchor),
    target.exactIdentity,
  ].join(':');
}

const OPERATION_KEY_RE = /^recovery\/v1:([a-z_]+):(\d+):(\d+):(.+)$/u;

/**
 * Recover the target an operation key names, re-validating the domain
 * against the closed vocabulary rather than trusting the string. A key read
 * back from durable storage did not necessarily come from
 * `formatOperationKey` — see `isWellFormedFailureClassification`'s header for
 * why parsed data is never trusted just because it parses.
 */
export function parseOperationKey(
  value: string | undefined | null,
): RecoveryOperationTarget | undefined {
  const match = value?.match(OPERATION_KEY_RE);
  if (!match) return undefined;
  const [, domain, repositoryId, anchor, exactIdentity] = match;
  if (!isRecoveryDomain(domain)) return undefined;
  return {
    domain,
    repositoryId: Number(repositoryId),
    repository: '',
    anchor: Number(anchor),
    exactIdentity,
  };
}

/**
 * A normalized recovery observation: one system's evidence that a recovery
 * fact is true, independent of how many times or by which transport it was
 * observed. Modeled on #645's `SignalEnvelope` (source ID, actor, action,
 * target, evidence, observed time), scoped to the delivery-lifecycle domains
 * this module covers.
 *
 * `operationKey` is always `formatOperationKey(target)` — the two fields
 * cannot disagree, the same guarantee `formatAttemptId`/`AttemptMarker` give
 * the agent-dispatch lifecycle in `marker.ts`. Use `buildRecoveryObservation`
 * rather than constructing this object literally, so that guarantee holds by
 * construction instead of by caller discipline.
 */
export interface RecoveryObservation {
  operationKey: string;
  target: RecoveryOperationTarget;
  sourceKind: RecoverySourceKind;
  /** ISO-8601 timestamp of when this observation was made — not when the
   *  underlying fact occurred, which `evidence` may separately carry. */
  observedAt: string;
  /** Human-checkable proof: a run URL, a delivery UUID, a comment URL. Never
   *  parsed as a decision input — only the target's `exactIdentity` is. */
  evidence: string;
  detail?: string;
}

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
  if (!isRecoverySourceKind(sourceKind)) {
    throw new Error(`Unknown recovery source kind: ${String(sourceKind)}`);
  }
  if (typeof observedAt !== 'string' || observedAt === '') {
    throw new Error('observedAt must be a non-empty ISO-8601 string');
  }
  if (typeof evidence !== 'string' || evidence === '') {
    throw new Error('evidence must be a non-empty string');
  }
  return {
    operationKey: formatOperationKey(target),
    target,
    sourceKind,
    observedAt,
    evidence,
    ...(detail === undefined ? {} : { detail }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether an arbitrary parsed value is a `RecoveryObservation` worth
 * trusting — same posture as this package's other `isWellFormedX`
 * functions: re-validate every field against the closed vocabulary rather
 * than assuming a value that merely has the right shape came from
 * `buildRecoveryObservation`.
 */
export function isWellFormedRecoveryObservation(
  value: unknown,
): value is RecoveryObservation {
  if (!isPlainObject(value)) return false;
  const target = value.target;
  if (!isPlainObject(target)) return false;
  if (!isRecoveryDomain(target.domain)) return false;
  if (
    !Number.isSafeInteger(target.repositoryId) ||
    (target.repositoryId as number) < 0
  ) {
    return false;
  }
  if (typeof target.repository !== 'string') return false;
  if (!Number.isSafeInteger(target.anchor) || (target.anchor as number) < 0) {
    return false;
  }
  if (typeof target.exactIdentity !== 'string' || target.exactIdentity === '') {
    return false;
  }
  let expectedKey: string;
  try {
    expectedKey = formatOperationKey(
      target as unknown as RecoveryOperationTarget,
    );
  } catch {
    return false;
  }
  if (value.operationKey !== expectedKey) return false;
  if (!isRecoverySourceKind(value.sourceKind)) return false;
  if (typeof value.observedAt !== 'string' || value.observedAt === '') {
    return false;
  }
  if (typeof value.evidence !== 'string' || value.evidence === '') {
    return false;
  }
  if (value.detail !== undefined && typeof value.detail !== 'string') {
    return false;
  }
  return true;
}
