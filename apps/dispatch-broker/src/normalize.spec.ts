import assert from 'node:assert/strict';

import {
  WEBHOOK_INGRESS_CANARY_MARKER,
  WEBHOOK_INGRESS_CANARY_TITLE,
} from '@agent-lcars/dispatch-contracts';
import { test } from 'vitest';

import {
  digestQuickTask,
  normalizeEvent,
  parseExactCommand,
  timelineSource,
} from './normalize.js';

const context = {
  repository: 'jlapenna/agent-lcars',
  repositoryId: 123,
  issue: 304,
  runId: 9001,
  actor: 'jlapenna',
  now: '2026-08-01T00:00:01.000Z',
};
const baseIssue = {
  id: 3040,
  number: 304,
  title: 'Fix dispatch',
  body: 'Do the work',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  labels: [{ name: 'agent:codex' }],
};

function timeline(event, overrides = {}) {
  return [
    {
      id: 77,
      event,
      created_at: baseIssue.updated_at,
      actor: { login: 'jlapenna' },
      label: { name: 'agent:codex' },
      ...overrides,
    },
  ];
}

function issueEvent(action, overrides = {}) {
  return {
    action,
    issue: baseIssue,
    label: { name: 'agent:codex' },
    sender: { login: 'jlapenna' },
    ...overrides,
  };
}

function prEvent(action, overrides = {}) {
  return {
    action,
    pull_request: { ...baseIssue, id: 8080 },
    label: { name: 'agent:codex' },
    sender: { login: 'jlapenna' },
    ...overrides,
  };
}

test('the webhook ingress sentinel can never become dispatch work (#796)', () => {
  const sentinel = {
    ...baseIssue,
    title: WEBHOOK_INGRESS_CANARY_TITLE,
    body: WEBHOOK_INGRESS_CANARY_MARKER,
  };
  for (const candidate of [
    {
      eventName: 'issues',
      event: issueEvent('labeled', { issue: sentinel }),
    },
    {
      eventName: 'issue_comment',
      event: issueEvent('created', {
        issue: sentinel,
        comment: {
          id: 1,
          body: '/codex',
          created_at: context.now,
          author_association: 'OWNER',
          user: { login: 'jlapenna', type: 'User' },
        },
      }),
    },
    {
      eventName: 'workflow_dispatch',
      event: { action: '', issue: sentinel },
      inputs: {
        issue: String(sentinel.number),
        pipeline: 'codex',
        mode: 'implement',
        caller_id: '11111111-1111-4111-8111-111111111111',
      },
    },
  ]) {
    assert.deepEqual(
      normalizeEvent({
        ...candidate,
        context,
        maintainer: 'jlapenna',
      }),
      { kind: 'ignored', reason: 'webhook ingress canary sentinel' },
    );
  }

  const closed = normalizeEvent({
    eventName: 'issues',
    event: issueEvent('closed', { issue: sentinel }),
    context,
    timeline: timeline('closed', { label: undefined }),
    maintainer: 'jlapenna',
  });
  assert.equal(closed.kind, 'anchor-control');
  assert.equal(closed.control.kind, 'closed');
});

test('exact command parsing accepts command lines and rejects prose, quotes, and code', () => {
  assert.deepEqual(parseExactCommand('/codex please continue'), {
    command: '/codex',
    pipeline: 'codex',
  });
  assert.equal(parseExactCommand('I mentioned /codex in prose'), undefined);
  assert.equal(parseExactCommand('> /codex old command'), undefined);
  assert.equal(parseExactCommand('```\n/codex\n```'), undefined);
  assert.equal(parseExactCommand('/codexify'), undefined);
  assert.equal(parseExactCommand('/codex\n@claude'), undefined);
});

test('exact command parsing recognizes the generic @agent command (#573)', () => {
  assert.deepEqual(parseExactCommand('@agent please retry'), {
    command: '@agent',
    pipeline: null,
  });
  assert.equal(parseExactCommand('I mentioned @agent in prose'), undefined);
  assert.equal(parseExactCommand('@agent\n/codex'), undefined);
});

test('manual dispatch requires maintainer authorization and a stable caller UUID', () => {
  const normalized = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: {
      issue: '304',
      pipeline: 'codex',
      mode: 'implement',
      caller_id: '11111111-1111-4111-8111-111111111111',
    },
    context,
    maintainer: 'jlapenna',
  });
  assert.equal(
    normalized.intent.sourceId,
    '11111111-1111-4111-8111-111111111111',
  );
  assert.equal(normalized.intent.authorization.authorized, true);
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'workflow_dispatch',
        event: {},
        inputs: { issue: '304', pipeline: 'codex', caller_id: 'not-a-uuid' },
        context,
        maintainer: 'jlapenna',
      }),
    /UUID/u,
  );
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'workflow_dispatch',
        event: {},
        inputs: { issue: '304', pipeline: 'codex' },
        context: { ...context, actor: 'collaborator' },
        maintainer: 'jlapenna',
      }),
    /Unauthorized/u,
  );
});

test('reconcile dispatch normalizes to a bare TaskRef ping, carrying no evidence and requiring no actor authorization (#305)', () => {
  const normalized = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: { kind: 'reconcile', issue: '304' },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.deepEqual(normalized, {
    kind: 'reconcile',
    task: { repositoryId: 123, repository: 'jlapenna/agent-lcars', issue: 304 },
  });

  // Unlike the default (intent) kind, a `reconcile` ping never requires the
  // triggering actor to be the configured maintainer -- dispatch-
  // reconcile.yml's own scan job fires it as github-actions[bot], and a
  // manual forensic run can legitimately come from any collaborator with
  // repo write access (the same access workflow_dispatch itself already
  // requires). It carries no claims to authorize: every repair it can
  // trigger is a safe, idempotent, evidence-preserving re-observation.
  const fromCollaborator = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: { kind: 'reconcile', issue: '304' },
    context: { ...context, actor: 'some-collaborator' },
    maintainer: 'jlapenna',
  });
  assert.equal(fromCollaborator.kind, 'reconcile');
});

// #663: main.mjs's normalize() already fetches the live issue for every
// workflow_dispatch (see its own header comment) -- a `reconcile` ping
// threads that fetch's `state` through as `issueClosed` so main.mjs's
// reconcileControlState can converge a stale `control.closed` without a
// second GET of its own. Both directions, and the "state truly unknown"
// fallback above, are covered here.
test("reconcile dispatch threads the live issue's open/closed state through as issueClosed (#663)", () => {
  const closed = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: { issue: { ...baseIssue, state: 'closed' } },
    inputs: { kind: 'reconcile', issue: '304' },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.equal(closed.issueClosed, true);

  const open = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: { issue: { ...baseIssue, state: 'open' } },
    inputs: { kind: 'reconcile', issue: '304' },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.equal(open.issueClosed, false);

  // An unrecognized/missing state must not be coerced into a claim either
  // way -- `issueClosed` stays entirely absent from the normalized event
  // (not `undefined`-valued), matching the no-`event.issue` case above.
  const unknown = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: { issue: { ...baseIssue, state: undefined } },
    inputs: { kind: 'reconcile', issue: '304' },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.equal('issueClosed' in unknown, false);
});

test('Actions-tab dispatch falls back to stable workflow run identity', () => {
  const normalized = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: { issue: '304', pipeline: 'claude' },
    context,
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.intent.sourceId, 'actions-run:9001');
});

test('canary dispatch normalizes to a hardcoded canary-pipeline intent, requiring no actor authorization (#307)', () => {
  const normalized = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: { kind: 'canary', issue: '304' },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'intent');
  assert.equal(normalized.intent.pipeline, 'canary');
  assert.equal(normalized.intent.sourceKind, 'canary');
  assert.equal(normalized.intent.authorization.authorized, true);
  assert.equal(normalized.intent.sourceId, 'actions-run:9001');

  // Unlike the default (intent) kind, a `canary` dispatch never requires the
  // triggering actor to be the configured maintainer -- dispatch-canary.yml
  // and post-deploy-smoke.yml fire it as github-actions[bot]. `pipeline` is
  // hardcoded to 'canary' regardless of any caller input, so this path can
  // never be used to smuggle an unauthorized claude/codex/opencode dispatch.
  const fromCollaborator = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: { kind: 'canary', issue: '304', pipeline: 'claude' },
    context: { ...context, actor: 'some-collaborator' },
    maintainer: 'jlapenna',
  });
  assert.equal(fromCollaborator.intent.pipeline, 'canary');

  const withCallerId = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: {
      kind: 'canary',
      issue: '304',
      caller_id: '11111111-1111-4111-8111-111111111111',
    },
    context,
    maintainer: 'jlapenna',
  });
  assert.equal(
    withCallerId.intent.sourceId,
    '11111111-1111-4111-8111-111111111111',
  );

  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'workflow_dispatch',
        event: {},
        inputs: { kind: 'canary', issue: '304', caller_id: 'not-a-uuid' },
        context,
        maintainer: 'jlapenna',
      }),
    /UUID/u,
  );
});

test('comment dispatch requires one exact command, owner association, and matching integration', () => {
  const event = {
    action: 'created',
    issue: baseIssue,
    sender: { login: 'jlapenna' },
    comment: {
      id: 12345,
      body: '/codex continue',
      created_at: context.now,
      author_association: 'OWNER',
      user: { type: 'User' },
    },
  };
  const normalized = normalizeEvent({
    eventName: 'issue_comment',
    event,
    context,
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.intent.sourceId, 'comment:12345');
  assert.equal(normalized.intent.mode, 'reply');
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issue_comment',
        event: {
          ...event,
          comment: { ...event.comment, author_association: 'COLLABORATOR' },
        },
        context,
        maintainer: 'jlapenna',
      }),
    /Unauthorized/u,
  );
});

test('generic @agent comment resolves to whichever pipeline the issue is currently labeled (#573)', () => {
  // baseIssue carries exactly one agent:* label (agent:codex) -- @agent
  // must resolve to that without the commenter naming it.
  const normalized = normalizeEvent({
    eventName: 'issue_comment',
    event: {
      action: 'created',
      issue: baseIssue,
      sender: { login: 'jlapenna' },
      comment: {
        id: 12346,
        body: '@agent please retry',
        created_at: context.now,
        author_association: 'OWNER',
        user: { type: 'User' },
      },
    },
    context,
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'intent');
  assert.equal(normalized.intent.pipeline, 'codex');
  assert.equal(normalized.intent.sourceId, 'comment:12346');
});

test('generic @agent comment fails closed when the issue carries no unambiguous agent:* label (#573)', () => {
  const unlabeledIssue = { ...baseIssue, labels: [] };
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issue_comment',
        event: {
          action: 'created',
          issue: unlabeledIssue,
          sender: { login: 'jlapenna' },
          comment: {
            id: 12347,
            body: '@agent',
            created_at: context.now,
            author_association: 'OWNER',
            user: { type: 'User' },
          },
        },
        context,
        maintainer: 'jlapenna',
      }),
    /no unambiguous agent:\* label/u,
  );

  const dualLabelIssue = {
    ...baseIssue,
    labels: [{ name: 'agent:claude' }, { name: 'agent:codex' }],
  };
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issue_comment',
        event: {
          action: 'created',
          issue: dualLabelIssue,
          sender: { login: 'jlapenna' },
          comment: {
            id: 12348,
            body: '@agent',
            created_at: context.now,
            author_association: 'OWNER',
            user: { type: 'User' },
          },
        },
        context,
        maintainer: 'jlapenna',
      }),
    /no unambiguous agent:\* label/u,
  );
});

test('pipeline-specific comment commands still require an exact match against the label -- @agent does not relax them', () => {
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issue_comment',
        event: {
          action: 'created',
          // baseIssue is labeled agent:codex; /opencode is a real command
          // for a DIFFERENT pipeline, not the generic one -- must still
          // fail exactly as it did before #573.
          issue: baseIssue,
          sender: { login: 'jlapenna' },
          comment: {
            id: 12349,
            body: '/opencode continue',
            created_at: context.now,
            author_association: 'OWNER',
            user: { type: 'User' },
          },
        },
        context,
        maintainer: 'jlapenna',
      }),
    /does not match the selected integration/u,
  );
});

test('timeline matching fails closed when a label delivery is ambiguous', () => {
  assert.throws(
    () =>
      timelineSource(
        [...timeline('labeled'), ...timeline('labeled', { id: 78 })],
        'issues',
        issueEvent('labeled'),
      ),
    /Ambiguous/u,
  );
});

test('rapid stale relabel normalizes as retained but nondispatchable evidence', () => {
  const event = issueEvent('labeled', {
    issue: { ...baseIssue, labels: [{ name: 'agent:claude' }] },
  });
  const normalized = normalizeEvent({
    eventName: 'issues',
    event,
    context,
    timeline: timeline('labeled'),
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.intent.pipeline, 'codex');
  assert.equal(normalized.intent.dispatchable, false);
});

test('a manual dual-label labeled event self-heals by honoring the event label and marking the other as stale (#304 item 4)', () => {
  // Regression for #304's audit item 4: a manual GitHub UI relabel adds the
  // new agent:* label before removing the old one, so `labeled` can fire
  // while both labels are still on the issue. The event's own label (here
  // agent:claude, matching issueEvent's default `label`) disambiguates
  // against the single other stale label (agent:codex), so this must not
  // throw -- it must dispatch to the event's label and flag the other one
  // for main.mjs to remove.
  const normalized = normalizeEvent({
    eventName: 'issues',
    event: issueEvent('labeled', {
      label: { name: 'agent:claude' },
      issue: {
        ...baseIssue,
        labels: [{ name: 'agent:claude' }, { name: 'agent:codex' }],
      },
    }),
    context,
    timeline: timeline('labeled', { label: { name: 'agent:claude' } }),
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'intent');
  assert.equal(normalized.intent.pipeline, 'claude');
  assert.equal(normalized.intent.dispatchable, true);
  assert.deepEqual(normalized.intent.staleAgentLabels, ['agent:codex']);
});

test('dual agent labels with no event label to disambiguate still fail closed', () => {
  // The comment path never carries an event label -- `selectedPipeline`
  // stays undefined whenever more than one agent:* label is present, so
  // there is nothing to treat as the "newest maintainer action". Unlike the
  // labeled-event case above, this ambiguity is real and must keep failing
  // closed rather than guessing.
  const dualLabelIssue = {
    ...baseIssue,
    labels: [{ name: 'agent:claude' }, { name: 'agent:codex' }],
  };
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issue_comment',
        event: {
          action: 'created',
          issue: dualLabelIssue,
          sender: { login: 'jlapenna' },
          comment: {
            id: 12345,
            body: '/codex continue',
            created_at: context.now,
            author_association: 'OWNER',
            user: { type: 'User' },
          },
        },
        context,
        maintainer: 'jlapenna',
      }),
    /does not match the selected integration/u,
  );
});

test('three or more coexisting agent labels remain genuinely ambiguous and fail closed', () => {
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issues',
        event: issueEvent('labeled', {
          label: { name: 'agent:claude' },
          issue: {
            ...baseIssue,
            labels: [
              { name: 'agent:claude' },
              { name: 'agent:codex' },
              { name: 'agent:opencode' },
            ],
          },
        }),
        context,
        timeline: timeline('labeled', { label: { name: 'agent:claude' } }),
        maintainer: 'jlapenna',
      }),
    /contradictory agent labels/u,
  );
});

test('a follow-on unlabeled event for the self-healed stale label stays control-evidence, never a new intent (no loop)', () => {
  // main.mjs removes the stale label via the API after a self-heal, which
  // fires a genuine `unlabeled` webhook back through the router. That must
  // stay a benign observation -- never re-enter the intent path or throw --
  // regardless of how the label got removed.
  const normalized = normalizeEvent({
    eventName: 'issues',
    event: issueEvent('unlabeled', { label: { name: 'agent:codex' } }),
    context,
    timeline: timeline('unlabeled', { label: { name: 'agent:codex' } }),
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'control-evidence');
  assert.equal(normalized.evidence.label, 'agent:codex');
});

test('unlabeled events are control evidence and never create dispatch intent', () => {
  const normalized = normalizeEvent({
    eventName: 'issues',
    event: issueEvent('unlabeled'),
    context,
    timeline: timeline('unlabeled'),
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'control-evidence');
  assert.equal(normalized.evidence.label, 'agent:codex');
});

test('closed and reopened are serialized control transitions regardless of actor', () => {
  for (const action of ['closed', 'reopened']) {
    const event = issueEvent(action, { sender: { login: 'automation[bot]' } });
    const normalized = normalizeEvent({
      eventName: 'issues',
      event,
      context,
      timeline: timeline(action, { actor: { login: 'automation[bot]' } }),
      maintainer: 'jlapenna',
    });
    assert.equal(normalized.kind, 'anchor-control');
    assert.equal(normalized.control.kind, action);
  }
});

test('pull request close, merge, and reopen become serialized anchor controls', () => {
  for (const [action, merged] of [
    ['closed', false],
    ['closed', true],
    ['reopened', false],
  ]) {
    const normalized = normalizeEvent({
      eventName: 'pull_request',
      event: {
        action,
        pull_request: {
          ...baseIssue,
          id: 8080,
          merged,
        },
        sender: { login: 'automation[bot]' },
      },
      context,
      maintainer: 'jlapenna',
    });
    assert.equal(normalized.kind, 'anchor-control');
    assert.equal(normalized.control.kind, action);
    assert.equal(normalized.control.merged, action === 'closed' && merged);
    assert.match(normalized.control.sourceId, /^pull-request:8080:/u);
  }
});

test('an agent:* labeled event on a pull request dispatches an implement-mode intent, taking it over', () => {
  const normalized = normalizeEvent({
    eventName: 'pull_request',
    event: prEvent('labeled'),
    context,
    timeline: timeline('labeled'),
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'intent');
  assert.equal(normalized.intent.mode, 'implement');
  assert.equal(normalized.intent.pipeline, 'codex');
});

test('pull_request_target preserves pull-request intent identity from trusted main', () => {
  const event = prEvent('labeled');
  const eventTimeline = timeline('labeled');
  const legacy = normalizeEvent({
    eventName: 'pull_request',
    event,
    context,
    timeline: eventTimeline,
    maintainer: 'jlapenna',
  });
  const trustedTarget = normalizeEvent({
    eventName: 'pull_request_target',
    event,
    context,
    timeline: eventTimeline,
    maintainer: 'jlapenna',
  });

  assert.deepEqual(trustedTarget, legacy);
});

test('a review:* labeled event on a pull request dispatches a review-mode intent', () => {
  const normalized = normalizeEvent({
    eventName: 'pull_request',
    event: prEvent('labeled', { label: { name: 'review:codex' } }),
    context,
    timeline: timeline('labeled', { label: { name: 'review:codex' } }),
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'intent');
  assert.equal(normalized.intent.mode, 'review');
  assert.equal(normalized.intent.pipeline, 'codex');
});

test('a review:* label on a plain issue is not a recognized label at all (no diff to review)', () => {
  const normalized = normalizeEvent({
    eventName: 'issues',
    event: issueEvent('labeled', { label: { name: 'review:codex' } }),
    context,
    timeline: timeline('labeled', { label: { name: 'review:codex' } }),
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'ignored');
});

test('agent:* and review:* coexist on a pull request without contradiction -- each dispatches its own mode', () => {
  const issue = {
    ...baseIssue,
    id: 8080,
    labels: [{ name: 'agent:codex' }, { name: 'review:claude' }],
  };
  const agentNormalized = normalizeEvent({
    eventName: 'pull_request',
    event: prEvent('labeled', { pull_request: issue }),
    context,
    timeline: timeline('labeled'),
    maintainer: 'jlapenna',
  });
  assert.equal(agentNormalized.intent.mode, 'implement');
  assert.equal(agentNormalized.intent.pipeline, 'codex');

  const reviewNormalized = normalizeEvent({
    eventName: 'pull_request',
    event: prEvent('labeled', {
      pull_request: issue,
      label: { name: 'review:claude' },
    }),
    context,
    timeline: timeline('labeled', { label: { name: 'review:claude' } }),
    maintainer: 'jlapenna',
  });
  assert.equal(reviewNormalized.intent.mode, 'review');
  assert.equal(reviewNormalized.intent.pipeline, 'claude');
});

test('a pull request unlabeled event stays control-evidence, never an intent (same as an issue)', () => {
  const normalized = normalizeEvent({
    eventName: 'pull_request',
    event: prEvent('unlabeled'),
    context,
    timeline: timeline('unlabeled'),
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'control-evidence');
  assert.equal(normalized.evidence.label, 'agent:codex');
});

test('a pull request labeled event requires maintainer authorization, same as an issue label event', () => {
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'pull_request',
        event: prEvent('labeled', { sender: { login: 'someone-else' } }),
        context,
        timeline: timeline('labeled', { actor: { login: 'someone-else' } }),
        maintainer: 'jlapenna',
      }),
    /Unauthorized label dispatch/u,
  );
});

test('pull request actions other than closed/reopened/labeled/unlabeled are ignored', () => {
  const normalized = normalizeEvent({
    eventName: 'pull_request',
    event: prEvent('synchronize'),
    context,
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'ignored');
});

test('Quick Task opened and labeled transports derive one semantic intent', () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const description = 'Do the work';
  const persistedDigest = digestQuickTask({
    repository: context.repository,
    pipeline: 'codex',
    title: baseIssue.title,
    description,
  });
  const issue = {
    ...baseIssue,
    body: `${description}\n\n<!-- agent-lcars:quick-task-request:v1 id=${requestId} digest=${persistedDigest} -->`,
  };
  const opened = normalizeEvent({
    eventName: 'issues',
    event: issueEvent('opened', { issue }),
    context,
    maintainer: 'jlapenna',
  });
  const labeled = normalizeEvent({
    eventName: 'issues',
    event: issueEvent('labeled', { issue }),
    context,
    timeline: timeline('labeled'),
    maintainer: 'jlapenna',
  });
  assert.equal(opened.intent.intentId, labeled.intent.intentId);
  assert.notEqual(opened.intent.sourceId, labeled.intent.sourceId);
});

test('a later relabel to a different pipeline is an ordinary intent, not a Quick Task digest mismatch (#630)', () => {
  const requestId = '11111111-1111-4111-8111-111111111111';
  const description = 'Do the work';
  const persistedDigest = digestQuickTask({
    repository: context.repository,
    pipeline: 'codex',
    title: baseIssue.title,
    description,
  });
  const issue = {
    ...baseIssue,
    labels: [{ name: 'agent:claude' }],
    body: `${description}\n\n<!-- agent-lcars:quick-task-request:v1 id=${requestId} digest=${persistedDigest} -->`,
  };
  const relabeled = normalizeEvent({
    eventName: 'issues',
    event: issueEvent('labeled', { issue, label: { name: 'agent:claude' } }),
    context,
    timeline: timeline('labeled', { label: { name: 'agent:claude' } }),
    maintainer: 'jlapenna',
  });
  assert.equal(relabeled.kind, 'intent');
  assert.equal(relabeled.intent.pipeline, 'claude');
  assert.equal(relabeled.intent.intentId.startsWith('quick:'), false);
});

test('Quick Task conflicting marker digest and multiple agent labels fail closed', () => {
  const marker = `<!-- agent-lcars:quick-task-request:v1 id=11111111-1111-4111-8111-111111111111 digest=${'0'.repeat(64)} -->`;
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issues',
        event: issueEvent('opened', {
          issue: { ...baseIssue, body: `Do the work\n\n${marker}` },
        }),
        context,
        maintainer: 'jlapenna',
      }),
    /digest mismatch/u,
  );
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issues',
        event: issueEvent('opened', {
          issue: {
            ...baseIssue,
            body: `Do the work\n\n${marker}`,
            labels: [{ name: 'agent:codex' }, { name: 'agent:claude' }],
          },
        }),
        context,
        maintainer: 'jlapenna',
      }),
    /Malformed Quick Task/u,
  );
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issues',
        event: issueEvent('opened', {
          issue: {
            ...baseIssue,
            body: 'Do the work\n\n<!-- agent-lcars:quick-task-request:v1 malformed -->',
          },
        }),
        context,
        maintainer: 'jlapenna',
      }),
    /Malformed Quick Task marker/u,
  );
});

test('completion callback is normalized as evidence, never trusted as a conclusion', () => {
  const completionPayload = Buffer.from(
    JSON.stringify({
      workerRunId: 42,
      generation: 7,
      intentId: 'intent-7',
      token: 'dispatch_token_777777',
      workflow: 'codex.yml',
    }),
  ).toString('base64url');
  const normalized = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: {
      kind: 'completion',
      issue: '304',
      completion_payload: completionPayload,
    },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'completion');
  assert.equal(normalized.workerRunId, 42);
  assert.equal('conclusion' in normalized, false);
});

test('completion callback accepts the canary worker workflow (#307)', () => {
  const completionPayload = Buffer.from(
    JSON.stringify({
      workerRunId: 42,
      generation: 7,
      intentId: 'intent-7',
      token: 'dispatch_token_777777',
      workflow: 'agent-dispatch-canary.yml',
    }),
  ).toString('base64url');
  const normalized = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: {
      kind: 'completion',
      issue: '304',
      completion_payload: completionPayload,
    },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'completion');
  assert.equal(normalized.workflow, 'agent-dispatch-canary.yml');
});

test('completion callback carries only a validated lane-readiness failure signal', () => {
  const valid = {
    workerRunId: 42,
    generation: 7,
    intentId: 'intent-7',
    token: 'dispatch_token_777777',
    workflow: 'codex.yml',
    outcome: 'startup-failure',
    readinessFailure: 'credential',
  };
  const normalized = normalizeEvent({
    eventName: 'workflow_dispatch',
    event: {},
    inputs: {
      kind: 'completion',
      issue: '304',
      completion_payload: Buffer.from(JSON.stringify(valid)).toString(
        'base64url',
      ),
    },
    context: { ...context, actor: 'github-actions[bot]' },
    maintainer: 'jlapenna',
  });
  assert.equal(normalized.kind, 'completion');
  assert.equal(normalized.readinessFailure, 'credential');

  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'workflow_dispatch',
        event: {},
        inputs: {
          kind: 'completion',
          issue: '304',
          completion_payload: Buffer.from(
            JSON.stringify({ ...valid, readinessFailure: 'attacker-value' }),
          ).toString('base64url'),
        },
        context: { ...context, actor: 'github-actions[bot]' },
        maintainer: 'jlapenna',
      }),
    /invalid binding fields/u,
  );
});

test('completion callback preserves only an exact PR reference paired with a PR outcome', () => {
  const valid = {
    workerRunId: 42,
    generation: 7,
    intentId: 'intent-7',
    token: 'dispatch_token_777777',
    workflow: 'codex.yml',
    outcome: 'pull-request',
    outcomeReference: { kind: 'pull-request', number: 755 },
  };
  const normalizeCompletion = (completion) =>
    normalizeEvent({
      eventName: 'workflow_dispatch',
      event: {},
      inputs: {
        kind: 'completion',
        issue: '304',
        completion_payload: Buffer.from(JSON.stringify(completion)).toString(
          'base64url',
        ),
      },
      context: { ...context, actor: 'github-actions[bot]' },
      maintainer: 'jlapenna',
    });

  const normalized = normalizeCompletion(valid);
  assert.equal(normalized.kind, 'completion');
  assert.deepEqual(normalized.outcomeReference, {
    kind: 'pull-request',
    number: 755,
  });

  for (const invalid of [
    { ...valid, outcome: 'comment' },
    { ...valid, outcomeReference: { kind: 'pull-request', number: 0 } },
    { ...valid, outcomeReference: { kind: 'issue', number: 755 } },
  ]) {
    assert.throws(
      () => normalizeCompletion(invalid),
      /invalid binding fields/u,
    );
  }
});

test('completion payload rejects malformed or fabricated binding fields', () => {
  const valid = {
    workerRunId: 42,
    generation: 7,
    intentId: 'intent-7',
    token: 'dispatch_token_777777',
    workflow: 'codex.yml',
  };
  for (const completion of [
    { ...valid, workerRunId: 0 },
    { ...valid, workerRunId: '42' },
    { ...valid, generation: -1 },
    { ...valid, intentId: 'contains spaces' },
    { ...valid, token: 'short' },
    { ...valid, workflow: 'attacker.yml' },
  ]) {
    const completionPayload = Buffer.from(JSON.stringify(completion)).toString(
      'base64url',
    );
    assert.throws(
      () =>
        normalizeEvent({
          eventName: 'workflow_dispatch',
          event: {},
          inputs: {
            kind: 'completion',
            issue: '304',
            completion_payload: completionPayload,
          },
          context: { ...context, actor: 'github-actions[bot]' },
          maintainer: 'jlapenna',
        }),
      /invalid binding fields/u,
    );
  }
});
