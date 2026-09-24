import { describe, expect, it, vi } from 'vitest';

import policy from '../../packages/fleet-tools/bin/worker-policy.cjs';
import review from '../../packages/fleet-tools/bin/worker-review.cjs';

const head = 'a'.repeat(40);
const base = {
  state: 'OPEN',
  headRefOid: head,
  reviewDecision: null,
  viewer: 'worker-bot',
  labels: { nodes: [], pageInfo: { hasNextPage: false } },
  threads: [],
  timeline: [],
};
const hold = {
  id: 'hold-1',
  __typename: 'ConvertToDraftEvent',
  createdAt: '2026-09-21T10:00:00Z',
  actor: { login: 'maintainer' },
};
const response = (body: string, author = 'worker-bot') => ({
  id: 'comment-1',
  __typename: 'IssueComment',
  createdAt: '2026-09-21T11:00:00Z',
  author: { login: author },
  body,
});
const marker = `<!-- lcars-hold-response:hold-1:${head} -->`;

describe('fresh readiness and hold gate', () => {
  it('allows clear feedback and rejects unresolved threads even with otherwise clear state', () => {
    expect(review.rejection(base)).toBeNull();
    expect(
      review.rejection({
        ...base,
        threads: [{ id: 'thread', isResolved: false }],
      }),
    ).toContain('Resolve');
    expect(
      review.rejection({ ...base, reviewDecision: 'CHANGES_REQUESTED' }),
    ).toContain('changes requested');
    expect(
      review.rejection({
        ...base,
        labels: {
          nodes: [{ name: 'status:blocked' }],
          pageInfo: { hasNextPage: false },
        },
      }),
    ).toContain('blocked');
  });
  it('requires a fresh head-bound response to an external hold', () => {
    expect(review.rejection({ ...base, timeline: [hold] })).toContain(marker);
    expect(
      review.rejection({
        ...base,
        timeline: [hold, response(`Addressed feedback. ${marker}`)],
      }),
    ).toBeNull();
    expect(
      review.rejection({
        ...base,
        headRefOid: 'b'.repeat(40),
        timeline: [hold, response(`Addressed feedback. ${marker}`)],
      }),
    ).toContain('hold remains');
  });
  it('does not let a response override unresolved reviews or let task content answer the hold', () => {
    expect(
      review.rejection({
        ...base,
        timeline: [hold, response(`Addressed. ${marker}`, 'outsider')],
      }),
    ).toContain('hold remains');
    expect(
      review.rejection({ ...base, timeline: [hold, response(marker)] }),
    ).toContain('hold remains');
    expect(
      review.rejection({
        ...base,
        reviewDecision: 'CHANGES_REQUESTED',
        timeline: [hold, response(`Addressed. ${marker}`)],
      }),
    ).toContain('changes requested');
  });
  it('recognizes holder release but not a worker clearing someone else’s hold', () => {
    const release = {
      ...hold,
      id: 'ready-1',
      __typename: 'ReadyForReviewEvent',
      createdAt: '2026-09-21T12:00:00Z',
    };
    expect(review.rejection({ ...base, timeline: [hold, release] })).toBeNull();
    expect(
      review.rejection({
        ...base,
        timeline: [hold, { ...release, actor: { login: 'worker-bot' } }],
      }),
    ).toContain('hold remains');
  });
  it('checks auto-merge disable holds independently of draft holds', () => {
    expect(
      review.rejection({
        ...base,
        timeline: [{ ...hold, __typename: 'AutoMergeDisabledEvent' }],
      }),
    ).toContain('AutoMergeDisabledEvent');
    expect(
      review.rejection({
        ...base,
        timeline: [{ ...hold, actor: { login: 'worker-bot' } }],
      }),
    ).toBeNull();
  });
  it.each([
    ['77'],
    ['77', '-R', 'foreign/repo'],
    ['77', '--repo=foreign/repo'],
    ['77', '-R', 'octo/example', '--admin'],
    ['77', '88', '-R', 'octo/example'],
  ])('rejects ambiguous readiness targets: %j', (...args) => {
    expect(() => review.target(args, 'octo/example')).toThrow();
  });
  it('binds numeric targets with separate or equals repo syntax', () => {
    expect(
      review.target(
        ['77', '--repo=octo/example', '--auto', '--squash'],
        'octo/example',
      ),
    ).toEqual({ repository: 'octo/example', number: 77 });
  });
  it('reads subsequent pages and refuses incomplete or changing snapshots', () => {
    const connection = (
      nodes: unknown[],
      more = false,
      cursor: string | null = null,
    ) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor } });
    const page = (more = false, changedHead = head) => ({
      data: {
        viewer: { login: 'worker-bot' },
        repository: {
          pullRequest: {
            ...base,
            headRefOid: changedHead,
            reviewThreads: connection(
              more ? [] : [{ id: 'late-thread', isResolved: false }],
              more,
              more ? 'next' : null,
            ),
            timelineItems: connection([]),
          },
        },
      },
    });
    const request = vi
      .fn()
      .mockReturnValueOnce(page(true))
      .mockReturnValueOnce(page());
    expect(
      review.rejection(review.readSnapshot('octo/example', 77, request)),
    ).toContain('Resolve');
    expect(request.mock.calls[1][0].threads).toBe('next');
    expect(() =>
      review.readSnapshot('octo/example', 77, () => ({
        errors: [{ message: 'unavailable' }],
      })),
    ).toThrow();
    expect(() =>
      review.readSnapshot(
        'octo/example',
        77,
        vi
          .fn()
          .mockReturnValueOnce(page(true))
          .mockReturnValueOnce(page(false, 'changed')),
      ),
    ).toThrow();
  });
  it('blocks the actual policy operation while preserving explicit disarm actions', () => {
    const context = policy.prepareContext(
      {
        repository: 'octo/example',
        mode: 'implement',
        anchor: { type: 'issue', number: 42 },
      },
      {
        provider: 'codex',
        runId: 'octo/example#42/r1',
        attemptId: 'g1:octo/example#42/r1',
      },
    );
    const dependencies = {
      assertWorktree: () => undefined,
      readOwnership: () => ({
        state: 'open',
        assignees: [
          { login: process.env.AGENT_FLEET_LOGIN || 'agent-lcars-bot' },
        ],
      }),
      readReviewSnapshot: vi.fn(() => ({ ...base, timeline: [hold] })),
    };
    const call = (command: string) =>
      policy.evaluate(
        { tool_name: 'Bash', tool_input: { command }, cwd: '/tmp' },
        context,
        dependencies,
      ).hookSpecificOutput;
    expect(
      call('gh pr merge 77 --repo octo/example --auto --squash')
        .permissionDecision,
    ).toBe('deny');
    expect(dependencies.readReviewSnapshot).toHaveBeenCalledWith(
      'octo/example',
      77,
    );
    expect(call('gh pr merge 77 --disable-auto').permissionDecision).toBe(
      'allow',
    );
    expect(call('gh pr ready 77 --undo').permissionDecision).toBe('allow');
  });
});
