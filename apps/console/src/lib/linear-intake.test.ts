// @vitest-environment node
import { createHmac } from 'node:crypto';

import {
  issueSourceKey,
  type TrackerIssue,
} from '@agent-lcars/dispatch-contracts';
import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type LinearConfig, linearConfig } from './linear-config';
import {
  admitLinearWebhook,
  refreshLinearIssue,
  verifyLinearSignature,
} from './linear-intake';
import type { WorkContext } from './work-mint';

const org = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
const label = '33333333-3333-4333-8333-333333333333';
const issueId = '44444444-4444-4444-8444-444444444444';
const actor = '55555555-5555-4555-8555-555555555555';
const commentId = '66666666-6666-4666-8666-666666666666';
const now = Date.parse('2026-11-04T10:00:00Z');
const config: LinearConfig = {
  organizationId: org,
  operatorIds: [actor],
  routes: [
    {
      teamId: team,
      labelId: label,
      repo: 'owner/repo',
      pipeline: 'codex',
      principal: 'svc:linear',
    },
  ],
};
function snapshot(over: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    reference: { tracker: 'linear', organizationId: org, issueId },
    identifier: 'ENG-42',
    title: 'Fix search',
    description: 'Search returns no results.',
    url: 'https://linear.app/example/issue/ENG-42',
    updatedAt: new Date(now).toISOString(),
    state: 'open',
    teamId: team,
    labels: [{ id: label, name: 'LCARS Codex' }],
    assignees: [],
    ...over,
  };
}
function event(over: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      type: 'Issue',
      action: 'update',
      organizationId: org,
      webhookTimestamp: now,
      data: { id: issueId },
      ...over,
    }),
  );
}
function fixture(initial = snapshot()) {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, {
    now: () => new Date(now).toISOString(),
  });
  const runtime = {
    store,
    orchestrator,
    drain: vi.fn(async () => ({ dispatched: [], reported: [], failed: [] })),
  } as unknown as WorkContext['runtime'];
  const source = { current: initial };
  const readIssue = vi.fn(async () => source.current);
  const readComment = vi.fn(async () => ({
    id: commentId,
    body: '/codex please fix the search',
    url: `${initial.url}#comment`,
    createdAt: initial.updatedAt,
    updatedAt: initial.updatedAt,
    user: { id: actor, name: 'Joe' },
    issue: { id: issueId },
  }));
  const admit = (raw = event(), override = config) =>
    admitLinearWebhook(raw, override, runtime, now, { readIssue, readComment });
  return {
    runtime,
    store,
    orchestrator,
    source,
    readIssue,
    readComment,
    admit,
  };
}
beforeEach(() => {
  vi.stubEnv('AGENT_LCARS_LINEAR', JSON.stringify(config));
  vi.stubEnv('AGENT_LCARS_LINEAR_API_KEY', 'test-api-key');
  vi.stubEnv('AGENT_LCARS_LINEAR_WEBHOOK_SECRET', 'test-secret');
  vi.stubEnv(
    'AGENT_LCARS_WORK_GRANTS',
    JSON.stringify([
      {
        principal: 'svc:linear',
        subjects: ['linear-adapter'],
        pipelines: ['codex'],
        scopes: ['work.operator'],
        channel: 'linear',
      },
    ]),
  );
  vi.stubEnv('AGENT_LCARS_CONTROL_PLANE_REPOSITORIES', 'owner/repo');
  vi.stubEnv(
    'AGENT_LCARS_WATCHED_REPOS',
    JSON.stringify([{ owner: 'owner', name: 'repo', alias: 'repo' }]),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('Linear admission boundary', () => {
  it('authenticates exact bytes and rejects malformed signatures', () => {
    const raw = event();
    const signature = createHmac('sha256', 'test-secret')
      .update(raw)
      .digest('hex');
    expect(verifyLinearSignature(raw, signature, 'test-secret')).toBe(true);
    expect(
      verifyLinearSignature(
        Buffer.concat([raw, Buffer.from(' ')]),
        signature,
        'test-secret',
      ),
    ).toBe(false);
    for (const invalid of [
      null,
      '',
      'aa',
      'x'.repeat(64),
      signature.slice(0, -1),
    ])
      expect(verifyLinearSignature(raw, invalid, 'test-secret')).toBe(false);
  });
  it('admits native Work from authoritative current source and keeps checkout identity separate', async () => {
    const f = fixture();
    const result = await f.admit(
      event({ data: { id: issueId, title: 'Forged stale webhook title' } }),
    );
    const task = await f.store.readTask({
      workId: result.body['itemId'] as string,
    });
    expect(task?.task.work).toMatchObject({
      origin: {
        channel: 'linear',
        thread: JSON.stringify({ organizationId: org, issueId }),
      },
      spec: {
        title: 'ENG-42: Fix search',
        pipeline: 'codex',
        target: { repo: 'owner/repo' },
      },
    });
    expect(task?.task.issue).toEqual(f.source.current);
    expect((await f.store.listRuns(task!.task.task))[0]?.issue).toEqual(
      f.source.current,
    );
    expect(f.runtime.drain).not.toHaveBeenCalled();
  });
  it('projects unlabelled sources without minting a Work mapping or dispatching', async () => {
    const f = fixture(snapshot({ labels: [] }));
    expect((await f.admit()).body['outcome']).toBe('ignored');
    expect(
      await f.store.readTrackerIssue(f.source.current.reference),
    ).toMatchObject({ issue: f.source.current, repo: 'owner/repo' });
    expect(
      await f.store.readSourceWorkId(
        issueSourceKey(f.source.current.reference),
      ),
    ).toBeUndefined();
    expect(await f.store.listNativeTasks(10)).toHaveLength(0);
  });
  it('refreshes current metadata without changing admitted Run context or dispatching another run', async () => {
    const f = fixture();
    const first = await f.admit();
    f.source.current = snapshot({
      title: 'Edited title',
      description: 'New evidence',
      updatedAt: new Date(now + 1000).toISOString(),
    });
    await f.admit();
    const id = { workId: first.body['itemId'] as string };
    expect((await f.store.readTask(id))?.task.issue?.title).toBe(
      'Edited title',
    );
    const runs = await f.store.listRuns(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.issue?.title).toBe('Fix search');
  });
  it('admits only one run across concurrent signed event retries', async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => f.admit()),
    );
    expect(new Set(results.map((result) => result.body['itemId'])).size).toBe(
      1,
    );
    expect(
      await f.store.listRuns({ workId: results[0]!.body['itemId'] as string }),
    ).toHaveLength(1);
  });
  it('cancels an unstarted implementation when fresh source closes and fences a stale close after reopen', async () => {
    const f = fixture();
    const result = await f.admit();
    const id = { workId: result.body['itemId'] as string };
    const first = (await f.store.listRuns(id))[0]!;
    const closed = snapshot({
      state: 'closed',
      updatedAt: new Date(now + 1000).toISOString(),
    });
    const reopened = snapshot({
      updatedAt: new Date(now + 2000).toISOString(),
    });
    await f.orchestrator.refreshIssue(id, reopened);
    const stale = await f.orchestrator.cancelUnclaimedBefore({
      runId: first.runId,
      notAfter: closed.updatedAt,
      issue: closed,
      note: 'stale close',
    });
    expect(stale).toMatchObject({
      refused: true,
      reason: 'stale-issue-source',
    });
    await refreshLinearIssue(f.runtime, config, closed);
    expect((await f.store.readRun(first.runId))?.state).toBe('pending');
    f.source.current = snapshot({
      state: 'closed',
      updatedAt: new Date(now + 3000).toISOString(),
    });
    await f.admit();
    expect((await f.store.readRun(first.runId))?.state).toBe('canceled');
  });
  it('preserves started execution ownership on source closure', async () => {
    const f = fixture();
    const result = await f.admit();
    const run = (
      await f.store.listRuns({ workId: result.body['itemId'] as string })
    )[0]!;
    await f.orchestrator.confirmDispatch(run.runId);
    await f.store.enqueueRun({
      runId: run.runId,
      now: new Date(now).toISOString(),
    });
    await f.store.claimQueuedRun({
      pipelines: ['codex'],
      now: new Date(now).toISOString(),
      claimedBy: 'runner',
      tokenHash: 'a'.repeat(64),
    });
    f.source.current = snapshot({
      state: 'closed',
      updatedAt: new Date(now + 1000).toISOString(),
    });
    await f.admit();
    expect((await f.store.readRun(run.runId))?.state).toBe('running');
  });
  it('keeps an admitted repository immutable when the issue is moved to another route', async () => {
    const f = fixture();
    const first = await f.admit();
    const secondConfig: LinearConfig = {
      ...config,
      routes: [
        ...config.routes,
        {
          ...config.routes[0]!,
          teamId: actor,
          labelId: actor,
          repo: 'owner/other',
        },
      ],
    };
    f.source.current = snapshot({
      teamId: actor,
      labels: [{ id: actor, name: 'Other' }],
      updatedAt: new Date(now + 1000).toISOString(),
    });
    const moved = await f.admit(event(), secondConfig);
    expect(moved.body).toMatchObject({
      outcome: 'refused',
      itemId: first.body['itemId'],
    });
    expect(
      (await f.store.readTask({ workId: first.body['itemId'] as string }))?.task
        .work,
    ).toMatchObject({ spec: { target: { repo: 'owner/repo' } } });
  });
  it('deduplicates an initial comment command even after its run settles', async () => {
    const f = fixture(snapshot({ labels: [] }));
    const raw = event({
      type: 'Comment',
      action: 'create',
      actor: { id: actor, type: 'user' },
      data: { id: commentId, issueId, body: '/codex please fix the search' },
    });
    const first = await f.admit(raw);
    const id = { workId: first.body['itemId'] as string };
    const run = (await f.store.listRuns(id))[0]!;
    expect(run.params).toMatchObject({
      mode: 'reply',
      reply: '/codex please fix the search',
    });
    await f.orchestrator.confirmDispatch(run.runId);
    await f.orchestrator.report(run.runId, { ok: true, summary: 'done' });
    await f.admit(raw);
    expect(await f.store.listRuns(id)).toHaveLength(1);
  });
  it.each([
    'ordinary human comment',
    '`/codex` example',
    '> /codex quoted',
    '```\n/codex\n```',
    '<!-- agent-lcars:outcome --> /codex',
  ])('keeps inert comments out of dispatch: %s', async (body) => {
    const f = fixture(snapshot({ labels: [] }));
    f.readComment.mockResolvedValueOnce({ ...(await f.readComment()), body });
    await f.admit(
      event({
        type: 'Comment',
        action: 'create',
        actor: { id: actor, type: 'user' },
        data: { id: commentId, issueId, body },
      }),
    );
    expect(await f.store.listNativeTasks(10)).toHaveLength(0);
  });
  it('rejects untrusted or edited command authors and revoked grants', async () => {
    const f = fixture(snapshot({ labels: [] }));
    await f.admit(
      event({
        type: 'Comment',
        action: 'create',
        actor: { id: team, type: 'user' },
        data: { id: commentId, issueId, body: '/codex please fix the search' },
      }),
    );
    expect(f.readComment).not.toHaveBeenCalled();
    vi.stubEnv('AGENT_LCARS_WORK_GRANTS', '[]');
    f.source.current = snapshot();
    expect((await f.admit()).status).toBe(403);
  });
  it('fails retryably on an unavailable current source instead of trusting payload metadata', async () => {
    const f = fixture();
    f.readIssue.mockRejectedValueOnce(new Error('rate limited'));
    await expect(f.admit()).rejects.toThrow('rate limited');
    expect(await f.store.listNativeTasks(10)).toHaveLength(0);
  });
  it.each([false, true])(
    'refuses conflicting repository and dispatch labels before admission or continuation (bound=%s)',
    async (bound) => {
      const f = fixture();
      let workId: string | undefined;
      if (bound) {
        const first = await f.admit();
        workId = first.body['itemId'] as string;
        const run = (await f.store.listRuns({ workId }))[0]!;
        await f.orchestrator.confirmDispatch(run.runId);
        await f.orchestrator.report(run.runId, { ok: true, summary: 'done' });
      }
      vi.stubEnv(
        'AGENT_LCARS_CONTROL_PLANE_REPOSITORIES',
        'owner/repo,owner/other',
      );
      vi.stubEnv(
        'AGENT_LCARS_WATCHED_REPOS',
        JSON.stringify([
          { owner: 'owner', name: 'repo', alias: 'repo' },
          { owner: 'owner', name: 'other', alias: 'other' },
        ]),
      );
      const conflicting: LinearConfig = {
        ...config,
        teams: [
          {
            teamId: team,
            repositories: [{ repo: 'owner/repo', labelId: commentId }],
          },
        ],
        routes: [
          ...config.routes,
          { ...config.routes[0]!, repo: 'owner/other', labelId: actor },
        ],
      };
      f.source.current = snapshot({
        updatedAt: new Date(now + 1000).toISOString(),
        labels: [
          { id: commentId, name: 'Repository A' },
          { id: actor, name: 'Dispatch B' },
        ],
      });
      const result = await f.admit(
        event({
          actor: { id: actor, type: 'user' },
          createdAt: new Date(now + 1000).toISOString(),
          updatedFrom: { labelIds: [] },
          data: { id: issueId, updatedAt: f.source.current.updatedAt },
        }),
        conflicting,
      );
      expect(result.body['outcome']).toBe('refused');
      expect(await f.store.listNativeTasks(10)).toHaveLength(bound ? 1 : 0);
      const tasks = await f.store.listNativeTasks(10);
      const counts = await Promise.all(
        tasks.map(
          async (task) => (await f.store.listRuns(task.task.task)).length,
        ),
      );
      expect(counts).toEqual(bound ? [1] : []);
    },
  );
  it('does not turn a temporarily missing source into a synthetic newer closure', async () => {
    const f = fixture();
    const first = await f.admit();
    f.readIssue.mockResolvedValueOnce(undefined as unknown as TrackerIssue);
    await expect(f.admit()).rejects.toThrow('source is unavailable');
    await f.admit();
    expect(
      (await f.store.readTask({ workId: first.body['itemId'] as string }))?.task
        .issue?.state,
    ).toBe('open');
    expect(
      (await f.store.listRuns({ workId: first.body['itemId'] as string }))[0]
        ?.state,
    ).toBe('pending');
  });
  it('rejects stale events and malformed envelopes before API reads', async () => {
    const f = fixture();
    for (const webhookTimestamp of [now - 60001, now + 60001])
      expect((await f.admit(event({ webhookTimestamp }))).status).toBe(401);
    expect((await f.admit(Buffer.from('{'))).status).toBe(400);
    expect(f.readIssue).not.toHaveBeenCalled();
  });
});

describe('Linear deployment configuration', () => {
  it('is disabled by default and accepts an authorized complete configuration', () => {
    expect(linearConfig()).toEqual(config);
    vi.stubEnv('AGENT_LCARS_LINEAR', '');
    expect(linearConfig()).toBeUndefined();
  });
  it.each(['AGENT_LCARS_LINEAR_API_KEY', 'AGENT_LCARS_LINEAR_WEBHOOK_SECRET'])(
    'requires %s when enabled',
    (name) => {
      vi.stubEnv(name, '');
      expect(() => linearConfig()).toThrow(name);
    },
  );
  it('rejects duplicate routes, forbidden pipelines and repositories, and unbound grants', () => {
    for (const routes of [
      [...config.routes, ...config.routes],
      [{ ...config.routes[0], pipeline: 'claude' }],
      [{ ...config.routes[0], repo: 'foreign/repo' }],
      [{ ...config.routes[0], principal: 'user:unknown' }],
    ]) {
      vi.stubEnv(
        'AGENT_LCARS_LINEAR',
        JSON.stringify({ organizationId: org, routes }),
      );
      expect(() => linearConfig()).toThrow();
    }
  });
});
