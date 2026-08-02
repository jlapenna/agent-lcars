import crypto from 'node:crypto';

import { digest } from './broker.mjs';

const AGENT_LABELS = new Map([
  ['agent:claude', 'claude'],
  ['agent:codex', 'codex'],
  ['agent:opencode', 'opencode'],
]);
const COMMANDS = new Map([
  ['@claude', 'claude'],
  ['/codex', 'codex'],
  ['/opencode', 'opencode'],
  ['/oc', 'opencode'],
]);
const WORKER_WORKFLOWS = new Set(['claude.yml', 'codex.yml', 'opencode.yml']);
const QUICK_TASK_MARKER =
  /<!-- agent-lcars:quick-task-request:v1 id=([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) digest=([0-9a-f]{64}) -->/gu;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
}

function selectedPipeline(issue) {
  const selected = labelsOf(issue)
    .filter((label) => AGENT_LABELS.has(label))
    .map((label) => AGENT_LABELS.get(label));
  return selected.length === 1 ? selected[0] : undefined;
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
  const matches = [...body.matchAll(QUICK_TASK_MARKER)];
  QUICK_TASK_MARKER.lastIndex = 0;
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
  const expectedDigest = digestQuickTask({
    repository,
    pipeline,
    title: issue.title,
    description,
  });
  if (persistedDigest !== expectedDigest) {
    throw new Error('Quick Task marker digest mismatch');
  }
  if (body.slice(matches[0].index + marker.length).trim()) {
    throw new Error('Quick Task marker must be the final body element');
  }
  return { requestId, digest: persistedDigest };
}

function digestQuickTask({ repository, pipeline, title, description }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ repository, pipeline, title, description }))
    .digest('hex');
}

function timelineSource(timeline, eventName, event) {
  const action = event.action;
  const targetTime = Date.parse(event.issue.updated_at);
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

function taskRef(context, issue) {
  const repository = context.repository;
  const repositoryId = Number(context.repositoryId);
  const issueNumber = Number(issue?.number ?? context.issue);
  return { repositoryId, repository, issue: issueNumber };
}

function authorization(actor, maintainer, rule, extra = {}) {
  return {
    authorized: actor === maintainer,
    actor,
    configuredMaintainer: maintainer,
    rule,
    ...extra,
  };
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
  const sourceId = inputs.caller_id || `actions-run:${context.runId}`;
  if (inputs.caller_id && !UUID.test(inputs.caller_id)) {
    throw new Error('Manual dispatch caller ID must be a UUID');
  }
  const auth = authorization(context.actor, maintainer, 'manual-maintainer');
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
    const isPullRequest = Boolean(issue.pull_request);
    if (
      pipeline !== parsed.pipeline &&
      !(isPullRequest && parsed.pipeline === 'claude')
    ) {
      throw new Error(
        'Comment command does not match the selected integration',
      );
    }
    const auth = authorization(
      event.sender?.login,
      maintainer,
      'owner-comment',
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
        pipeline: parsed.pipeline,
        mode: 'reply',
        reply: event.comment.body,
        runbook: '',
        context: '',
        authorization: auth,
      }),
    };
  }

  if (eventName === 'pull_request') {
    if (!['closed', 'reopened'].includes(event.action)) {
      return { kind: 'ignored', reason: 'unsupported pull request action' };
    }
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

  if (eventName !== 'issues')
    return { kind: 'ignored', reason: 'unsupported event' };
  const auth = authorization(
    event.sender?.login,
    maintainer,
    'maintainer-issue-event',
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
    if (!event.label?.name?.startsWith('agent:')) {
      return { kind: 'ignored', reason: 'non-agent label event' };
    }
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
    const eventPipeline = AGENT_LABELS.get(event.label.name);
    if (!eventPipeline)
      return { kind: 'ignored', reason: 'unknown agent label' };
    const selectedAgentLabels = labelsOf(issue).filter((label) =>
      AGENT_LABELS.has(label),
    );
    // A manual GitHub UI relabel adds the new agent:* label before removing
    // the old one, so this `labeled` event can fire inside a transient
    // dual-label window (the old pre-broker router self-healed this; #304's
    // audit found the broker did not). When this event's own label
    // disambiguates against exactly one other agent:* label already on the
    // issue, self-heal: honor the newest explicit maintainer action (the
    // event's own label) as authoritative and mark the other as stale so
    // main.mjs can remove it before dispatching. Anything less clear-cut --
    // the event's label missing from the current snapshot, or two or more
    // other labels present -- stays genuinely ambiguous and fails closed,
    // same as a comment/dispatch arriving with no event label to
    // disambiguate.
    let effectivePipeline = pipeline;
    let staleAgentLabels;
    if (selectedAgentLabels.length > 1) {
      const otherAgentLabels = selectedAgentLabels.filter(
        (label) => label !== event.label.name,
      );
      if (
        !selectedAgentLabels.includes(event.label.name) ||
        otherAgentLabels.length !== 1
      ) {
        throw new Error('Issue has contradictory agent labels');
      }
      staleAgentLabels = otherAgentLabels;
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
        mode: 'implement',
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
  normalizeEvent,
  parseExactCommand,
  quickTaskRequest,
  selectedPipeline,
  timelineSource,
};
