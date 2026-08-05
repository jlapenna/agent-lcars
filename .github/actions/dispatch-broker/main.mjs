import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  acceptIntent,
  ACTIVE_STATES,
  addAnomaly,
  applyAnchorControl,
  awaitTerminal,
  beginDispatch,
  bindRun,
  completeRun,
  markDispatchRejected,
  markDispatchUnknown,
  observeCompletion,
  recordControlEvidence,
  verifyPreflight,
} from './broker.mjs';
import {
  createGitHubApi,
  dispatchRouterEvent,
  dispatchWorker,
  ensureNeedsHumanParked,
  failClosed,
  findRunsForGeneration,
  findSupersedingRouterRun,
  getWorkflowRun,
  GitHubApiError,
  listOpenAgentLabeledIssues,
  listOpenIssuesAssignedTo,
  loadLedger,
  mapWithConcurrency,
  pinLedgerWhenUnoccupied,
  removeIssueLabel,
  repositoryPath,
  saveLedger,
  verifyBrokerConcurrency,
  workerWorkflow,
} from './github-api.mjs';
import { normalizeEvent } from './normalize.mjs';

function env(name, required = true) {
  const value = process.env[name];
  if (required && !value) throw new Error(`${name} is required`);
  return value ?? '';
}

function output(name, value) {
  const path = env('GITHUB_OUTPUT');
  return fs.appendFile(path, `${name}=${value}\n`, 'utf8');
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function api() {
  return createGitHubApi({ token: env('GITHUB_TOKEN') });
}

function contextFor(event, inputs) {
  return {
    repository: event.repository?.full_name ?? env('GITHUB_REPOSITORY'),
    repositoryId: event.repository?.id ?? Number(env('GITHUB_REPOSITORY_ID')),
    issue: inputs.issue,
    runId: Number(env('GITHUB_RUN_ID')),
    actor: env('GITHUB_ACTOR'),
    now: new Date().toISOString(),
  };
}

async function normalize() {
  const event = JSON.parse(await fs.readFile(env('GITHUB_EVENT_PATH'), 'utf8'));
  const eventName = env('GITHUB_EVENT_NAME');
  const inputs = event.inputs ?? {};
  const context = contextFor(event, inputs);
  const client = api();
  if (eventName === 'workflow_dispatch') {
    const issue = await client.requestOk(
      `${repositoryPath({ repository: context.repository })}/issues/${inputs.issue}`,
    );
    event.issue = issue;
  }
  let timeline = [];
  if (
    eventName === 'issues' &&
    ['labeled', 'unlabeled', 'closed', 'reopened'].includes(event.action)
  ) {
    timeline = await client.requestOk(
      `${repositoryPath({ repository: context.repository })}/issues/${event.issue.number}/timeline?per_page=100`,
    );
  }
  const normalized = normalizeEvent({
    eventName,
    event,
    inputs,
    context,
    timeline,
    maintainer: env('MAINTAINER_LOGIN'),
  });
  const issue =
    normalized.task?.issue ?? event.issue?.number ?? Number(inputs.issue);
  await output('eligible', normalized.kind === 'ignored' ? 'false' : 'true');
  await output('issue', String(issue || ''));
  await output('repository-id', String(context.repositoryId));
  await output(
    'group',
    issue
      ? `agent-lcars-dispatch-v1-${context.repositoryId}-${issue}`.toLowerCase()
      : '',
  );
  await output('payload', encode(normalized));
  await output('reason', normalized.reason ?? '');
}

function activeGeneration(ledger) {
  return ledger.generations.find((generation) =>
    ACTIVE_STATES.has(generation.state),
  );
}

function assertWorkerRun(run, task, generation, expectedWorkflow) {
  const marker = `[dispatch:g${generation.generation}:${generation.intentId}]`;
  if (
    run.repository?.id !== task.repositoryId ||
    run.event !== 'workflow_dispatch' ||
    run.path !== `.github/workflows/${expectedWorkflow}` ||
    !run.display_title?.includes(marker)
  ) {
    throw new Error('Worker run identity does not match its ledger binding');
  }
}

async function reconcileActive(client, loaded) {
  let active = activeGeneration(loaded.ledger);
  if (!active) return;
  const expectedWorkflow = workerWorkflow(active.pipeline);
  const matchingRuns = await findRunsForGeneration(
    client,
    loaded.ledger.task,
    active,
  );
  if (matchingRuns.length > 1) {
    addAnomaly(loaded.ledger, 'duplicate-attempt', {
      generation: active.generation,
      runIds: matchingRuns.map((run) => run.id),
    });
    await saveLedger(client, loaded);
    throw new Error('Multiple worker runs match one dispatch generation');
  }
  if (
    ['dispatching', 'dispatch-unknown'].includes(active.state) &&
    matchingRuns.length === 1
  ) {
    const run = matchingRuns[0];
    assertWorkerRun(run, loaded.ledger.task, active, expectedWorkflow);
    bindRun(loaded.ledger, active.generation, {
      runId: run.id,
      runUrl: run.url,
      htmlUrl: run.html_url,
      workflow: expectedWorkflow,
    });
    await saveLedger(client, loaded);
    active = activeGeneration(loaded.ledger);
  }
  if (!active?.attempt?.runId) return;
  const run = await getWorkflowRun(
    client,
    loaded.ledger.task,
    active.attempt.runId,
  );
  assertWorkerRun(run, loaded.ledger.task, active, expectedWorkflow);
  if (run.status === 'completed') {
    completeRun(loaded.ledger, active.generation, {
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      completedAt: run.updated_at,
    });
    await saveLedger(client, loaded);
  }
}

// The reconciler's (#305) grace period before a still-runless dispatching
// generation is flagged at all -- `findRunsForGeneration` can legitimately
// see zero matches for a few seconds/minutes right after a genuine dispatch
// (ordinary eventual consistency, the same lag #340 documented for
// concurrency-group listings), so the FIRST reconcile pass over a young
// generation must stay a silent no-op.
const RECONCILE_MISSING_RUN_GRACE_MS = 5 * 60 * 1000;
// Minimum gap between two COUNTED missing-run observations for the same
// generation. This is what makes a reconcile pass idempotent against a
// second, overlapping, or rapidly re-triggered pass (the acceptance
// criterion): re-observing "still missing" inside this window records
// nothing new and mutates nothing, rather than inflating the attempt
// counter or re-writing the ledger. A genuinely new scheduled pass (30
// minutes later, see dispatch-reconcile.yml) always clears it.
const RECONCILE_MISSING_RUN_MIN_INTERVAL_MS = 5 * 60 * 1000;
// Bound on how many distinct, interval-separated "still missing" reconcile
// observations a generation gets before it is parked needs-human. Mirrors
// the repo's general bounded-retry posture (#343/#344) rather than
// retrying forever.
const RECONCILE_MISSING_RUN_MAX_ATTEMPTS = 3;

function reconcileAnomaliesFor(ledger, generationNumber, kind) {
  return ledger.anomalies.filter(
    (anomaly) =>
      anomaly.kind === kind && anomaly.detail?.generation === generationNumber,
  );
}

// Repairs orphan classes 2 and 4 from #305's production audit: a dispatch
// whose POST outcome was genuinely lost (queue-evicted per #345/#347, or a
// worker that crashed before ever registering a matching run) leaves a
// generation stuck `dispatching`/`dispatch-unknown` forever with no run ID
// -- reconcileActive() above already binds it the instant exactly one
// matching run appears, but does nothing when zero ever do. This is the one
// gap reconcileActive() cannot safely close itself: a single event-driven
// broker() call has no concept of "how many times has this now been
// observed missing" and must not escalate straight to needs-human on one
// possibly-premature zero-match observation -- reconcileActive() itself
// runs unconditionally on every single event, so it cannot be the thing
// that counts a bounded number of attempts over time.
//
// Every mutation here is recorded in the ledger's `anomalies` array before
// (successful) escalation and is itself idempotent: the leading
// 'reconcile-parked' check below short-circuits every later pass into a
// true no-op once the bound is hit, and the age/interval gates prevent
// double-counting a rapid re-run.
async function trackMissingRun(client, loaded, generation, now) {
  const ledger = loaded.ledger;
  if (
    reconcileAnomaliesFor(ledger, generation.generation, 'reconcile-parked')
      .length > 0
  ) {
    return;
  }
  const startedAt = Date.parse(
    generation.attempt?.dispatchStartedAt ?? generation.occurredAt,
  );
  const ageMs = Date.parse(now) - startedAt;
  if (!(ageMs >= RECONCILE_MISSING_RUN_GRACE_MS)) return;

  const priorObservations = reconcileAnomaliesFor(
    ledger,
    generation.generation,
    'reconcile-missing-run',
  );
  const last = priorObservations.at(-1);
  if (
    last &&
    Date.parse(now) - Date.parse(last.occurredAt) <
      RECONCILE_MISSING_RUN_MIN_INTERVAL_MS
  ) {
    return;
  }

  const attempt = priorObservations.length + 1;
  const reachedBound = attempt >= RECONCILE_MISSING_RUN_MAX_ATTEMPTS;
  // Apply the (idempotent, verify-then-decide) GitHub-side park BEFORE
  // recording it in the ledger: if the mutation throws, the ledger must
  // stay exactly as it was so the next pass retries at the same attempt
  // count, rather than claiming a park that never actually landed.
  if (reachedBound) {
    await ensureNeedsHumanParked(
      client,
      ledger.task,
      env('MAINTAINER_LOGIN', false),
    );
  }
  addAnomaly(
    ledger,
    'reconcile-missing-run',
    {
      generation: generation.generation,
      intentId: generation.intentId,
      pipeline: generation.pipeline,
      state: generation.state,
      attempt,
      ageMs,
    },
    now,
  );
  if (reachedBound) {
    addAnomaly(
      ledger,
      'reconcile-parked',
      {
        generation: generation.generation,
        reason: 'missing-run-bound-exhausted',
      },
      now,
    );
  }
  await saveLedger(client, loaded);
}

// The `reconcile` normalized kind's own repair (#305), invoked from
// broker() after reconcileActive() has already had its normal chance to
// bind/complete the current active generation. Everything reconcileActive()
// already covers (bind an unambiguous run, complete a terminal bound run,
// anomaly+fail-closed a genuine duplicate-run collision) is intentionally
// NOT duplicated here -- this only closes reconcileActive()'s one remaining
// gap (a persistently runless dispatch) and one defensive invariant check.
async function reconcileLedger(client, loaded, now = new Date().toISOString()) {
  const ledger = loaded.ledger;
  const active = activeGeneration(ledger);
  const pending = ledger.generations.find(
    (candidate) => candidate.state === 'pending',
  );
  if (
    pending &&
    !active &&
    reconcileAnomaliesFor(
      ledger,
      pending.generation,
      'reconcile-invariant-violation',
    ).length === 0
  ) {
    // Should be unreachable through broker.mjs's own transitions (a
    // `pending` generation only ever exists alongside a contemporaneous
    // active one, and every path that resolves the active generation also
    // promotes pending -- see completeRun/markDispatchRejected). Surfacing
    // it loudly rather than guessing/promoting is #305's "never silently
    // discard evidence" requirement applied to ledger data that itself
    // looks corrupted. Mutation-before-ledger-write (same ordering as
    // trackMissingRun above) so a failed park never leaves the ledger
    // falsely claiming one landed; the anomaly check above makes a repeat
    // pass, once parked, a true no-op.
    await ensureNeedsHumanParked(
      client,
      ledger.task,
      env('MAINTAINER_LOGIN', false),
    );
    addAnomaly(
      ledger,
      'reconcile-invariant-violation',
      {
        detail: 'pending generation with no contemporaneous active generation',
        generation: pending.generation,
      },
      now,
    );
    await saveLedger(client, loaded);
    return;
  }
  if (!active || !['dispatching', 'dispatch-unknown'].includes(active.state)) {
    return;
  }
  if (active.attempt?.runId) return;
  await trackMissingRun(client, loaded, active, now);
}

// Fires one workflow_dispatch `kind: reconcile` call at agent-router.yml per
// already-discovered candidate issue (#305's scan side). Each call reuses
// agent-router.yml's own normalize -> broker jobs end to end: the same
// per-issue `agent-lcars-dispatch-v1-<repositoryId>-<issue>` concurrency
// group, and #349's already-hardened indirect concurrency corroboration for
// workflow_dispatch-triggered runs. This function never touches a ledger
// comment itself, so it needs no concurrency verification of its own --
// only dispatch-reconcile.yml's single scan-wide concurrency group (to
// avoid two overlapping scans firing duplicate dispatches) applies here.
// Bounds how many workflow_dispatch POSTs dispatchReconcileScan fires at
// once. Every candidate's dispatch is independent -- no ordering dependency
// between them -- but the fleet-assignee discovery lane (#363 review) can
// legitimately return a large historical backlog, and an unbounded burst of
// simultaneous POSTs risks tripping GitHub's secondary rate limits (a PR
// #374 review finding): the resulting rejections would just become
// per-candidate failures, silently skipping otherwise-healthy candidates
// for this pass. A small worker pool (mapWithConcurrency) still attempts
// every candidate and keeps per-candidate failure isolation, just bounded.
const RECONCILE_DISPATCH_CONCURRENCY = 5;

async function dispatchReconcileScan(client, repository, issueNumbers) {
  const task = { repository };
  const outcomes = await mapWithConcurrency(
    issueNumbers,
    RECONCILE_DISPATCH_CONCURRENCY,
    (issueNumber) =>
      dispatchRouterEvent(client, task, {
        kind: 'reconcile',
        issue: String(issueNumber),
      }),
  );
  const results = { dispatched: 0, failed: [] };
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      results.dispatched += 1;
    } else {
      results.failed.push({
        issue: issueNumbers[index],
        message: outcome.reason.message,
      });
    }
  });
  return results;
}

function isDefiniteDispatchRejection(error) {
  return (
    error instanceof GitHubApiError &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 429].includes(error.status)
  );
}

async function dispatchAccepted(client, loaded) {
  while (!loaded.ledger.control.closed) {
    const generation = loaded.ledger.generations.find(
      (candidate) => candidate.state === 'accepted',
    );
    if (!generation || activeGeneration(loaded.ledger)) return;
    beginDispatch(
      loaded.ledger,
      generation.generation,
      crypto.randomBytes(24).toString('base64url'),
    );
    await saveLedger(client, loaded);
    try {
      const binding = await dispatchWorker(
        client,
        generation,
        loaded.ledger.task,
      );
      bindRun(loaded.ledger, generation.generation, binding);
      await saveLedger(client, loaded);
      return;
    } catch (error) {
      if (isDefiniteDispatchRejection(error)) {
        markDispatchRejected(
          loaded.ledger,
          generation.generation,
          `HTTP ${error.status}`,
        );
        await saveLedger(client, loaded);
        throw error;
      }
      markDispatchUnknown(
        loaded.ledger,
        generation.generation,
        error.message.slice(0, 300),
      );
      await saveLedger(client, loaded);
      return;
    }
  }
}

function completionMatches(generation, normalized, run) {
  return (
    generation &&
    generation.intentId === normalized.intentId &&
    generation.attempt?.token === normalized.token &&
    generation.attempt?.runId === normalized.workerRunId &&
    run.id === normalized.workerRunId
  );
}

async function handleCompletion(client, loaded, normalized) {
  const generation = loaded.ledger.generations.find(
    (candidate) => candidate.generation === normalized.generation,
  );
  let run = await getWorkflowRun(
    client,
    normalized.task,
    normalized.workerRunId,
  );
  const expectedWorkflow = workerWorkflow(generation?.pipeline);
  assertWorkerRun(run, normalized.task, generation, expectedWorkflow);
  if (
    normalized.workflow !== expectedWorkflow ||
    !completionMatches(generation, normalized, run)
  ) {
    throw new Error('Completion callback does not match the bound worker run');
  }
  const evidence = recordControlEvidence(loaded.ledger, {
    sourceKind: 'completion',
    sourceId: normalized.sourceId,
    transportRunId: normalized.transportRunId,
    occurredAt: new Date().toISOString(),
    runId: normalized.workerRunId,
    authorization: { observed: true, workflow: expectedWorkflow },
  });
  if (generation.state === 'completed') {
    if (evidence.outcome === 'recorded') await saveLedger(client, loaded);
    return;
  }
  if (generation.state === 'active') {
    observeCompletion(loaded.ledger, generation.generation, run.id);
  }
  await saveLedger(client, loaded);

  const deadline = Date.now() + 120_000;
  let delay = 2_000;
  while (run.status !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 15_000);
    try {
      run = await getWorkflowRun(
        client,
        normalized.task,
        normalized.workerRunId,
      );
      assertWorkerRun(run, normalized.task, generation, expectedWorkflow);
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        (error.status === 404 || error.status >= 500)
      ) {
        continue;
      }
      throw error;
    }
  }
  if (run.status !== 'completed') {
    if (generation.state === 'completion-observed') {
      awaitTerminal(loaded.ledger, generation.generation);
      await saveLedger(client, loaded);
    }
    return;
  }
  completeRun(loaded.ledger, generation.generation, {
    runId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    completedAt: run.updated_at,
  });
  await saveLedger(client, loaded);
}

function resolveTask(normalized) {
  // Every normalized kind carries a canonical TaskRef, but intents nest
  // theirs under `.intent.task` (see normalize.mjs's makeIntent) while
  // completion/anchor-control/control-evidence carry `.task` at the top
  // level. Resolve per kind so broker() reads one consistent value.
  return normalized.kind === 'intent'
    ? normalized.intent.task
    : normalized.task;
}

// Only a `retryable: true` mismatch is eligible: every other failure mode
// (config mismatch, malformed response, more than one match) is a real
// anomaly that retrying or supersession-checking cannot explain away, so
// it must keep failing red immediately (issue #344's "genuinely
// unexplained mismatch" requirement). Even for the eligible case, absence
// of a corroborating superseding run must NOT be treated as proof of
// eviction -- it just means this run's mismatch is still unexplained, so
// the caller keeps failing red.
//
// Corroborated eviction is only safe to drop for `control-evidence` and
// `reconcile`: both are non-authoritative pings the superseding run's own,
// separately-sourced evidence does not depend on -- losing either only
// shrinks the audit trail (`control-evidence`) or simply waits for the next
// scheduled pass (`reconcile`, #305: dispatch-reconcile.yml re-fires the
// identical idempotent `kind: reconcile` ping for this issue on its next
// 30-minute cadence regardless, so an evicted one is never "permanently
// lost" the way an evicted intent would be). `intent`, `completion`, and
// `anchor-control` are not interchangeable with whatever the superseding
// run happens to carry: the superseding run corresponds to a *different*
// triggering event (its own distinct sourceId), so it offers no guarantee
// of carrying this run's payload forward. An evicted `intent` is an
// authorized dispatch request that would be silently lost forever; an
// evicted `completion` would leave its generation active forever; an
// evicted `anchor-control` would leave the issue's open/closed state
// unresolved. Those must still fail red even when eviction is
// corroborated (#344 follow-up), with an error naming what was lost so a
// maintainer knows to manually re-dispatch it.
const EVICTION_TOLERANT_KINDS = new Set(['control-evidence', 'reconcile']);

async function wasSupersededEviction(client, task, runId, group, kind, error) {
  if (error?.name !== 'BrokerConcurrencyMismatchError' || !error.retryable) {
    return false;
  }
  const superseding = await findSupersedingRouterRun(client, task, runId);
  if (!superseding) return false;
  if (!EVICTION_TOLERANT_KINDS.has(kind)) {
    throw new Error(
      `Broker run ${runId} (group ${group}, issue #${task.issue}) was ` +
        `evicted from its concurrency queue by newer run ${superseding.id}, ` +
        `but this event carries a '${kind}' payload. Only observational ` +
        'control-evidence/reconcile pings may be dropped on a corroborated ' +
        `eviction (#344, #305); a superseding run does not carry this ` +
        `event's '${kind}' payload forward, since it corresponds to a ` +
        "different triggering event. This event's payload is presumed " +
        'permanently lost -- a maintainer must manually re-dispatch it to ' +
        'recover.',
      { cause: error },
    );
  }
  console.log(
    `::notice::Broker run ${runId} (group ${group}, issue #${task.issue}) ` +
      `was evicted from its concurrency queue by newer run ${superseding.id}, ` +
      'which now reports the expected group. Treating this run as ' +
      `superseded rather than failing (#344/#305): this run's own '${kind}' ` +
      'payload for its triggering event is not recorded in the ledger -- ' +
      'the superseding run already carries the issue forward correctly.',
  );
  return true;
}

// Only these two acceptIntent() outcomes leave the resulting generation in
// a non-superseded state ('accepted' for 'dispatch', 'pending' for
// 'pending') -- every other outcome ('duplicate', 'semantic-duplicate',
// 'stale', 'stale-control-state', 'closed') means either nothing new was
// recorded or the ledger has already judged this intent not to be the
// current desired state. A self-heal must never act on the latter: an old
// `labeled` webhook rerun/redelivered after the maintainer has since
// switched back to the label this payload calls "stale" would otherwise
// delete the maintainer's actual current selection (PR #355 review).
const FRESH_INTENT_OUTCOMES = new Set(['dispatch', 'pending']);

// Self-heals the transient manual-relabel dual-label window (#304 audit
// item 4): normalize.mjs marks an intent's `staleAgentLabels` when a
// `labeled` event's own label disambiguates against exactly one other
// agent:* label still on the issue. Removing the stale label(s) here --
// inside the serialized broker write path, the only place control-plane
// writes are allowed -- restores the "exactly one agent:* label" contract
// before the intent dispatches.
//
// Belt-and-braces beyond the FRESH_INTENT_OUTCOMES gate at the call site:
// the payload's dual-label snapshot can still be stale by the time this
// runs (e.g. a slow/retried run), so re-read the issue's live labels and
// only remove a stale label that is STILL present TOGETHER WITH the
// event's own (newer) label. If live state no longer matches -- most
// notably, the maintainer switched back and only the "stale" label remains
// -- skip that label with a `::notice::` and record no evidence for it.
//
// Idempotent by construction: `removeIssueLabel` tolerates 404 (label
// already gone), and `recordControlEvidence`'s own sourceKind/sourceId
// dedup (keyed off the triggering intent's sourceId, so a redelivery of the
// same underlying event reuses the same evidence sourceId) means a
// redelivered event only re-saves the ledger when it actually added new
// evidence, matching the pattern `handleCompletion` already uses below.
async function healStaleAgentLabels(client, loaded, intent) {
  const staleLabels = intent.staleAgentLabels;
  if (!staleLabels?.length) return;
  const task = loaded.ledger.task;
  const eventLabel = `agent:${intent.pipeline}`;
  const issue = await client.requestOk(
    `${repositoryPath(task)}/issues/${task.issue}`,
  );
  const currentLabels = new Set(
    (issue.labels ?? []).map((label) =>
      typeof label === 'string' ? label : label.name,
    ),
  );
  const removable = [];
  const skipped = [];
  for (const label of staleLabels) {
    if (currentLabels.has(label) && currentLabels.has(eventLabel)) {
      removable.push(label);
    } else {
      skipped.push(label);
    }
  }
  if (skipped.length > 0) {
    console.log(
      `::notice::Skipping stale-label self-heal for ${skipped.join(', ')} ` +
        `on issue #${task.issue}: live labels no longer match the ` +
        `dual-label snapshot this intent was normalized from (current: ` +
        `${[...currentLabels].join(', ') || 'none'}).`,
    );
  }
  if (removable.length === 0) return;
  for (const label of removable) {
    await removeIssueLabel(client, task, label);
  }
  const evidence = recordControlEvidence(loaded.ledger, {
    sourceKind: 'label-self-heal',
    sourceId: `label-self-heal:${intent.sourceId}`,
    transportRunId: intent.transportRunId,
    occurredAt: new Date().toISOString(),
    labels: removable,
    authorization: { observed: true, actor: 'dispatch-broker' },
  });
  if (evidence.outcome === 'recorded') await saveLedger(client, loaded);
}

async function broker() {
  const normalized = decode(env('BROKER_PAYLOAD'));
  if (normalized.kind === 'ignored') return;
  const task = resolveTask(normalized);
  const client = api();
  const runId = Number(env('GITHUB_RUN_ID'));
  const group = env('BROKER_GROUP');
  // GITHUB_EVENT_NAME is a standard runner-provided variable (already
  // relied on by normalize()), not something this action sets itself.
  // verifyBrokerConcurrency only uses it for its own diagnostic log line
  // now: #348's third round (2026-08-04) retired the "some event types
  // self-report reliably" allowlist after issues and issue_comment -- the
  // last two events still on the direct, own-listing check -- both turned
  // out to have real, nonzero failure rates too (see the comment above
  // findConflictingRouterRun in github-api.mjs for the sampled numbers).
  // The indirect check is now unconditional, so this stays optional without
  // changing which verification path runs.
  const eventName = env('GITHUB_EVENT_NAME', false);
  try {
    await verifyBrokerConcurrency(client, task, runId, group, { eventName });
  } catch (error) {
    if (
      await wasSupersededEviction(
        client,
        task,
        runId,
        group,
        normalized.kind,
        error,
      )
    ) {
      return;
    }
    throw error;
  }
  let loaded;
  try {
    loaded = await loadLedger(client, task);
  } catch (error) {
    await failClosed(
      client,
      task,
      env('MAINTAINER_LOGIN', false),
      error.message,
    );
  }
  await pinLedgerWhenUnoccupied(
    client,
    loaded,
    env('ANCHOR_IS_PR', false) === 'true',
  );
  try {
    await reconcileActive(client, loaded);
    if (normalized.kind === 'intent') {
      const accepted = acceptIntent(loaded.ledger, normalized.intent);
      await saveLedger(client, loaded);
      // Before dispatching: remove any stale agent:* label a dual-label
      // self-heal identified (#304 audit item 4) -- but only when this
      // intent was accepted as the ledger's current desired state
      // (FRESH_INTENT_OUTCOMES). A duplicate/superseded/closed outcome
      // means an old or redelivered event, whose stale-label snapshot may
      // no longer reflect live GitHub state; healStaleAgentLabels'
      // is-it-actually-still-stale re-check is a second, independent
      // safeguard on top of this (PR #355 review).
      if (FRESH_INTENT_OUTCOMES.has(accepted.outcome)) {
        await healStaleAgentLabels(client, loaded, normalized.intent);
      }
    } else if (normalized.kind === 'anchor-control') {
      applyAnchorControl(loaded.ledger, normalized.control);
      await saveLedger(client, loaded);
    } else if (normalized.kind === 'control-evidence') {
      recordControlEvidence(loaded.ledger, normalized.evidence);
      await saveLedger(client, loaded);
    } else if (normalized.kind === 'completion') {
      await handleCompletion(client, loaded, normalized);
    } else if (normalized.kind === 'reconcile') {
      await reconcileLedger(client, loaded);
    } else {
      throw new Error(`Unsupported normalized event kind: ${normalized.kind}`);
    }
    await dispatchAccepted(client, loaded);
  } catch (error) {
    await failClosed(
      client,
      task,
      env('MAINTAINER_LOGIN', false),
      error.message,
    );
  }
}

async function preflight() {
  const task = {
    repositoryId: Number(env('GITHUB_REPOSITORY_ID')),
    repository: env('GITHUB_REPOSITORY'),
    issue: Number(env('BROKER_ISSUE')),
  };
  const expected = {
    task,
    generation: Number(env('BROKER_GENERATION')),
    intentId: env('BROKER_INTENT_ID'),
    token: env('BROKER_DISPATCH_TOKEN'),
    runId: Number(env('GITHUB_RUN_ID')),
  };
  const client = api();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const loaded = await loadLedger(client, task, 'github-actions[bot]', {
      createIfMissing: false,
    });
    if (loaded && verifyPreflight(loaded.ledger, expected)) {
      const generation = loaded.ledger.generations.find(
        (candidate) => candidate.generation === expected.generation,
      );
      const run = await getWorkflowRun(client, task, expected.runId);
      assertWorkerRun(
        run,
        task,
        generation,
        workerWorkflow(generation.pipeline),
      );
      await output('authorized', 'true');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Worker preflight could not verify an exact broker binding');
}

async function completionCallback() {
  const client = api();
  const task = {
    repositoryId: Number(env('GITHUB_REPOSITORY_ID')),
    repository: env('GITHUB_REPOSITORY'),
    issue: Number(env('BROKER_ISSUE')),
  };
  const completionPayload = encode({
    workerRunId: Number(env('GITHUB_RUN_ID')),
    generation: Number(env('BROKER_GENERATION')),
    intentId: env('BROKER_INTENT_ID'),
    token: env('BROKER_DISPATCH_TOKEN'),
    workflow: env('BROKER_WORKER_WORKFLOW'),
  });
  await dispatchRouterEvent(client, task, {
    kind: 'completion',
    issue: String(task.issue),
    completion_payload: completionPayload,
  });
}

// Merges both discovery lanes (#305, broadened by the #363 review):
// currently agent-labeled issues/PRs (the fast path -- covers everything
// still mid-dispatch or freshly completed) union'd with issues/PRs assigned
// to the agent fleet login (the label-independent path -- covers a ledger
// left active after its last agent:* label was removed). Deduplicated by
// issue number the same way listOpenAgentLabeledIssues dedupes across its
// own per-label queries.
async function discoverReconcileCandidates(client, repository, fleetLogin) {
  const task = { repository };
  const [labeled, assigned] = await Promise.all([
    listOpenAgentLabeledIssues(client, task),
    listOpenIssuesAssignedTo(client, task, fleetLogin),
  ]);
  const byNumber = new Map();
  for (const issue of [...labeled, ...assigned]) {
    if (Number.isSafeInteger(issue?.number)) byNumber.set(issue.number, issue);
  }
  return [...byNumber.values()].sort(
    (left, right) => left.number - right.number,
  );
}

// dispatch-reconcile.yml's scan job (#305): read-only discovery of every
// open agent-labeled or fleet-assigned issue/PR (discoverReconcileCandidates),
// then one `kind: reconcile` workflow_dispatch call per candidate via
// dispatchReconcileScan(). A per-issue dispatch failure never blocks the
// other candidates -- every candidate always gets an attempt -- but the job
// itself still fails loud afterwards (unlike an individual reconcile's own
// bounded-retry parking, which stays green by design) so a systemic
// dispatch problem (e.g. a bad token) is visible.
async function scanReconcile() {
  const client = api();
  const repository = env('GITHUB_REPOSITORY');
  const candidates = await discoverReconcileCandidates(
    client,
    repository,
    env('AGENT_FLEET_LOGIN', false),
  );
  const issueNumbers = candidates.map((issue) => issue.number);
  const results = await dispatchReconcileScan(client, repository, issueNumbers);
  console.log(
    `::notice::dispatch-reconcile: fired reconcile for ${results.dispatched}/` +
      `${issueNumbers.length} open agent-labeled or fleet-assigned issue(s).`,
  );
  for (const failure of results.failed) {
    console.log(
      `::error::dispatch-reconcile: failed to dispatch reconcile for ` +
        `#${failure.issue}: ${failure.message}`,
    );
  }
  await output('candidates', String(issueNumbers.length));
  await output('dispatched', String(results.dispatched));
  if (results.failed.length > 0) {
    throw new Error(
      `Reconcile scan failed to dispatch ${results.failed.length}/` +
        `${issueNumbers.length} candidate(s): ` +
        results.failed.map((failure) => `#${failure.issue}`).join(', '),
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const operation = process.argv[2];
  if (operation === 'normalize') await normalize();
  else if (operation === 'broker') await broker();
  else if (operation === 'preflight') await preflight();
  else if (operation === 'completion-callback') await completionCallback();
  else if (operation === 'reconcile') await scanReconcile();
  else throw new Error(`Unsupported dispatch broker operation: ${operation}`);
}

export {
  assertWorkerRun,
  completionMatches,
  contextFor,
  decode,
  discoverReconcileCandidates,
  dispatchReconcileScan,
  encode,
  FRESH_INTENT_OUTCOMES,
  handleCompletion,
  healStaleAgentLabels,
  isDefiniteDispatchRejection,
  RECONCILE_DISPATCH_CONCURRENCY,
  RECONCILE_MISSING_RUN_GRACE_MS,
  RECONCILE_MISSING_RUN_MAX_ATTEMPTS,
  RECONCILE_MISSING_RUN_MIN_INTERVAL_MS,
  reconcileActive,
  reconcileLedger,
  resolveTask,
  wasSupersededEviction,
};
