import { WORK_DESCRIPTION_MAX } from '@agent-lcars/work';
import { afterEach, describe, expect, it } from 'vitest';

import { type IngestResult, interpretDelivery } from './orchestrator-ingest';

// No env vars are set in this test environment, so `controlPlaneRepository()`
// falls back to this deployment's default -- see deployment.ts/.test.ts.
const REPO = 'jlapenna/agent-lcars';
const OTHER_REPO = 'someone-else/other-repo';
const DELIVERY_ID = '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820';

function issuesLabeledPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    repository: { full_name: REPO },
    issue: { number: 42, title: 'Issue title', body: 'Issue body' },
    label: { name: 'agent:claude' },
    ...overrides,
  };
}

function pullRequestLabeledPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    repository: { full_name: REPO },
    pull_request: {
      number: 7,
      title: 'Pull request title',
      body: 'Pull request body',
    },
    label: { name: 'agent:codex' },
    ...overrides,
  };
}

function issueCommentPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    repository: { full_name: REPO },
    issue: { number: 9, title: 'Issue title', body: 'Issue body' },
    comment: {
      body: '@claude please take a look',
      author_association: 'OWNER',
    },
    ...overrides,
  };
}

// The overlong-body case's raw fixture body, and the description
// `truncatedDescription` (work-from-github.ts) derives from it: sliced to
// leave room for the marker, so the total lands exactly at
// WORK_DESCRIPTION_MAX -- see that function's own coverage in
// work-from-github.test.ts for the truncation math itself.
const OVERLONG_BODY = 'x'.repeat(20_000);
const OVERLONG_MARKER =
  `\n\n[work: truncated to ${WORK_DESCRIPTION_MAX} of ${OVERLONG_BODY.length} ` +
  `characters. Read the full body on the issue.]`;
const OVERLONG_DESCRIPTION =
  OVERLONG_BODY.slice(0, WORK_DESCRIPTION_MAX - OVERLONG_MARKER.length) +
  OVERLONG_MARKER;

describe('interpretDelivery', () => {
  const cases: Array<{
    name: string;
    event: string;
    payload: unknown;
    expected: IngestResult;
  }> = [
    {
      name: 'issues labeled agent:claude -> implement/claude',
      event: 'issues',
      payload: issuesLabeledPayload(),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 42 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'implement' },
      },
    },
    {
      name: 'issues labeled agent:codex -> implement/codex',
      event: 'issues',
      payload: issuesLabeledPayload({ label: { name: 'agent:codex' } }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 42 },
        requestId: DELIVERY_ID,
        pipeline: 'codex',
        params: { mode: 'implement' },
      },
    },
    {
      name: 'issues labeled agent:opencode -> implement/opencode',
      event: 'issues',
      payload: issuesLabeledPayload({ label: { name: 'agent:opencode' } }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 42 },
        requestId: DELIVERY_ID,
        pipeline: 'opencode',
        params: { mode: 'implement' },
      },
    },
    {
      name: 'issues labeled with a title/body/sender derives work',
      event: 'issues',
      payload: issuesLabeledPayload({
        issue: { number: 42, title: 'Fix the thing', body: 'Please fix it.' },
        sender: { login: 'jlapenna' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 42 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'implement' },
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'Fix the thing',
            description: 'Please fix it.',
            pipeline: 'claude',
            target: { repo: REPO },
          },
        },
      },
    },
    {
      name: 'issues labeled with a title but no sender falls back to the label',
      event: 'issues',
      payload: issuesLabeledPayload({
        issue: { number: 42, title: 'Fix the thing', body: null },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 42 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'implement' },
        work: {
          origin: { principal: 'github:label:agent:claude', channel: 'github' },
          spec: {
            title: 'Fix the thing',
            description: '(no description)',
            pipeline: 'claude',
            target: { repo: REPO },
          },
        },
      },
    },
    {
      name: 'issues labeled with an overlong body truncates the work description',
      event: 'issues',
      payload: issuesLabeledPayload({
        issue: {
          number: 42,
          title: 'Fix the thing',
          body: OVERLONG_BODY,
        },
        sender: { login: 'jlapenna' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 42 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'implement' },
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'Fix the thing',
            description: OVERLONG_DESCRIPTION,
            pipeline: 'claude',
            target: { repo: REPO },
          },
        },
      },
    },
    {
      // Proves Task 2's derivation covers Quick Tasks for free: the issue
      // Quick Tasks create already carries both QUICK_TASK_LABEL and the
      // pipeline label at creation time (see backend-actions.ts's
      // createQuickTaskOnce), but this webhook's `label` field is always
      // just the one label that triggered this delivery -- identical in
      // shape to any other labeled issue, so no Quick-Task-specific
      // handling is needed here.
      name: 'a Quick Task issue (intake:quick-task + agent:claude labels) derives work like any other labeled issue',
      event: 'issues',
      payload: issuesLabeledPayload({
        issue: {
          number: 55,
          title: 'Quick task: fix the thing',
          body: 'Please fix it.\n\n<!-- agent-lcars:quick-task-request:v1 ... -->',
        },
        label: { name: 'agent:claude' },
        sender: { login: 'jlapenna' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 55 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'implement' },
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'Quick task: fix the thing',
            description:
              'Please fix it.\n\n<!-- agent-lcars:quick-task-request:v1 ... -->',
            pipeline: 'claude',
            target: { repo: REPO },
          },
        },
      },
    },
    {
      name: 'pull_request labeled agent:claude -> implement/claude',
      event: 'pull_request',
      payload: pullRequestLabeledPayload({ label: { name: 'agent:claude' } }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 7 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'implement' },
      },
    },
    {
      name: 'pull_request labeled review:claude -> review/claude',
      event: 'pull_request',
      payload: pullRequestLabeledPayload({ label: { name: 'review:claude' } }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 7 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'review' },
      },
    },
    {
      name: 'pull_request labeled review:codex -> review/codex',
      event: 'pull_request',
      payload: pullRequestLabeledPayload({ label: { name: 'review:codex' } }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 7 },
        requestId: DELIVERY_ID,
        pipeline: 'codex',
        params: { mode: 'review' },
      },
    },
    {
      name: 'pull_request labeled review:opencode -> review/opencode',
      event: 'pull_request',
      payload: pullRequestLabeledPayload({
        label: { name: 'review:opencode' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 7 },
        requestId: DELIVERY_ID,
        pipeline: 'opencode',
        params: { mode: 'review' },
      },
    },
    {
      name: 'pull_request labeled agent:claude with a title/body/sender derives work',
      event: 'pull_request',
      payload: pullRequestLabeledPayload({
        pull_request: { number: 7, title: 'Add the feature', body: 'Adds it.' },
        label: { name: 'agent:claude' },
        sender: { login: 'jlapenna' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 7 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'implement' },
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'Add the feature',
            description: 'Adds it.',
            pipeline: 'claude',
            target: { repo: REPO },
          },
        },
      },
    },
    {
      name: 'pull_request labeled review:codex with a title/body/sender derives work',
      event: 'pull_request',
      payload: pullRequestLabeledPayload({
        pull_request: { number: 7, title: 'Add the feature', body: 'Adds it.' },
        label: { name: 'review:codex' },
        sender: { login: 'jlapenna' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 7 },
        requestId: DELIVERY_ID,
        pipeline: 'codex',
        params: { mode: 'review' },
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'Add the feature',
            description: 'Adds it.',
            pipeline: 'codex',
            target: { repo: REPO },
          },
        },
      },
    },
    {
      name: '@claude comment from OWNER -> reply/claude',
      event: 'issue_comment',
      payload: issueCommentPayload(),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 9 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'reply', reply: '@claude please take a look' },
      },
    },
    {
      name: 'issue_comment reply derives work from the issue being replied to, not the comment',
      event: 'issue_comment',
      payload: issueCommentPayload({
        issue: { number: 9, title: 'Question about X', body: 'Some context.' },
        sender: { login: 'jlapenna' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 9 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'reply', reply: '@claude please take a look' },
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'Question about X',
            description: 'Some context.',
            pipeline: 'claude',
            target: { repo: REPO },
          },
        },
      },
    },
    {
      name: '/codex comment from MEMBER -> reply/codex',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: '/codex fix this please',
          author_association: 'MEMBER',
        },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 9 },
        requestId: DELIVERY_ID,
        pipeline: 'codex',
        params: { mode: 'reply', reply: '/codex fix this please' },
      },
    },
    {
      name: '/oc comment -> reply/opencode',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: { body: '/oc take a look', author_association: 'OWNER' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 9 },
        requestId: DELIVERY_ID,
        pipeline: 'opencode',
        params: { mode: 'reply', reply: '/oc take a look' },
      },
    },
    {
      name: '/opencode comment -> reply/opencode',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: { body: '/opencode take a look', author_association: 'OWNER' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 9 },
        requestId: DELIVERY_ID,
        pipeline: 'opencode',
        params: { mode: 'reply', reply: '/opencode take a look' },
      },
    },
    {
      name: '@agent comment -> reply/claude (default pipeline)',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: { body: '@agent please help', author_association: 'MEMBER' },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 9 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: { mode: 'reply', reply: '@agent please help' },
      },
    },
    {
      name: '@agent on a later prose line -> reply/claude',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: 'This is working: https://example.test/image\n\n@agent',
          author_association: 'OWNER',
        },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 9 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: {
          mode: 'reply',
          reply: 'This is working: https://example.test/image\n\n@agent',
        },
      },
    },
    {
      name: 'wrong repository -> ignore',
      event: 'issues',
      payload: issuesLabeledPayload({ repository: { full_name: OTHER_REPO } }),
      expected: { kind: 'ignore', reason: 'wrong-repo' },
    },
    {
      name: 'wrong repository on pull_request -> ignore',
      event: 'pull_request',
      payload: pullRequestLabeledPayload({
        repository: { full_name: OTHER_REPO },
      }),
      expected: { kind: 'ignore', reason: 'wrong-repo' },
    },
    {
      name: 'issues opened (not labeled) -> ignore',
      event: 'issues',
      payload: issuesLabeledPayload({ action: 'opened' }),
      expected: { kind: 'ignore', reason: 'unhandled-action' },
    },
    {
      name: 'pull_request opened (not labeled) -> ignore',
      event: 'pull_request',
      payload: pullRequestLabeledPayload({ action: 'opened' }),
      expected: { kind: 'ignore', reason: 'unhandled-action' },
    },
    {
      name: 'issues labeled with a non-agent label -> ignore',
      event: 'issues',
      payload: issuesLabeledPayload({ label: { name: 'bug' } }),
      expected: { kind: 'ignore', reason: 'no-trigger-label' },
    },
    {
      name: 'pull_request labeled with a non-agent, non-review label -> ignore',
      event: 'pull_request',
      payload: pullRequestLabeledPayload({ label: { name: 'bug' } }),
      expected: { kind: 'ignore', reason: 'no-trigger-label' },
    },
    {
      name: 'issue_comment created but not a trigger command -> ignore',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: 'just a regular comment',
          author_association: 'OWNER',
        },
      }),
      expected: { kind: 'ignore', reason: 'no-reply-command' },
    },
    {
      name: '@claude mid-sentence -> reply/claude',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: 'hey @claude can you help with this',
          author_association: 'OWNER',
        },
      }),
      expected: {
        kind: 'request',
        taskId: { repo: REPO, issue: 9 },
        requestId: DELIVERY_ID,
        pipeline: 'claude',
        params: {
          mode: 'reply',
          reply: 'hey @claude can you help with this',
        },
      },
    },
    {
      name: 'mentions inside quotes and code -> ignore',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: [
            '> @agent please retry',
            '',
            'Type `@claude` to dispatch.',
            '',
            '```text',
            '@agent',
            '```',
          ].join('\n'),
          author_association: 'OWNER',
        },
      }),
      expected: { kind: 'ignore', reason: 'no-reply-command' },
    },
    {
      name: 'mention inside a multiline inline-code span -> ignore',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: ['``example', '@agent', 'still code``'].join('\n'),
          author_association: 'OWNER',
        },
      }),
      expected: { kind: 'ignore', reason: 'no-reply-command' },
    },
    {
      name: 'fence with an info-string-like line does not close -> ignore',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: ['```', '```text', '@agent', '```'].join('\n'),
          author_association: 'OWNER',
        },
      }),
      expected: { kind: 'ignore', reason: 'no-reply-command' },
    },
    {
      name: 'longer usernames and URL paths do not count as mentions',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: 'Ask @agent-lcars-bot or visit https://example.test/@agent',
          author_association: 'OWNER',
        },
      }),
      expected: { kind: 'ignore', reason: 'no-reply-command' },
    },
    {
      name: 'slash command mid-sentence -> ignore',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: 'please use /codex for this',
          author_association: 'OWNER',
        },
      }),
      expected: { kind: 'ignore', reason: 'no-reply-command' },
    },
    {
      name: 'reply mention from a MEMBER bot -> untrusted-author',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: 'please retry @agent',
          author_association: 'MEMBER',
          user: { type: 'Bot' },
        },
      }),
      expected: { kind: 'ignore', reason: 'untrusted-author' },
    },
    {
      name: 'reply command from NONE association -> untrusted-author',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: { body: '@claude please help', author_association: 'NONE' },
      }),
      expected: { kind: 'ignore', reason: 'untrusted-author' },
    },
    {
      name: 'reply command from CONTRIBUTOR association -> untrusted-author',
      event: 'issue_comment',
      payload: issueCommentPayload({
        comment: {
          body: '@claude please help',
          author_association: 'CONTRIBUTOR',
        },
      }),
      expected: { kind: 'ignore', reason: 'untrusted-author' },
    },
    {
      name: 'issue_comment not created (e.g. edited) -> ignore',
      event: 'issue_comment',
      payload: issueCommentPayload({ action: 'edited' }),
      expected: { kind: 'ignore', reason: 'unhandled-action' },
    },
    {
      name: 'malformed payload (missing repository) -> ignore, no throw',
      event: 'issues',
      payload: { action: 'labeled', issue: { number: 1 } },
      expected: { kind: 'ignore', reason: 'malformed-payload' },
    },
    {
      name: 'malformed payload (not an object) -> ignore, no throw',
      event: 'issue_comment',
      payload: 'not an object',
      expected: { kind: 'ignore', reason: 'malformed-payload' },
    },
    {
      name: 'malformed payload (null) -> ignore, no throw',
      event: 'pull_request',
      payload: null,
      expected: { kind: 'ignore', reason: 'malformed-payload' },
    },
    {
      name: 'ping event -> ignore',
      event: 'ping',
      payload: { zen: 'Approachable is better than simple.' },
      expected: { kind: 'ignore', reason: 'unhandled-event' },
    },
  ];

  it.each(cases)('$name', ({ event, payload, expected }) => {
    const result = interpretDelivery({
      event,
      deliveryId: DELIVERY_ID,
      payload,
    });
    expect(result).toMatchObject(expected);
    if (expected.kind !== 'request') return;
    expect(result.kind).toBe('request');
    if (result.kind !== 'request') throw new Error('expected admission');
    expect(result.work.spec).toMatchObject({
      pipeline: result.pipeline,
      target: { repo: result.taskId.repo },
    });
  });

  it('tolerates unrecognized extra fields on an otherwise valid payload', () => {
    const result = interpretDelivery({
      event: 'issues',
      deliveryId: DELIVERY_ID,
      payload: issuesLabeledPayload({
        sender: { login: 'someone', extra: { nested: true } },
        installation: { id: 123 },
      }),
    });
    expect(result).toMatchObject({
      kind: 'request',
      taskId: { repo: REPO, issue: 42 },
      requestId: DELIVERY_ID,
      pipeline: 'claude',
      params: { mode: 'implement' },
    });
  });

  it('never throws across the whole case table', () => {
    for (const { event, payload } of cases) {
      expect(() =>
        interpretDelivery({ event, deliveryId: DELIVERY_ID, payload }),
      ).not.toThrow();
    }
  });
});

// #1190: `checkRepository` moved from an equality check against
// `controlPlaneRepository()` to `isControlPlaneRepository()`'s allow-list
// membership check. These prove the allow-list is actually consulted here,
// not just in deployment.test.ts's unit tests of the predicate itself.
describe('interpretDelivery repository allow-list (#1190)', () => {
  const SECOND_REPO = 'other-org/other-repo';

  afterEach(() => {
    delete process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'];
    delete process.env['AGENT_LCARS_WATCHED_REPOS'];
  });

  it('admits a second repository once the allow-list env var lists it', () => {
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
      `${REPO},${SECOND_REPO}`;
    process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
      { owner: 'jlapenna', name: 'agent-lcars' },
      { owner: 'other-org', name: 'other-repo' },
    ]);

    const result = interpretDelivery({
      event: 'issues',
      deliveryId: DELIVERY_ID,
      payload: issuesLabeledPayload({
        repository: { full_name: SECOND_REPO },
      }),
    });

    expect(result).toMatchObject({
      kind: 'request',
      taskId: { repo: SECOND_REPO, issue: 42 },
      requestId: DELIVERY_ID,
      pipeline: 'claude',
      params: { mode: 'implement' },
    });
  });

  it('still ignores a repository absent from the configured allow-list', () => {
    process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] =
      `${REPO},${SECOND_REPO}`;
    process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify([
      { owner: 'jlapenna', name: 'agent-lcars' },
      { owner: 'other-org', name: 'other-repo' },
    ]);

    const result = interpretDelivery({
      event: 'issues',
      deliveryId: DELIVERY_ID,
      payload: issuesLabeledPayload({
        repository: { full_name: 'unlisted-org/unlisted-repo' },
      }),
    });

    expect(result).toEqual({ kind: 'ignore', reason: 'wrong-repo' });
  });
});
