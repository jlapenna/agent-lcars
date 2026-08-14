# Lifecycle Control Plane v1 design

Issue [#1019](https://github.com/jlapenna/agent-lcars/issues/1019) defines a
purpose-built cross-repository **Lifecycle Control Plane** for the constrained
`Signal → Task → Intent → Attempt → Outcome` lifecycle. It is not a generic
workflow/evidence graph or a publishing of this repository's
`dispatch-broker` Action.

The target control plane owns generic signal deduplication, task state,
authorization-policy evaluation, ordering/supersession, desired intent,
attempt admission/retry/parking intent, launch, binding, credential grants,
terminalization, and convergence. Central GitHub App webhook ingress,
registered/versioned tenant policy, and GitHub projection live with that control
plane. Client repositories retain only thin Actions execution adapters,
optional non-authorizing configuration, and irreducibly repository-specific
provider commands. A repository-local ingress or projector is
migration/fallback only. Existing local brokers are migration adapters/producers
and eventual deletion targets, not permanent authority. GitHub Actions reports
facts and does not own lifecycle retry, parking, or outcome.

This design authorizes no service, storage technology, database schema, App
installation, permission, IAM rule, secret, workflow, or deployment.

Generic post-merge recovery (CI retry, PR healing, deployment follow-through,
and post-deploy verification) remains outside this core unless a later reviewed
contract explicitly models it. This control plane owns only the dispatch
lifecycle named in its state machine.

## Scope and stable identity

The current `g<generation>:<intentId>` is retained as a **local attempt
marker/correlation key**. It is unique only within a repository-local task
aggregate, so it must never be promoted to a globally routable service ID. The
service mints opaque route-safe `attemptId` with at least 128 bits of CSPRNG
entropy (canonical unpadded base64url). Run titles and artifact markers retain
the local marker for `formatDispatchMarker`/`formatClaimMarker` compatibility;
service routes/events use the minted ID and verify its accepted local marker.

| Identity                                  | Scope          | Rule                                                                                                                     |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tenantId`                                | service        | opaque partition key                                                                                                     |
| `repositoryId`                            | tenant         | immutable GitHub numeric identity; tenant selector                                                                       |
| `repository`                              | display        | verified mutable `owner/name` metadata                                                                                   |
| canonical task                            | tenant/repo    | `(tenantId, repositoryId, issueNumber)` only; a PR is observed metadata/policy input, never a second aggregate namespace |
| `localIntentId`, generation, local marker | local task     | controller correlation and visible marker                                                                                |
| `attemptId`                               | service-global | server minted; never caller selected                                                                                     |
| `runBinding`                              | attempt        | exact run/run-attempt/check-run/workflow identity                                                                        |
| `launchOperationId`                       | attempt        | exactly `attemptId`; one durable outbox operation                                                                        |

A **task lease** is the short controller serialization lease held inside one
Lifecycle Control Plane task aggregate. A **CredentialGrant** is a distinct
short-lived GitHub installation token issued for one bound worker. It is a
grant, not a lease, because v1 cannot revoke it or control GitHub's expiry.
Neither is a bearer substitute for the other.

## Authority and tenancy

| Fact/effect                                    | Sole owner                        | Reporter/reader                          | Rule                                         |
| ---------------------------------------------- | --------------------------------- | ---------------------------------------- | -------------------------------------------- |
| authenticated raw ingress                      | central GitHub App adapter        | control plane consumes normalized signal | repo ingress is migration/fallback only      |
| registered policy and authorization evaluation | Lifecycle Control Plane           | tenant registration tooling              | policy is versioned and immutable            |
| signal dedup, ordering, intent, admission      | Lifecycle Control Plane           | ingress adapter                          | generic semantics centralized                |
| service ID, task/spec, FSM/event order         | Lifecycle Control Plane           | adapters                                 | service mints ID after idempotent acceptance |
| launch/outbox/run binding                      | Lifecycle Control Plane           | Actions reports run facts                | outbox precedes dispatch                     |
| runtime/heartbeat/result claim                 | Actions adapter                   | service consumes untrusted observation   | never outcome authority                      |
| credential profile, mint/renew                 | Lifecycle Control Plane           | adapter receives issued token            | server-held App credential                   |
| exact validation and immutable outcome         | Lifecycle Control Plane finalizer | GitHub APIs/adapter facts                | no self-certification                        |
| GitHub/console projection/callback application | central GitHub provider adapter   | optional local adapter during migration  | divergence cannot change outcome             |
| runner capacity/lifecycle                      | runner platform                   | controller/service observes              | not service storage                          |

A tenant is registered as `(tenantId, repositoryId, GitHub App installation)`.
All records, authorization, idempotency, outbox scans, audit queries, metrics,
and support views are tenant-filtered. A slug alone is never a request
selector. A rename updates verified display metadata only and cannot create a
tenant or move records.

Each tenant has a centrally registered immutable policy record
`{ policyId, version, contentSha }`, which pins installation ID, exact
workflows, immutable workflow SHAs, ref policy, named permission profiles,
authorization rules, ordering/supersession and parking rules. The server
verifies installation ownership before accepting a spec, binding a run, or
minting; it selects the installation, `repository_ids`, and profile, never
request input/default-all.
A protected audited central policy/activation path is the only writer of these
forward-only revisions. Repository and worker credentials cannot widen policy,
register a new revision, or activate central authority. Revisions apply
prospectively; historical policy decisions and attempt provenance remain
immutable. A shared installation is blast radius, not cross-repo trust:
decline onboarding where repository-restricted minting cannot be established.
No API supports cross-tenant list/search/read.

Repository-local configuration may only narrow non-authorizing execution or
presentation behavior from an approved exact SHA. It cannot add actor/workflow
authorization, relax ordering/parking, select an installation/profile, or
otherwise override the central policy record.

Every central GitHub API effect is executed with the exact tenant installation,
repository ID, and policy-resolved credential profile; none uses an
organization-wide default token or a caller-supplied repository/profile.

This revisits #870: the shared artifact is a newly reviewed generic controller
contract/core and thin adapters. Consumers do not import the repo-coupled
broker, access its storage, or inherit its legacy rollback surface; equivalent
generic controller code migrates into the service and local copies disappear
after parity is proved.

## Versioned contracts

Every ingress payload has `{ schema, version, requestId }`, gets parsed by one
schema-derived type at the trust boundary, and uses closed tagged variants. A
breaking semantic change gets a new `agent-lcars.<name>/vN` schema. Dates are
RFC-3339 UTC. There is no generic evidence bag or universal task locator.

### Ingress signal and service-produced spec

The target ingress is a closed, tenant-scoped signal rather than a client-side
authorization assertion. Its tagged variants are github-webhook,
schedule-reconcile, and authenticated operator-command. Each carries a common
`requestId` and immutable `factId`; GitHub webhook additionally carries tenant,
numeric repository ID, installation ID, delivery ID, body digest, event/action,
received/occurred times and HMAC key version. Reconcile carries a centrally
authenticated scheduler identity and scan key; operator commands carry a
centrally authenticated operator identity, command ID, and tagged command.

The central GitHub App ingress resolves tenant only from payload numeric
repository ID plus exact installation ID. It verifies raw HMAC with active and
previous secret versions, durably writes a `(tenantId, deliveryId)` inbox record
with the listed digest/event/action/times/key-version **before ACK**, then
constructs the signal. It persists actor numeric ID, role lookup result,
policy ID/version/content SHA, and matched rule with the PolicyDecision. It
does not duplicate controller logic in a repository.

The service deduplicates delivery ID, scan key, or command ID; resolves the
tenant's immutable registered policy; records the policy decision; and creates
or supersedes intent. AttemptSpec is therefore service-produced after admission
in the target architecture. During migration only, a local ingress/broker emits
an untrusted migration Signal, bound to exact OIDC and workflow SHA. The control
plane re-evaluates it under central policy; it never trusts a submitted
AttemptSpec or policy snapshot. This bridge is deleted after parity and is not
a permanent client API.

```ts
type AttemptSpecV1 = {
  schema: 'agent-lcars.attempt-spec/v1';
  version: 1;
  requestId: string;
  tenant: {
    tenantId: string;
    repositoryId: number;
    repository: string;
    installationId: number;
  };
  task: { issueNumber: number; observedPullRequest?: { number: number } };
  local: {
    intentId: string;
    generation: number;
    attemptMarker: string;
    admissionRevision: number;
    idempotencyKey: string;
  };
  execution: {
    workflow: { path: string; ref: string; sha: string };
    mode: 'implement' | 'review' | 'reply' | 'runbook';
    executorId: string;
    credentialProfileId: string;
    renewalDeadline: string;
  };
  authorization: {
    decision: 'authorized';
    policyRevision: string;
    evidenceRef: string;
  };
};
```

The service checks the marker is exactly the local generation/intent pair. Its
acceptance key is `(tenantId, repositoryId, issueNumber, intentId, generation)`
plus canonical spec digest. Same key/digest returns the same attempt; same key
with different digest is `idempotency_conflict`. In the target flow the service
created this authorization snapshot from centrally registered immutable policy
and a stored signal. The policy resolves opaque `executorId` and
`credentialProfileId` to workflow/path/SHA, OIDC identity, provider command,
GitHub installation, repository restriction, and permissions; it does not
trust a client assertion, including from the migration bridge.

```ts
type RunBindingV1 = {
  runId: number;
  runAttempt: number;
  checkRunId: number;
  workflowPath: string;
  workflowRef: string;
  workflowSha: string;
  jobWorkflowRef?: string;
  jobWorkflowSha?: string;
};
type RuntimeObservationV1 =
  | { kind: 'run-bound'; attemptId: string; binding: RunBindingV1 }
  | {
      kind: 'heartbeat';
      attemptId: string;
      grantId: string;
      at: string;
      phase:
        | 'bootstrap'
        | 'provider-admission'
        | 'provider-execution'
        | 'agent-execution';
    }
  | {
      kind: 'run-terminal';
      attemptId: string;
      binding: RunBindingV1;
      conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | 'skipped';
      observedAt: string;
    }
  | { kind: 'agent-result-claim'; attemptId: string; claim: AgentResultClaimV1 }
  | {
      kind: 'adapter-failure';
      attemptId: string;
      failure: FailureClassificationV1;
    };
type AgentResultClaimV1 =
  | {
      kind: 'pull-request';
      number: number;
      url: string;
      localAttemptMarker: string;
    }
  | {
      kind: 'comment';
      commentId: string;
      url: string;
      localAttemptMarker: string;
    }
  | {
      kind: 'review';
      reviewId: string;
      pullNumber: number;
      url: string;
      localAttemptMarker: string;
    }
  | {
      kind: 'structured-no-op';
      commentId: string;
      url: string;
      localAttemptMarker: string;
    };
```

Claims are untrusted, even with OIDC: they only name the exact object the
service should fetch. There is no arbitrary URL, label, close, or `evidence[]`
variant.

```ts
type CredentialGrantRequestV1 = {
  schema: 'agent-lcars.credential-grant-request/v1';
  version: 1;
  requestId: string;
  attemptId: string;
};
type CredentialGrantResultV1 =
  | {
      kind: 'issued';
      grantId: string;
      token: string;
      issuedAt: string;
      tokenExpiresAt: string;
      renewalDeadline: string;
      maxResidualTokenExpiry: string;
      credentialProfileId: string;
    }
  | { kind: 'denied'; code: GrantDenialCode; retryAfter?: string }
  | { kind: 'terminal'; terminalState: AttemptTerminalState };
```

`GrantDenialCode` is closed: `oidc_invalid`, `binding_mismatch`,
`profile_denied`, `attempt_not_active`, `attempt_cancelled`,
`attempt_superseded`, `attempt_expired`, `renewal_deadline_elapsed`,
`jti_replayed`, `request_replayed`, `already_issued_no_replay`,
`mint_in_progress`, `mint_unknown`, `tenant_mismatch`, and `service_unavailable`. A server
renewal deadline is policy metadata, not GitHub-token invalidation. GitHub
installation tokens last up to one hour, so actual expiry is recorded as
`maxResidualTokenExpiry`.

```ts
type AttemptOutcomeV1 = {
  schema: 'agent-lcars.attempt-outcome/v1';
  version: 1;
  attemptId: string;
  terminalState:
    'succeeded' | 'failed' | 'cancelled' | 'superseded' | 'lost' | 'expired';
  execution: 'exited' | 'timed_out' | 'cancelled' | 'lost' | 'not_started';
  result: DispatchOutcomeKind | 'none';
  reference?: DispatchOutcomeReference;
  failure?: FailureClassification;
  evidence: OutcomeEvidence;
  finalizedAt: string;
};
type ProjectionIntentV1 = {
  schema: 'agent-lcars.projection-intent/v1';
  version: 1;
  operationId: string;
  attemptId: string;
  kind:
    | 'failure-park'
    | 'outcome-comment'
    | 'ledger-projection'
    | 'local-completion-callback';
  desiredRevision: number;
  payload: TaggedProjectionPayload;
};
type ProjectionStatusV1 = {
  operationId: string;
  state: 'pending' | 'converged' | 'diverged';
  observedAt: string;
  failure?: FailureClassification;
};
```

`DispatchOutcomeKind`, exact PR-reference rules, and existing failure
vocabulary are reused. `AttemptOutcome` is immutable: `result` says what was
produced, `execution` says what the run did, and `terminalState` says the
lifecycle decision. The local completion callback is compatibility delivery of
the outcome digest and operation ID to a migration consumer; it is not a
GitHub projection. Its receiver deduplicates and cannot reinterpret service
truth.

## Central Task and Intent reducer

Task/Intent authority is separate from execution and projection. For each
canonical `(tenantId, repositoryId, issueNumber)` task, the control plane stores one task aggregate with a
task revision, deduplicated normalized signals, immutable intent revisions, at
most one desired intent, current attempt reference, and the immutable policy
decision that admitted every mutation. A versioned PolicyDecisionV1 records
policy ID, policy version, content SHA, decision, rule ID, and actor/evidence
reference; evaluation happens centrally against registered immutable policy.

| Input to reducer                                        | Durable reducer effect                   | Deterministic decision                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| normalized Signal with new source key                   | append signal and PolicyDecisionV1       | create immutable intent revision if policy admits it                                                                             |
| duplicate source key                                    | record/read prior decision only          | no second intent/effect                                                                                                          |
| new admitted intent for idle task                       | set this intent as sole desired intent   | create AttemptSpec and admit exactly one attempt                                                                                 |
| new admitted intent while desired intent is pending     | append ordered immutable intent revision | supersede prior unlaunched desired intent; select newest policy-ordered intent                                                   |
| new admitted intent while prior attempt launched/active | append intent/replacement relation       | desired intent becomes newer; send configured cancel/drain intent; old outcome is stale for desired state but remains immutable  |
| denied/park signal or tenant policy hold                | append decision and park intent          | no attempt admission; central projector receives park projection intent                                                          |
| explicit cancel                                         | append command decision                  | cancel desired/unlaunched attempt or cancel/drain active attempt per policy                                                      |
| terminal AttemptOutcome                                 | append outcome reference                 | central retry policy creates one new immutable intent, parks for human, or marks task complete; it never mutates the old attempt |
| retry command after park                                | append authorized command                | re-evaluate current registered policy and create a new intent revision, never reopen old attempt                                 |

The reducer invariants are: exactly one desired intent at every actionable task
revision (none only after terminal close/cancel);
intent and attempt IDs never change; every externally visible action is keyed
by stored source/command/operation identity; and outcome truth stays separate
from projection status. A retry is a new intent/attempt, not a state rewind.

This is the material consumer-code deletion: today's local router normalization,
authorization, label/comment command interpretation, reconcile discovery/dedup,
generation ordering, supersession, lane hold/parking, launch retry and
finalizer retry decisions migrate to the control plane. Consumer repositories
retain only central-App webhook installation (or temporary migration ingress),
tiny provider workflow stubs/reusable calls, optional approved-SHA
non-authorizing presentation/execution configuration, and irreducibly
repo-specific provider commands. They do not retain router, reconciler,
controller, finalizer, or projector decision loops.

## Deterministic attempt FSM, retry, and terminality

The durable aggregate stores immutable spec/digest, monotonic revision,
append-only event records, current binding, grant summaries, outcome, and
projection checkpoints. Every command has an idempotency key; every
observation has a provider delivery/fact key. A replay returns the original
result. Reusing a key with different immutable data fails closed.

| State                     | Owner/input                                             | Durable effect                                                                                | Next state and retry/terminal rule                                                              |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `registering`             | control plane / valid spec                              | mint ID; store spec/digest                                                                    | `launch-pending`; spec key exactly once                                                         |
| `launch-pending`          | control plane / launch                                  | atomically transition attempt and record one outbox operation before call                     | `launch-accepted`, `launch-response-unknown`, or `launch-rejected`                              |
| `launch-accepted`         | control plane / accepted response without exact run     | record response receipt only                                                                  | `run-bound` on later exact discovery; no binding is persisted here                              |
| `launch-response-unknown` | control plane / reconciliation                          | append ambiguity fact                                                                         | `run-bound` on exact discovery; reject only proof of no launch; otherwise bounded observation   |
| `launch-rejected`         | control plane / definitive rejection                    | persist classified reason                                                                     | terminal failed outcome; never launch again                                                     |
| `run-bound`               | control plane / exact run observation                   | persist the unique binding once                                                               | `active`; same replay no-op, different binding is conflict/quarantined                          |
| `active`                  | adapter/control plane / heartbeat, terminal fact, claim | append deduplicated facts and grant audit; terminal fact opens finalization window            | claims/heartbeats remain active; terminal fact moves to `result-observed`; cancel/loss as shown |
| `result-observed`         | finalizer / bounded evidence window                     | continue accepting exact claims; enqueue validation                                           | `validating` when the window closes or policy proves the evidence set complete                  |
| `validating`              | finalizer / exact GitHub read                           | validation decision                                                                           | `finalized`; lookup failures typed, never guessed                                               |
| `finalized`               | finalizer / outcome decision                            | immutable outcome and projection intents atomically                                           | terminal lifecycle; only projection continues                                                   |
| `cancelling`              | control plane / cancel or task-relative supersession    | set `staleForDesiredState`/`supersededByIntentId`; deny grants; issue configured cancel/drain | nonterminal until verified terminal/lost; issued token retains residual validity to expiry      |
| `cancelled`               | finalizer / verified cancellation                       | immutable cancellation outcome                                                                | terminal only after GitHub terminal/lost evidence                                               |
| `superseded`              | control plane / replacement before launch               | immutable supersession outcome; deny grants                                                   | terminal only for unlaunched attempt; launched attempt uses `cancelling`                        |
| `expired/lost`            | finalizer / deadline or escalation                      | record cause; deny grants                                                                     | terminal `expired`/`lost`                                                                       |

`launch-response-unknown` never permits blind re-dispatch. The control plane
first finds a run through exact binding metadata plus local marker. A newer
intent cannot modify or be satisfied by an older attempt.

Every task/attempt transition and its launch outbox record commit atomically
before a dispatch call. The port enforces global AttemptId primary key; unique
acceptance on tenant/repository/canonical-issue/local-intent/generation; exactly
one launch operation per attempt; exactly one run binding per attempt; unique
tenant/repository/run/run-attempt/check-run binding; and exactly one immutable
outcome. A binding replay with identical values is a no-op; a different value is
a conflict quarantined for investigation.

All observations use a common envelope containing schema/version, request ID,
fact ID, source, observed time, attempt ID and payload digest. The service
appends a unique fact ID before applying effect. A terminal run fact opens a
bounded finalization window: late exact claims are accepted and independently
validated until outcome commit. At commit, the finalizer decides zero valid
claims as typed no-deliverable/failure, one valid exact claim as its matching
outcome/reference, and multiple valid exact PR claims as pull-request outcome
without an invented reference, matching #1018. After commit an identical fact
is a no-op; a new contradictory fact/claim is quarantined and cannot replace
the immutable outcome.

Preserve the #1018 characterization semantics: an unbound attempt waits five
minutes, then takes at most three missing-run observations no closer than five
minutes; a bound non-terminal run waits four hours, then takes at most three
stuck-run observations no closer than thirty minutes. The third escalates to
`run_missing` or `run_stuck`. These are control-plane policy and contract
tests, not worker-workflow retry logic.

Projection status is an orthogonal axis: `pending`, `converged`, or `diverged`
per projection operation. It is not an attempt state and cannot alter the FSM
or immutable outcome.

## CredentialGrant protocol

GitHub Actions OIDC exposes `jti`, `repository_id`, `run_id`, `run_attempt`,
`workflow_ref`, `workflow_sha`, and for reusable workflows
`job_workflow_ref`/`job_workflow_sha`. Tenant selection comes only from
signed numeric `repository_id`; the service requires exact `run_id`,
`run_attempt`, `check_run_id`, caller `workflow_sha`, reusable
`job_workflow_sha` where used, plus pinned path/ref and accepted attempt
binding. A ref without expected SHA is never authorization. See GitHub's
[OIDC claims reference](https://docs.github.com/actions/reference/security/oidc#custom-claims-provided-by-github).

1. The pinned trusted client obtains OIDC and sends only `attemptId` and a
   unique `requestId`; it cannot select a binding, repository, installation,
   or permission profile.
2. The service validates issuer, signature, fixed grant audience, expiry, `jti`, numeric
   repository ID, full workflow/run binding, installation, active FSM state,
   profile and renewal deadline. It derives binding/profile/repository/
   installation entirely from the OIDC claims and attempt registry, then records request digest and
   `mint_in_progress` before calling GitHub.
3. The server selects App installation, `repository_ids`, and permissions; it
   mints a repository-restricted installation token. GitHub documents the
   up-to-one-hour lifetime and narrowing in [creating an installation access
   token](https://docs.github.com/rest/apps/apps#create-an-installation-access-token-for-an-app).
4. It returns only token, grant ID, and expiry metadata. The client configures
   checkout/git/`gh` ephemerally and renews with fresh OIDC.

Mint is an external side effect, so one-time OIDC request recording and mint cannot be
one atomic transaction. V1 resolves a lost response or server crash at
`mint_in_progress` conservatively: record audit anomaly, mark the grant
operation `mint_unknown`, fail/park the attempt, and
**do not auto-remint**. This avoids unknown duplicate credentials. An
identical request after a known issue receives `already_issued_no_replay`, not
the token and not an automatic replacement; a changed replay is denied.

V1 is metadata/fingerprint-only retention. The service records grant ID,
request/JTI hash, profile, issue time, expiry and one-way token
fingerprint, but never raw token. On cancellation, supersession, terminality,
deadline, or count/duration budget exhaustion it immediately denies _future_
grants. It cannot invalidate an issued GitHub token; residual validity lasts to
`maxResidualTokenExpiry`, no more than one hour. This risk is bounded by
short lifetime, repository restriction, minimum profile, audit, and no
renewable runner secret.

Encrypted raw-token retention plus revocation outbox is deferred hardening, not
v1. GitHub's `DELETE /installation/token` uses the token being revoked, so it
requires raw-token retention and separate KMS/storage/IAM/retention/threat
approval. It cannot resolve an unknown mint outcome.

For a given attempt and resolved credential profile, at most one issued,
unexpired grant exists. A new grant is allowed only at or after the prior
grant's recorded expiry (including conservative server clock skew), inside its
server-calculated renewal window and minimum interval, and within total
issuance and duration caps.
The service does not replay token material, remint after a known issue, or
remint a `mint_unknown` operation. Renewal has server budget:
`renewalDeadline`, issuance count, and credential duration limit. Heartbeats do not extend it. An active agent can call this
endpoint, so safety is exact policy, not endpoint secrecy. Audit logs IDs,
profile, timestamps, hashed JTI, decision and correlation ID, never JWT,
raw tokens, App private keys/JWTs, or auth headers.

## Actions adapter and finalization

The adapter only obtains/renews CredentialGrant; checkout/setup; invokes provider; emits
runtime facts and untrusted exact claim; then exits. `worker-foundation`
retains runner selection, isolated bootstrap, telemetry, provider scaffolding
and local marker. `agent-authorization` becomes a pinned trusted CredentialGrant
client.

The client uses checkout with `persist-credentials: false`; it writes the
current token to temporary `0600` file, rotates atomically, and removes it on
exit. A git askpass/helper and PATH-first `gh` wrapper read it just in time.
It must not use `gh auth login`, `GH_TOKEN`, PAT fallback, App private key,
App JWT, or refresh secret.

Same-runner finalization/parking disappears from the authoritative path.
Workers may emit claim/diagnostics but cannot validate, park, decide outcome,
retry launch, or finalize. Force-cancel/no-job-created gaps are server
webhook/poll work, not `if: always()` work.

Webhooks, reports, and polls are at-least-once/out-of-order. The finalizer
deduplicates facts and re-fetches GitHub with its own repository-scoped App
token. It verifies repository identity, exact artifact ID, local marker, and
`<!-- attempt-claim:<marker> -->` in exact PR/comment/review body. No-op also
needs typed marker in same comment. It never infers from actor/time/labels/issue
text. Multiple exact PR claims prove `pull-request` without inventing a
reference, per #1018.

The control plane emits idempotent `ProjectionIntent`; its central GitHub
provider adapter normally performs GitHub/console writes and returns status. A
repository-local projector exists only during migration or defined fallback.
Projection failure becomes `projection-diverged`, retries only that operation,
and cannot alter outcome or re-run work.

| Disorder                             | Honest convergence                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| response lost                        | pending outbox then exact discovery, never blind re-dispatch                  |
| no run                               | bounded missing-run observations then lost outcome                            |
| normal/force cancellation            | webhook/poll wins; deny renewal; terminalize from facts                       |
| outage before launch                 | durable intent remains; reconcile submit key before rollback                  |
| outage during execution/finalization | token only through recorded expiry; retry observations/poll; resume finalizer |
| callback loss/order                  | dedupe then poll exact run/artifact                                           |
| stale old run                        | only its immutable attempt, never newer intent                                |
| projector failure                    | final outcome intact; divergence/retry separate                               |

## Threat and failure matrix

| Threat or failure                             | Required control and honest residual behavior                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| forged/replayed OIDC; confused deputy         | verify issuer/signature/audience/time/JTI; choose tenant only from signed numeric repository ID; exact attempt/run/run-attempt/check-run/caller-SHA/reusable-SHA binding; fail closed |
| workflow changed at mutable ref               | profile allowlist requires immutable workflow SHA plus path/ref; ref alone never authorizes                                                                                           |
| active agent renews indefinitely              | server renewal deadline, count/duration budget and active-state check; endpoint secrecy is not a control                                                                              |
| token theft or cancel                         | minimum repository profile, no renewable runner secret, deny future grant; v1 accepts issued-token use through recorded one-hour maximum expiry                                       |
| duplicate signal/spec or launch response loss | source/spec idempotency and canonical digest; record-before-send outbox; exact discovery before retry                                                                                 |
| mint response loss                            | metadata-only v1 fails/parks without auto-remint; avoids unknown duplicate token                                                                                                      |
| stale run finishes after newer intent         | immutable service attempt and exact local marker bind evidence to one attempt only                                                                                                    |
| App installation overgrant or tenant leakage  | server-selected repository restriction/profile, tenant filtered records/queries/audit; decline unsafe tenant onboarding                                                               |
| GitHub webhook loss/out-of-order              | delivery/fact dedupe plus bounded exact polling/reconciliation                                                                                                                        |
| service outage                                | durable state retains fact; ingress/adapters retry only idempotently; no speculative legacy double-run                                                                                |
| projector write failure                       | terminal outcome transaction is separate; only projection diverges and retries                                                                                                        |

Tenant-partitioned queues, outboxes and storage access, per-tenant quotas,
circuit breakers, and an audited kill switch contain service faults and noisy
tenants; they do **not** contain compromise of a shared GitHub App private key
or App-wide webhook secret. Either credential has the incident scope of every
repository in its trust domain. Before implementation, owners must deliberately
choose that trust domain: use separate App/key/webhook-secret domains where the
fleet-wide residual is unacceptable, or record and operate it as fleet-wide
incident scope. Normal service operation still restricts each mint and GitHub
effect to the tenant installation/repository/profile. Webhook secrets have
active/previous rotation windows and the inbox persists which version validated
each delivery. Key rotation, installation scope widening, trust-domain changes,
and kill-switch use are central operator actions, never worker/repository
privileges.

## Lifecycle Control Plane storage and migration

Define separate `LifecycleControlPlaneStoragePort`, borrowing only current
concepts: aggregate CAS, typed conflict, record-before-send outbox, single
terminal resolution, and contract tests. Do not reuse `StoredTask`, its task
lease, Firestore aggregate, or broker state as control-plane authority.

Required units are: tenant task/signal/intents, acceptance index plus attempt
create; CAS transition/event append; outbox record/resolve/due scan; unique
observation fact; JTI/request replay record; immutable outcome plus projection
intents; and projection status/retry. Indexes cover exact task/attempt, signal
dedup, local idempotency, pending launch, expiry/stuck deadline, run binding,
tenant projection, and retention. Contract tests prove read-your-writes, CAS
conflict, same-key result, mismatched-key rejection, outbox crash recovery,
one terminal outcome, tenant isolation, replay rejection, and projection retry
without duplicate GitHub write. Storage product/schema/retention/backup/
encryption/residency remain unapproved.

Each tenant/task class has one durable activation record:
`{ mode: 'shadow' | 'central-authoritative' | 'retired', epoch, effectiveBoundary }`.
Shadow records signals and decisions but emits no GitHub launch/projection/cancel
effects. At cutover the local broker can only relay/reject under its pinned
epoch; each task and in-flight attempt is pinned to exactly one authority.

Migration starts Agent LCARS self-hosted with one exact-SHA client and one
reversible tenant/lane activation, then moves controller functions one bounded
contract at a time. Start with central ingress and mirrored signal/intents,
then centralize authorization/order/supersession/admission, attempt/grant/
finalizer, and central projection. Existing brokers are migration adapters and
eventual deletion targets after semantic parity, not permanent authorities.
Then migrate Sprinkles lane-by-lane and Homelab last. The steady-state consumer
footprint is tiny provider workflow stubs/reusable-workflow calls plus optional
approved-SHA non-security configuration: no router, reconciler, controller,
finalizer, or projector decision loop remains in a consumer repo.

No permanent scheduled canary remains after cutover; short-lived activation
shadow is explicitly effect-free. Use contract tests and one-shot
production-path branch evidence per #887. On ambiguous `SubmitAttempt`,
reconcile idempotency before any fallback; never run legacy alongside it.
In-flight attempts remain with the authority that accepted them. Disable new
activation after divergence/outage and record activation SHA, IDs, observations,
and resolution.

Before implementation, owners must approve service deployment/storage/retention;
App installation/profile/permissions; OIDC audience/workflow-SHA allowlists;
v1 metadata-only policy or later revocation hardening; budgets/SLO; tenant
policy and projector/callback authorization; first migration lane/evidence; and
active-cancellation policy (safe default: observe to terminal, deny future grants).
