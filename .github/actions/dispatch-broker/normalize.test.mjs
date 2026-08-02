import assert from 'node:assert/strict';

import {
  digestQuickTask,
  normalizeEvent,
  parseExactCommand,
  timelineSource,
} from './normalize.mjs';

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

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

test('a contradictory live agent-label selection fails closed', () => {
  assert.throws(
    () =>
      normalizeEvent({
        eventName: 'issues',
        event: issueEvent('labeled', {
          issue: {
            ...baseIssue,
            labels: [{ name: 'agent:claude' }, { name: 'agent:codex' }],
          },
        }),
        context,
        timeline: timeline('labeled'),
        maintainer: 'jlapenna',
      }),
    /contradictory agent labels/u,
  );
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

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
  }
}
if (failures > 0) process.exitCode = 1;
