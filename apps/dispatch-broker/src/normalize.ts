import crypto from 'node:crypto';

import type {
  AgentPipeline,
  DispatchOutcomeKind,
  DispatchOutcomeReference,
  LaneReadinessFailure,
  LedgerAuthorizationDecision,
  LedgerTaskRef,
  QuickTaskIdentity,
} from '@agent-lcars/dispatch-contracts';
import {
  AGENT_LABELS,
  GENERIC_REPLY_COMMAND,
  isDispatchOutcomeKind,
  isDispatchOutcomeReference,
  isDispatchPipeline,
  isLaneReadinessFailure,
  quickTaskDigest,
  quickTaskMarkerMatcher,
  REPLY_COMMANDS,
  REVIEW_LABELS,
  WORKER_WORKFLOW_FILES,
} from '@agent-lcars/dispatch-contracts';

import type { AnchorControl, ControlEvidence } from './broker';
import { digest } from './broker';
import { authorization, AUTHORIZATION_RULES } from './modules/authorization';
import type { Intent } from './modules/intent';

/** A GitHub `labels` entry: either the bare name (some webhook payloads) or
 *  the full label object (the REST API's shape). */
type GitHubLabel = string | { name: string };

export interface GitHubUser {
  login?: string;
  type?: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  created_at: string;
  author_association?: string;
  user?: GitHubUser;
}

/** The fields read off an issue or a pull request -- normalize.mjs treats
 *  both the same way everywhere except the few spots that check
 *  `pull_request` for presence. */
export interface IssueOrPullRequest {
  id: number;
  number?: number;
  title: string;
  body?: string | null;
  labels?: GitHubLabel[];
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
  merged?: boolean;
  merged_at?: string | null;
  /** GitHub's own `open`/`closed`, supplied by the hosted reconciler for a
   *  reconciliation command without a second controller fetch. */
  state?: string;
}

/** The webhook event body. One shape covering every `eventName` this file
 *  handles (`issues`, `issue_comment`, `pull_request`) -- each branch reads
 *  only the fields its own event actually carries, exactly as the
 *  untyped original did. */
export interface WebhookEvent {
  action: string;
  issue?: IssueOrPullRequest;
  pull_request?: IssueOrPullRequest;
  comment?: GitHubComment;
  sender?: GitHubUser;
  label?: { name: string };
}

export interface TimelineEvent {
  event?: string;
  label?: { name?: string };
  actor?: { login?: string };
  created_at: string;
  id?: number;
}

/** The normalized event context shared by webhook and hosted-command
 *  transports. */
export interface NormalizeContext {
  repository: string;
  repositoryId: number | string;
  issue?: number | string;
  runId: number;
  now: string;
  actor?: string;
}

interface WorkflowDispatchInputs {
  kind?: string;
  completion_payload?: string;
  caller_id?: string;
  pipeline?: string;
  mode?: string;
  reply?: string;
  runbook?: string;
  context?: string;
  /** `reassign-pipeline` only: the exact `agent:*` label to select
   *  `pipeline` on THIS repository -- a watched repo's `agents` config can
   *  override the fleet-wide default (agent-lcars#811 Codex review), so
   *  the console supplies the resolved string rather than this file
   *  reconstructing it from AGENT_LABELS. */
  target_label?: string;
  /** `reassign-pipeline` only: JSON array of every `agent:*` label this
   *  repo's own integrations declare (fleet-wide default or custom) --
   *  what counts as "a pipeline selection" when validating the anchor's
   *  live label state. Always includes `target_label`. */
  pipeline_labels?: string;
}

export interface IgnoredEvent {
  kind: 'ignored';
  reason: string;
}

export interface ReconcileEvent {
  kind: 'reconcile';
  task: LedgerTaskRef;
  /** The issue/PR's live open/closed state at normalize time, absent only
   *  if the live issue somehow carried neither `open` nor `closed` -- see
   *  IssueOrPullRequest's own `state` field above. Threading this through
   *  the normalized payload, rather than reconcileLedger() (main.mjs)
   *  fetching the issue a second time itself, is what lets closed-issue
   *  convergence (reconcileControlState in main.mjs) stay a pure
   *  ledger-state comparison with no GitHub call of its own -- see that
   *  function's own header for why that matters. */
  issueClosed?: boolean;
}

export interface CompletionEvent {
  kind: 'completion';
  task: LedgerTaskRef;
  sourceKind: 'completion';
  sourceId: string;
  transportRunId: number;
  workerRunId: number;
  generation: number;
  intentId: string;
  token: string;
  workflow: string;
  outcome?: DispatchOutcomeKind;
  outcomeReference?: DispatchOutcomeReference;
  readinessFailure?: LaneReadinessFailure;
}

export interface IntentEvent {
  kind: 'intent';
  intent: Intent;
}

export interface AnchorControlEvent {
  kind: 'anchor-control';
  task: LedgerTaskRef;
  control: AnchorControl;
}

export interface ControlEvidenceEvent {
  kind: 'control-evidence';
  task: LedgerTaskRef;
  evidence: ControlEvidence;
}

/**
 * A hosted-command-only transition: swap which single `agent:*` label an
 * anchor carries. Unlike an `intent` (which `acceptIntent()` can turn into a
 * new ledger generation and, eventually, a dispatched worker run), this kind
 * never reaches `acceptIntent()` -- controller-core.mjs's own handler records
 * it as evidence (`ledger.sources`, the same idempotent dedup every other
 * evidence kind uses) and rewrites the label, but manufactures no generation.
 * The controller retains sole ownership of whether/when the newly-labeled
 * pipeline is actually dispatched, exactly as it does for a genuine
 * maintainer relabel through the GitHub UI. See `PipelineReassignmentError`
 * (controller-core.mjs) for the three rejections this command's own handler
 * enforces against the *live* label snapshot at apply time, not here --
 * normalize.mjs only validates the caller's own request shape.
 */
export interface PipelineReassignmentEvent {
  kind: 'pipeline-reassignment';
  task: LedgerTaskRef;
  sourceKind: 'pipeline-reassignment';
  sourceId: string;
  transportRunId: number;
  occurredAt: string;
  targetPipeline: AgentPipeline;
  /** This repo's configured `agent:*` label for `targetPipeline` -- may
   *  differ from the fleet-wide default (a watched repo's own `agents`
   *  config, agent-lcars#811 Codex review). */
  targetLabel: string;
  /** Every `agent:*` label this repo's own integrations declare; always
   *  includes `targetLabel`. What controller-core.mjs's
   *  applyPipelineReassignment recognizes as "a pipeline selection" when
   *  validating the anchor's live label state, instead of the fleet-wide
   *  AGENT_LABELS map. */
  pipelineLabels: string[];
  authorization: LedgerAuthorizationDecision;
}

export type NormalizedEvent =
  | IgnoredEvent
  | ReconcileEvent
  | CompletionEvent
  | IntentEvent
  | AnchorControlEvent
  | ControlEvidenceEvent
  | PipelineReassignmentEvent;

// `null` is a sentinel, not a pipeline: `@agent` (#573) doesn't name a
// specific integration, it defers to whichever `agent:*` label the issue
// already carries at comment-normalization time. Every other command
// keeps requiring an exact match against that label -- this only adds a
// second way to say "the one that's already selected", it doesn't relax
// the existing ones.
const COMMANDS = new Map([...REPLY_COMMANDS, [GENERIC_REPLY_COMMAND, null]]);
const WORKER_WORKFLOWS = WORKER_WORKFLOW_FILES;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256Hex = (input: string): string =>
  crypto.createHash('sha256').update(input).digest('hex');

function labelsOf(issue: IssueOrPullRequest): string[] {
  return (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
}

function selectedPipelineFrom(
  labels: string[],
  labelMap: ReadonlyMap<string, AgentPipeline>,
): AgentPipeline | undefined {
  const selected = labels
    .filter((label) => labelMap.has(label))
    .map((label) => labelMap.get(label));
  return selected.length === 1 ? selected[0] : undefined;
}

function selectedPipeline(
  issue: IssueOrPullRequest,
): AgentPipeline | undefined {
  return selectedPipelineFrom(labelsOf(issue), AGENT_LABELS);
}

function parseExactCommand(
  body: string,
): { command: string; pipeline: AgentPipeline | null } | undefined {
  let fenced = false;
  const matches: { command: string; pipeline: AgentPipeline | null }[] = [];
  for (const rawLine of body.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.startsWith('>')) continue;
    for (const [command, pipeline] of COMMANDS) {
      if (line === command || line.startsWith(`${command} `)) {
        matches.push({ command, pipeline });
      }
    }
  }
  if (matches.length !== 1) return undefined;
  return matches[0];
}

function quickTaskRequest(
  issue: IssueOrPullRequest,
  repository: string,
  pipeline: AgentPipeline | undefined,
): { requestId: string; digest: string } | undefined {
  const body = issue.body ?? '';
  const matches = [...body.matchAll(quickTaskMarkerMatcher())];
  if (matches.length === 0) {
    if (body.includes('<!-- agent-lcars:quick-task-request:v1')) {
      throw new Error('Malformed Quick Task marker');
    }
    return undefined;
  }
  if (matches.length !== 1 || !pipeline) {
    throw new Error('Malformed Quick Task marker or agent-label selection');
  }
  const [marker, requestId, persistedDigest] = matches[0];
  const description = body.slice(0, matches[0].index).trim();
  // The digest binds (repository, pipeline, title, description) at Quick
  // Task creation time (docs/quick-task-identity.md) -- it is a create-time
  // idempotency/tamper check, not an ongoing constraint that the issue's
  // agent:* label can never change again. A later legitimate relabel (the
  // console's reassignPipeline hand-off, or a maintainer manually retrying
  // with a different agent after a failure) changes `pipeline` without
  // touching the marker, so re-deriving the expected digest from the
  // *current* label would always mismatch and, left uncaught, crashes this
  // whole normalize step -- silently dropping the relabel's dispatch (#630,
  // reported against #622). Recover the digest's actual originally-bound
  // pipeline by trying every known pipeline instead of assuming the
  // caller-supplied one: title/description tampering still fails against
  // all of them (a real integrity failure), while a pipeline that simply
  // changed since creation is expected and must not throw.
  const originalPipeline = [...AGENT_LABELS.values()].find(
    (candidate) =>
      digestQuickTask({
        repository,
        pipeline: candidate,
        title: issue.title,
        description,
      }) === persistedDigest,
  );
  if (!originalPipeline) {
    throw new Error('Quick Task marker digest mismatch');
  }
  // A match produced by matchAll() always carries `.index`; the type only
  // says "possibly absent" because RegExpMatchArray is shared with the
  // exec()-with-no-match case, which this is not.
  const matchIndex = matches[0].index;
  if (matchIndex === undefined) {
    throw new Error('Quick Task marker match unexpectedly missing its index');
  }
  if (body.slice(matchIndex + marker.length).trim()) {
    throw new Error('Quick Task marker must be the final body element');
  }
  if (originalPipeline !== pipeline) return undefined;
  return { requestId, digest: persistedDigest };
}

function digestQuickTask(identity: QuickTaskIdentity): string {
  return quickTaskDigest(identity, sha256Hex);
}

function timelineSource(
  timeline: TimelineEvent[],
  eventName: string,
  event: WebhookEvent,
): { sourceId: string; occurredAt: string } {
  const action = event.action;
  // Callers only ever reach here once `event.issue ?? event.pull_request`
  // is already known non-null (each call site already returned "no issue"
  // otherwise); recomputed independently here exactly as the original did.
  const numbered = event.issue ?? event.pull_request;
  if (!numbered) {
    throw new Error(
      `${eventName}:${action} timeline lookup missing issue/pull_request`,
    );
  }
  const targetTime = Date.parse(numbered.updated_at);
  const candidates = timeline.filter((candidate) => {
    if (candidate.event !== action) return false;
    if (['labeled', 'unlabeled'].includes(action)) {
      if (candidate.label?.name !== event.label?.name) return false;
      if (candidate.actor?.login !== event.sender?.login) return false;
    }
    const occurredAt = Date.parse(candidate.created_at);
    return (
      Number.isFinite(targetTime) &&
      Number.isFinite(occurredAt) &&
      Math.abs(occurredAt - targetTime) <= 10_000
    );
  });
  if (candidates.length !== 1 || !candidates[0].id) {
    throw new Error(`Ambiguous ${eventName}:${action} timeline event`);
  }
  return {
    sourceId: `timeline:${candidates[0].id}`,
    occurredAt: candidates[0].created_at,
  };
}

// Shared by the manual-dispatch workflow_dispatch branch
// below: both accept an optional caller-supplied `caller_id` for a stable
// sourceId (falling back to the actions run identity), and both must
// validate it as a UUID when present -- differing only in the error
// message's label.
function resolveCallerSourceId(
  inputs: WorkflowDispatchInputs,
  context: NormalizeContext,
  label: string,
): string {
  const sourceId = inputs.caller_id || `actions-run:${context.runId}`;
  if (inputs.caller_id && !UUID.test(inputs.caller_id)) {
    throw new Error(`${label} caller ID must be a UUID`);
  }
  return sourceId;
}

function taskRef(
  context: NormalizeContext,
  issue: IssueOrPullRequest | undefined,
): LedgerTaskRef {
  const repository = context.repository;
  const repositoryId = Number(context.repositoryId);
  const issueNumber = Number(issue?.number ?? context.issue);
  return { repositoryId, repository, issue: issueNumber };
}

/** What every `makeIntent()` call site supplies -- the same fields as
 *  `Intent`, minus the two `makeIntent()` itself always computes. */
type IntentBase = Omit<Intent, 'intentId' | 'digest'> & { intentId?: string };

function makeIntent(base: IntentBase): Intent {
  const normalizedPayload = {
    task: base.task,
    pipeline: base.pipeline,
    mode: base.mode,
    reply: base.reply ?? '',
    runbook: base.runbook ?? '',
    context: base.context ?? '',
  };
  return {
    ...base,
    ...normalizedPayload,
    digest: digest(normalizedPayload),
    intentId:
      base.intentId ??
      `intent:${digest({ ...normalizedPayload, sourceId: base.sourceId })}`,
  };
}

/** What a `completion` workflow_dispatch's base64url JSON payload must
 *  decode to; validated field by field below before any field is trusted. */
interface CompletionPayload {
  workerRunId: number;
  generation: number;
  intentId: string;
  token: string;
  workflow: string;
  outcome?: DispatchOutcomeKind;
  outcomeReference?: DispatchOutcomeReference;
  readinessFailure?: LaneReadinessFailure;
}

function normalizeWorkflowDispatch({
  inputs,
  context,
  maintainer,
  issue,
}: {
  inputs: WorkflowDispatchInputs;
  context: NormalizeContext;
  maintainer: string | undefined;
  /** The hosted reconciler's already-fetched live issue. Only the
   *  `reconcile` branch reads it. */
  issue?: IssueOrPullRequest;
}): NormalizedEvent {
  const task = taskRef(context, undefined);
  // A hosted reconciliation command carries no caller-owned ledger state:
  // it means "re-observe this anchor against live GitHub state." The shared
  // controller applies only idempotent, evidence-preserving repairs.
  if (inputs.kind === 'reconcile') {
    return {
      kind: 'reconcile',
      task,
      // Omit the key entirely rather than `issueClosed: undefined` when the
      // live state can't be read -- a manual/forensic dispatch that somehow
      // reaches here without a fetched issue must fall back to
      // reconcileControlState's own "unknown" handling (main.mjs), not a
      // stray explicit `undefined` that changes this object's own shape.
      ...(issue?.state === 'open' || issue?.state === 'closed'
        ? { issueClosed: issue.state === 'closed' }
        : {}),
    };
  }
  // A pipeline hand-off command, exclusively from the authenticated console
  // backend (executeHostedControllerCommand) -- never from a real GitHub
  // webhook payload, so (unlike the `labeled`/`unlabeled` branches further
  // down) there is no timeline event to disambiguate against. Always
  // requires the caller's own stable request UUID: the console generates one
  // per user action and reuses it across a transport-level retry, and that
  // UUID is this command's whole idempotency key (see
  // controller-core.mjs's applyPipelineReassignment). Unlike manual
  // dispatch's own `caller_id` (optional, falls back to the actions run
  // identity), a fallback here would make two different browser retries of
  // the same click collide on an actions-run identity that does not exist
  // for an in-process console call.
  if (inputs.kind === 'reassign-pipeline') {
    if (!inputs.caller_id || !UUID.test(inputs.caller_id)) {
      throw new Error('Pipeline reassignment caller ID must be a UUID');
    }
    const auth = authorization(
      context.actor,
      maintainer,
      AUTHORIZATION_RULES.MANUAL_MAINTAINER,
    );
    if (!auth.authorized) {
      throw new Error('Unauthorized pipeline reassignment');
    }
    // isDispatchPipeline (a pipeline-NAME check), not AGENT_LABELS.has(...):
    // this command's label strings come from the console's own repo config
    // below, which can differ from the fleet-wide `agent:*` convention this
    // file's real-webhook branches assume (agent-lcars#811 Codex review).
    if (!inputs.pipeline || !isDispatchPipeline(inputs.pipeline)) {
      throw new Error('Unsupported pipeline reassignment target');
    }
    if (!inputs.target_label) {
      throw new Error('Pipeline reassignment target label is required');
    }
    let pipelineLabels: unknown;
    try {
      pipelineLabels = JSON.parse(inputs.pipeline_labels ?? '');
    } catch {
      throw new Error('Pipeline reassignment label set is malformed');
    }
    if (
      !Array.isArray(pipelineLabels) ||
      pipelineLabels.length === 0 ||
      !pipelineLabels.every(
        (label) => typeof label === 'string' && label.length > 0,
      ) ||
      !pipelineLabels.includes(inputs.target_label)
    ) {
      throw new Error('Pipeline reassignment label set is malformed');
    }
    return {
      kind: 'pipeline-reassignment',
      task,
      sourceKind: 'pipeline-reassignment',
      sourceId: inputs.caller_id,
      transportRunId: context.runId,
      occurredAt: context.now,
      targetPipeline: inputs.pipeline,
      targetLabel: inputs.target_label,
      pipelineLabels: pipelineLabels as string[],
      authorization: auth,
    };
  }
  if (inputs.kind === 'completion') {
    let completion: unknown;
    try {
      // Cast, not a coercion: whatever `completion_payload` actually is
      // (including `undefined`) reaches Buffer.from() exactly as before --
      // a non-string throws here, inside this same try, exactly as it
      // always has.
      completion = JSON.parse(
        Buffer.from(inputs.completion_payload as string, 'base64url').toString(
          'utf8',
        ),
      );
    } catch {
      throw new Error('Completion payload is malformed');
    }
    // completion_payload is base64url-encoded JSON off a caller-supplied
    // workflow_dispatch input -- genuinely untrusted, and every field below
    // is checked before being trusted. This cast only grants property
    // access; a non-object payload still throws exactly as it always has.
    const candidate = completion as Partial<CompletionPayload>;
    if (
      !Number.isSafeInteger(candidate.workerRunId) ||
      (candidate.workerRunId as number) <= 0 ||
      !Number.isSafeInteger(candidate.generation) ||
      (candidate.generation as number) <= 0 ||
      !/^[A-Za-z0-9._:-]{1,200}$/u.test(candidate.intentId ?? '') ||
      !/^[A-Za-z0-9_-]{16,200}$/u.test(candidate.token ?? '') ||
      !WORKER_WORKFLOWS.has(candidate.workflow as string) ||
      (candidate.outcome !== undefined &&
        !isDispatchOutcomeKind(candidate.outcome)) ||
      (candidate.outcomeReference !== undefined &&
        !isDispatchOutcomeReference(candidate.outcomeReference)) ||
      (candidate.outcomeReference !== undefined &&
        candidate.outcome !== 'pull-request') ||
      (candidate.readinessFailure !== undefined &&
        !isLaneReadinessFailure(candidate.readinessFailure))
    ) {
      throw new Error('Completion payload has invalid binding fields');
    }
    return {
      kind: 'completion',
      task,
      sourceKind: 'completion',
      sourceId: `worker-run:${candidate.workerRunId}`,
      transportRunId: context.runId,
      workerRunId: candidate.workerRunId as number,
      generation: candidate.generation as number,
      intentId: candidate.intentId as string,
      token: candidate.token as string,
      workflow: candidate.workflow as string,
      ...(candidate.outcome ? { outcome: candidate.outcome } : {}),
      ...(candidate.outcomeReference
        ? { outcomeReference: candidate.outcomeReference }
        : {}),
      ...(candidate.readinessFailure
        ? { readinessFailure: candidate.readinessFailure }
        : {}),
    };
  }
  const sourceId = resolveCallerSourceId(inputs, context, 'Manual dispatch');
  const auth = authorization(
    context.actor,
    maintainer,
    AUTHORIZATION_RULES.MANUAL_MAINTAINER,
  );
  if (!auth.authorized) throw new Error('Unauthorized manual dispatch');
  if (!AGENT_LABELS.has(`agent:${inputs.pipeline}`)) {
    throw new Error('Unsupported manual dispatch pipeline');
  }
  return {
    kind: 'intent',
    intent: makeIntent({
      task,
      sourceKind: 'manual',
      sourceId,
      transportRunId: context.runId,
      occurredAt: context.now,
      // Validated two lines up: AGENT_LABELS' keys are exactly
      // `agent:claude`/`agent:codex`/`agent:opencode`, so the has() check
      // above already proved inputs.pipeline is one of those three names.
      pipeline: inputs.pipeline as AgentPipeline,
      mode: inputs.mode || 'implement',
      reply: inputs.reply || '',
      runbook: inputs.runbook || '',
      context: inputs.context || '',
      authorization: auth,
    }),
  };
}

function normalizeEvent({
  eventName,
  event,
  inputs = {},
  context,
  timeline = [],
  maintainer,
}: {
  eventName: string;
  event: WebhookEvent;
  inputs?: WorkflowDispatchInputs;
  context: NormalizeContext;
  timeline?: TimelineEvent[];
  maintainer: string | undefined;
}): NormalizedEvent {
  // The privileged Action lane uses pull_request_target so its workflow and
  // checked-out broker bundle come from trusted main. Preserve the historical
  // pull_request spelling inside semantic identity and source derivation so
  // the transport switch cannot mint a second intent for the same delivery.
  const semanticEventName =
    eventName === 'pull_request_target' ? 'pull_request' : eventName;
  const issue = event.issue ?? event.pull_request;
  if (semanticEventName === 'workflow_dispatch') {
    return normalizeWorkflowDispatch({
      inputs,
      context,
      maintainer,
      issue: event.issue,
    });
  }
  if (!issue) return { kind: 'ignored', reason: 'event has no issue' };
  const task = taskRef(context, issue);
  const pipeline = selectedPipeline(issue);

  if (semanticEventName === 'issue_comment' && event.action === 'created') {
    const parsed = parseExactCommand(event.comment?.body ?? '');
    if (!parsed) return { kind: 'ignored', reason: 'no exact agent command' };
    // `@agent` (#573) carries no pipeline of its own (parsed.pipeline is
    // the `null` sentinel) -- resolve it from whichever agent:* label the
    // issue currently, unambiguously carries. An absent or ambiguous label
    // leaves nothing to resolve against; fail closed rather than guessing,
    // same posture as every other "can't disambiguate" case in this file.
    const resolvedPipeline = parsed.pipeline ?? pipeline;
    if (!resolvedPipeline) {
      throw new Error(
        'Generic @agent command has no unambiguous agent:* label to resolve against',
      );
    }
    const isPullRequest = Boolean(issue.pull_request);
    if (
      pipeline !== resolvedPipeline &&
      !(isPullRequest && resolvedPipeline === 'claude')
    ) {
      throw new Error(
        'Comment command does not match the selected integration',
      );
    }
    // `event.comment` is guaranteed by eventName === 'issue_comment' &&
    // event.action === 'created' -- the same real-GitHub-webhook guarantee
    // the untyped original relied on without checking.
    const comment = event.comment;
    if (!comment) {
      throw new Error('issue_comment:created event missing comment');
    }
    const auth = authorization(
      event.sender?.login,
      maintainer,
      AUTHORIZATION_RULES.OWNER_COMMENT,
      {
        association: comment.author_association,
        userType: comment.user?.type,
      },
    );
    if (
      !auth.authorized ||
      auth.association !== 'OWNER' ||
      auth.userType === 'Bot'
    ) {
      throw new Error('Unauthorized comment dispatch');
    }
    return {
      kind: 'intent',
      intent: makeIntent({
        task,
        sourceKind: 'comment',
        sourceId: `comment:${comment.id}`,
        transportRunId: context.runId,
        occurredAt: comment.created_at,
        pipeline: resolvedPipeline,
        mode: 'reply',
        reply: comment.body,
        runbook: '',
        context: '',
        authorization: auth,
      }),
    };
  }

  if (semanticEventName === 'pull_request') {
    if (['closed', 'reopened'].includes(event.action)) {
      if (!issue.id || Number.isNaN(Date.parse(issue.updated_at))) {
        throw new Error('Malformed pull request anchor event');
      }
      return {
        kind: 'anchor-control',
        task,
        control: {
          // Array.prototype.includes() doesn't narrow a string the way an
          // === chain does; the check two lines up already restricts
          // event.action to exactly these two values.
          kind: event.action as 'closed' | 'reopened',
          sourceId: `pull-request:${issue.id}:${event.action}:${issue.updated_at}`,
          occurredAt: issue.updated_at,
          transportRunId: context.runId,
          authorization: { observed: true, actor: event.sender?.login },
          merged: event.action === 'closed' && Boolean(issue.merged),
        },
      };
    }
    // `labeled`/`unlabeled` falls through to the shared handling below,
    // shared with the `issues` event's own labeled/unlabeled branch.
    // agent:* on a pull request means the same thing it means on an issue
    // -- take it over, `mode: 'implement'`, push commits to its branch --
    // while review:* (pull requests only) means `mode: 'review'`: leave a
    // review, don't push.
    if (!['labeled', 'unlabeled'].includes(event.action)) {
      return { kind: 'ignored', reason: 'unsupported pull request action' };
    }
  }

  if (!['issues', 'pull_request'].includes(semanticEventName))
    return { kind: 'ignored', reason: 'unsupported event' };
  const auth = authorization(
    event.sender?.login,
    maintainer,
    AUTHORIZATION_RULES.MAINTAINER_ISSUE_EVENT,
  );

  if (event.action === 'opened') {
    const quickTask = quickTaskRequest(issue, context.repository, pipeline);
    if (!quickTask) return { kind: 'ignored', reason: 'ordinary opened issue' };
    if (!auth.authorized)
      throw new Error('Unauthorized Quick Task opened event');
    return {
      kind: 'intent',
      intent: makeIntent({
        task,
        intentId: `quick:${quickTask.requestId}:${quickTask.digest}`,
        sourceKind: 'opened',
        sourceId: `issue:${issue.id}`,
        transportRunId: context.runId,
        occurredAt: issue.created_at,
        // quickTaskRequest() above only ever returns a result when its own
        // `pipeline` argument (this same variable) was truthy -- otherwise
        // it throws before returning -- so `pipeline` is proven defined by
        // `quickTask` having a value at all.
        pipeline: pipeline as AgentPipeline,
        mode: 'implement',
        reply: '',
        runbook: '',
        context: '',
        authorization: auth,
      }),
    };
  }

  if (['labeled', 'unlabeled', 'closed', 'reopened'].includes(event.action)) {
    const source = timelineSource(timeline, semanticEventName, event);
    if (event.action === 'closed' || event.action === 'reopened') {
      return {
        kind: 'anchor-control',
        task,
        control: {
          kind: event.action,
          ...source,
          transportRunId: context.runId,
          authorization: { observed: true, actor: event.sender?.login },
          merged: Boolean(issue.pull_request && issue.merged_at),
        },
      };
    }
    // review:* only means anything on a pull request -- there is no diff
    // to review on a plain issue -- so it is not a recognized label prefix
    // at all on an `issues` event; agent:* is recognized on either.
    const labelName = event.label?.name;
    const isReviewLabel =
      semanticEventName === 'pull_request' &&
      Boolean(labelName?.startsWith('review:'));
    // #720: status:needs-human is now a real dispatch-admission gate, so
    // both edges must reach the serialized broker even though neither is a
    // new intent. `labeled` makes a park observable in the ledger; more
    // importantly, `unlabeled` wakes dispatchAccepted immediately so a held
    // accepted generation resumes without waiting for the next scheduled
    // reconciliation pass. Authorization is observational here, matching
    // close/reopen control: the broker re-reads the live label at dispatch
    // time and never trusts this event payload as the gate itself.
    if (labelName === 'status:needs-human') {
      return {
        kind: 'control-evidence',
        task,
        evidence: {
          sourceKind: event.action,
          ...source,
          transportRunId: context.runId,
          label: labelName,
          authorization: { observed: true, actor: event.sender?.login },
        },
      };
    }
    if (!labelName?.startsWith('agent:') && !isReviewLabel) {
      return { kind: 'ignored', reason: 'non-agent label event' };
    }
    // labelName was already proven to start with 'agent:' or 'review:'
    // above -- the only way past the guard just above; `isReviewLabel` can
    // only be true when `labelName` is too.
    if (!labelName) {
      throw new Error('Label event missing its own label name');
    }
    const labelMap = isReviewLabel ? REVIEW_LABELS : AGENT_LABELS;
    const labelKind = isReviewLabel ? 'review' : 'agent';
    if (event.action === 'unlabeled') {
      return {
        kind: 'control-evidence',
        task,
        evidence: {
          sourceKind: 'unlabeled',
          ...source,
          transportRunId: context.runId,
          label: labelName,
          authorization: { observed: true, actor: event.sender?.login },
        },
      };
    }
    if (!auth.authorized) throw new Error('Unauthorized label dispatch');
    // labelName was already proven to start with 'agent:' or 'review:'
    // above -- the only way past the `!labelName?.startsWith(...)` guard.
    const eventPipeline = labelMap.get(labelName);
    if (!eventPipeline)
      return { kind: 'ignored', reason: `unknown ${labelKind} label` };
    const selectedLabelsInNamespace = labelsOf(issue).filter((label) =>
      labelMap.has(label),
    );
    // A manual GitHub UI relabel adds the new agent:*/review:* label before
    // removing the old one, so this `labeled` event can fire inside a
    // transient dual-label window (the old pre-broker router self-healed
    // this; #304's audit found the broker did not). When this event's own
    // label disambiguates against exactly one other label already on the
    // issue *within the same namespace* (agent:* only contends with other
    // agent:* labels; review:* only with other review:* labels -- the two
    // families coexist freely), self-heal: honor the newest explicit
    // maintainer action (the event's own label) as authoritative and mark
    // the other as stale so main.mjs can remove it before dispatching.
    // Anything less clear-cut -- the event's label missing from the
    // current snapshot, or two or more other labels present in that same
    // namespace -- stays genuinely ambiguous and fails closed, same as a
    // comment/dispatch arriving with no event label to disambiguate.
    let effectivePipeline = selectedPipelineFrom(labelsOf(issue), labelMap);
    let staleAgentLabels: string[] | undefined;
    if (selectedLabelsInNamespace.length > 1) {
      const otherLabelsInNamespace = selectedLabelsInNamespace.filter(
        (label) => label !== labelName,
      );
      if (
        !selectedLabelsInNamespace.includes(labelName) ||
        otherLabelsInNamespace.length !== 1
      ) {
        throw new Error(`Issue has contradictory ${labelKind} labels`);
      }
      staleAgentLabels = otherLabelsInNamespace;
      effectivePipeline = eventPipeline;
    }
    const quickTask = quickTaskRequest(
      issue,
      context.repository,
      effectivePipeline,
    );
    return {
      kind: 'intent',
      intent: makeIntent({
        task,
        ...(quickTask && {
          intentId: `quick:${quickTask.requestId}:${quickTask.digest}`,
        }),
        sourceKind: 'labeled',
        ...source,
        transportRunId: context.runId,
        pipeline: eventPipeline,
        mode: isReviewLabel ? 'review' : 'implement',
        reply: '',
        runbook: '',
        context: '',
        dispatchable: effectivePipeline === eventPipeline,
        ...(staleAgentLabels && { staleAgentLabels }),
        authorization: auth,
      }),
    };
  }
  return { kind: 'ignored', reason: 'unsupported issue action' };
}

export {
  digestQuickTask,
  makeIntent,
  normalizeEvent,
  parseExactCommand,
  quickTaskRequest,
  REVIEW_LABELS,
  selectedPipeline,
  selectedPipelineFrom,
  timelineSource,
};
