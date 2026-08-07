import crypto from 'node:crypto';

import {
  AGENT_LABELS,
  GENERIC_REPLY_COMMAND,
  quickTaskDigest,
  quickTaskMarkerMatcher,
  REPLY_COMMANDS,
  REVIEW_LABELS,
  WORKER_WORKFLOW_FILES,
} from '../../../libs/dispatch-contracts/src/index.js';
import { digest } from './broker.mjs';
import {
  authorization,
  AUTHORIZATION_RULES,
} from './modules/authorization.mjs';

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
const sha256Hex = (input) =>
  crypto.createHash('sha256').update(input).digest('hex');

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
}

function selectedPipelineFrom(labels, labelMap) {
  const selected = labels
    .filter((label) => labelMap.has(label))
    .map((label) => labelMap.get(label));
  return selected.length === 1 ? selected[0] : undefined;
}

function selectedPipeline(issue) {
  return selectedPipelineFrom(labelsOf(issue), AGENT_LABELS);
}

function parseExactCommand(body) {
  let fenced = false;
  const matches = [];
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

function quickTaskRequest(issue, repository, pipeline) {
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
  if (body.slice(matches[0].index + marker.length).trim()) {
    throw new Error('Quick Task marker must be the final body element');
  }
  if (originalPipeline !== pipeline) return undefined;
  return { requestId, digest: persistedDigest };
}

function digestQuickTask(identity) {
  return quickTaskDigest(identity, sha256Hex);
}

function timelineSource(timeline, eventName, event) {
  const action = event.action;
  const targetTime = Date.parse((event.issue ?? event.pull_request).updated_at);
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

// Shared by the `canary` and manual-dispatch workflow_dispatch branches
// below: both accept an optional caller-supplied `caller_id` for a stable
// sourceId (falling back to the actions run identity), and both must
// validate it as a UUID when present -- differing only in the error
// message's label.
function resolveCallerSourceId(inputs, context, label) {
  const sourceId = inputs.caller_id || `actions-run:${context.runId}`;
  if (inputs.caller_id && !UUID.test(inputs.caller_id)) {
    throw new Error(`${label} caller ID must be a UUID`);
  }
  return sourceId;
}

function taskRef(context, issue) {
  const repository = context.repository;
  const repositoryId = Number(context.repositoryId);
  const issueNumber = Number(issue?.number ?? context.issue);
  return { repositoryId, repository, issue: issueNumber };
}

function makeIntent(base) {
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

function normalizeWorkflowDispatch({ inputs, context, maintainer }) {
  const task = taskRef(context, undefined);
  // Fired by dispatch-reconcile.yml's scan job (#305), one workflow_dispatch
  // call per already-discovered open agent-labeled issue/PR -- see
  // main.mjs's dispatchReconcileScan(). Carries no claims about ledger
  // state (unlike `completion`, which binds a specific run/generation/token
  // that must be validated to prevent a forged completion), so there is
  // nothing here to authorize or validate beyond the issue identity itself:
  // it is a maintenance ping meaning "re-observe this issue's ledger against
  // live GitHub state", and every repair broker()'s `reconcile` branch can
  // perform is already a safe, idempotent, evidence-preserving observation
  // (never a blind trust of caller-supplied state). workflow_dispatch itself
  // already requires repo write access to trigger manually, and the
  // scheduled trigger only ever comes from this repo's own trusted
  // dispatch-reconcile.yml job.
  if (inputs.kind === 'reconcile') {
    return { kind: 'reconcile', task };
  }
  if (inputs.kind === 'completion') {
    let completion;
    try {
      completion = JSON.parse(
        Buffer.from(inputs.completion_payload, 'base64url').toString('utf8'),
      );
    } catch {
      throw new Error('Completion payload is malformed');
    }
    if (
      !Number.isSafeInteger(completion.workerRunId) ||
      completion.workerRunId <= 0 ||
      !Number.isSafeInteger(completion.generation) ||
      completion.generation <= 0 ||
      !/^[A-Za-z0-9._:-]{1,200}$/u.test(completion.intentId ?? '') ||
      !/^[A-Za-z0-9_-]{16,200}$/u.test(completion.token ?? '') ||
      !WORKER_WORKFLOWS.has(completion.workflow)
    ) {
      throw new Error('Completion payload has invalid binding fields');
    }
    return {
      kind: 'completion',
      task,
      sourceKind: 'completion',
      sourceId: `worker-run:${completion.workerRunId}`,
      transportRunId: context.runId,
      workerRunId: completion.workerRunId,
      generation: completion.generation,
      intentId: completion.intentId,
      token: completion.token,
      workflow: completion.workflow,
    };
  }
  if (inputs.kind === 'canary') {
    // Fired exclusively by this repo's own trusted dispatch-canary.yml
    // (hourly + workflow_dispatch) or post-deploy-smoke.yml (#307), which
    // created `task.issue` moments earlier via GITHUB_TOKEN specifically so
    // it could dispatch this. Like `reconcile` above, this bypasses
    // per-actor authorization: triggering a workflow_dispatch already
    // requires repo write access (the caller's own `actions: write`
    // permission), and unlike the manual `intent` path below, `pipeline`
    // is hardcoded to 'canary' here rather than caller-supplied, so this
    // can never be used to smuggle an unauthorized claude/codex/opencode
    // dispatch. broker.mjs's isDispatchPipeline gate and normalize.mjs's own
    // WORKER_WORKFLOWS gate independently pin this to the dedicated no-op
    // agent-dispatch-canary.yml worker.
    const sourceId = resolveCallerSourceId(inputs, context, 'Canary dispatch');
    return {
      kind: 'intent',
      intent: makeIntent({
        task,
        sourceKind: 'canary',
        sourceId,
        transportRunId: context.runId,
        occurredAt: context.now,
        pipeline: 'canary',
        mode: 'implement',
        reply: '',
        runbook: '',
        context: '',
        authorization: {
          authorized: true,
          actor: context.actor,
          configuredMaintainer: maintainer,
          rule: AUTHORIZATION_RULES.CANARY_SCHEDULED_DISPATCH,
        },
      }),
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
      pipeline: inputs.pipeline,
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
}) {
  if (eventName === 'workflow_dispatch') {
    return normalizeWorkflowDispatch({ inputs, context, maintainer });
  }
  const issue = event.issue ?? event.pull_request;
  if (!issue) return { kind: 'ignored', reason: 'event has no issue' };
  const task = taskRef(context, issue);
  const pipeline = selectedPipeline(issue);

  if (eventName === 'issue_comment' && event.action === 'created') {
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
    const auth = authorization(
      event.sender?.login,
      maintainer,
      AUTHORIZATION_RULES.OWNER_COMMENT,
      {
        association: event.comment.author_association,
        userType: event.comment.user?.type,
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
        sourceId: `comment:${event.comment.id}`,
        transportRunId: context.runId,
        occurredAt: event.comment.created_at,
        pipeline: resolvedPipeline,
        mode: 'reply',
        reply: event.comment.body,
        runbook: '',
        context: '',
        authorization: auth,
      }),
    };
  }

  if (eventName === 'pull_request') {
    if (['closed', 'reopened'].includes(event.action)) {
      if (!issue.id || Number.isNaN(Date.parse(issue.updated_at))) {
        throw new Error('Malformed pull request anchor event');
      }
      return {
        kind: 'anchor-control',
        task,
        control: {
          kind: event.action,
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

  if (!['issues', 'pull_request'].includes(eventName))
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
        pipeline,
        mode: 'implement',
        reply: '',
        runbook: '',
        context: '',
        authorization: auth,
      }),
    };
  }

  if (['labeled', 'unlabeled', 'closed', 'reopened'].includes(event.action)) {
    const source = timelineSource(timeline, eventName, event);
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
      eventName === 'pull_request' && Boolean(labelName?.startsWith('review:'));
    if (!labelName?.startsWith('agent:') && !isReviewLabel) {
      return { kind: 'ignored', reason: 'non-agent label event' };
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
          label: event.label.name,
          authorization: { observed: true, actor: event.sender?.login },
        },
      };
    }
    if (!auth.authorized) throw new Error('Unauthorized label dispatch');
    const eventPipeline = labelMap.get(event.label.name);
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
    let staleAgentLabels;
    if (selectedLabelsInNamespace.length > 1) {
      const otherLabelsInNamespace = selectedLabelsInNamespace.filter(
        (label) => label !== event.label.name,
      );
      if (
        !selectedLabelsInNamespace.includes(event.label.name) ||
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
