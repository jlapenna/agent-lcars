import { createHash } from 'node:crypto';

import {
  formatQuickTaskMarker,
  parseTerminalQuickTaskBody,
  quickTaskDigest as contractQuickTaskDigest,
} from '@agent-lcars/dispatch-contracts';
import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  ActionError,
  approveAndMergePr,
  approveAndRebasePr,
  assignPipeline,
  clearNeedsHumanLabel,
  closeIssue,
  dispatchUnstickPrs,
  postComment,
  retriggerIssue,
  updateIssueContent,
  updatePrBranch,
} from './backend-actions';
import { type DispatchTokenProvider, REPO_HEADER } from './github-app-tokens';
import { getGithubClient } from './github-client';
import { drainOutbox } from './orchestrator-dispatch';
import { createOrchestratorRuntime } from './orchestrator-runtime';

const { refreshCurrentGithubAnchorProjection } = vi.hoisted(() => ({
  refreshCurrentGithubAnchorProjection: vi.fn(),
}));

vi.mock('./github-anchor-refresh', () => ({
  refreshCurrentGithubAnchorProjection,
}));

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };
const DISPATCH_ID = '11111111-1111-4111-8111-111111111111';
const DEFAULT_REPO_KEY = `${DEFAULT_REPO.owner}/${DEFAULT_REPO.name}`;

function testWork(pipeline: 'claude' | 'codex' | 'opencode') {
  return {
    origin: { principal: 'github:test-fixture', channel: 'github' as const },
    spec: {
      title: 'Fixture issue',
      description: 'Fixture issue body.',
      pipeline,
      target: { repo: DEFAULT_REPO_KEY },
    },
  };
}

vi.mock('./github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-client')>();
  return {
    ...actual,
    getGithubClient: vi.fn(),
    getWatchedRepos: vi.fn(() => [DEFAULT_REPO]),
  };
});

vi.mock('./orchestrator-runtime', () => ({
  createOrchestratorRuntime: vi.fn(),
}));

beforeEach(() => {
  (createOrchestratorRuntime as Mock).mockReset();
  refreshCurrentGithubAnchorProjection.mockReset();
});

/** Builds a fresh orchestrator runtime the same shape
 * `orchestrator-runtime.ts`'s `createOrchestratorRuntime` does - a
 * `MemoryStore`, an `Orchestrator` over it, and `drain` composed from
 * `drainOutbox` with a fake `fetch` (see orchestrator-routes.test.ts's
 * identical fixture) - then installs it as the mocked runtime backend-
 * actions.ts's retriggerIssue reads via
 * `createOrchestratorRuntime()`. */
function fixtureOrchestratorRuntime(now = '2026-08-15T12:00:00.000Z') {
  const clock = { now: () => now };
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, clock);
  const calls: { url: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  // Trivial fixed-token stub (`AmbientTokenProvider` itself was retired in
  // #1284 - see github-app-tokens.ts).
  const tokens: DispatchTokenProvider = {
    tokenFor: async () => 'gh-test-token-0123456789',
  };
  // `now` pins `drainOutbox`'s own clock to the same fixed instant the
  // orchestrator's `clock` uses for entry `createdAt` -- otherwise the
  // default (real wall-clock) `now` would make every entry here look
  // days/weeks stale against this fixture's frozen 2026-08-15 timestamp,
  // spuriously tripping the anchor-closed check (`isStaleReport` in
  // orchestrator-dispatch.ts) that a handful of these tests never intend
  // to exercise.
  const drain = () =>
    drainOutbox({
      store,
      orchestrator,
      tokens,
      fetchImpl,
      now: () => clock.now(),
    });
  (createOrchestratorRuntime as Mock).mockReturnValue({
    store,
    orchestrator,
    drain,
  });
  return { store, orchestrator, calls };
}

describe('closeIssue', () => {
  function mockOctokit() {
    const update = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { update } },
    });
    return { update };
  }

  it('closes the given issue on the console repo', async () => {
    const { update } = mockOctokit();
    fixtureOrchestratorRuntime();

    await closeIssue(DEFAULT_REPO, 2709);

    expect(update).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      issue_number: 2709,
      state: 'closed',
    });
    expect(refreshCurrentGithubAnchorProjection).toHaveBeenCalledWith({
      repo: DEFAULT_REPO_KEY,
      issue: 2709,
    });
  });

  it('sweeps the orchestrator to catch up any expired lease after closing (#1183)', async () => {
    mockOctokit();
    const { orchestrator } = fixtureOrchestratorRuntime();
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');

    await closeIssue(DEFAULT_REPO, 2709);

    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates a GitHub API error and never sweeps the orchestrator', async () => {
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: {
          update: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
      },
    });
    const { orchestrator } = fixtureOrchestratorRuntime();
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');

    await expect(closeIssue(DEFAULT_REPO, 2709)).rejects.toThrow('Not Found');
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('still resolves the close when the orchestrator runtime cannot be constructed', async () => {
    const { update } = mockOctokit();
    (createOrchestratorRuntime as Mock).mockImplementation(() => {
      throw new Error('orchestrator unavailable');
    });

    await expect(closeIssue(DEFAULT_REPO, 2709)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalled();
  });
});

describe('updateIssueContent', () => {
  it('updates the trimmed title and verbatim body without notifying reconciliation', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { title: 'Old title', body: 'Old body' },
    });
    const update = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, update }, actions: { createWorkflowDispatch } },
    });

    await updateIssueContent(DEFAULT_REPO, 2709, {
      title: '  Sharper title  ',
      body: 'Body with intentional trailing space ',
    });

    expect(update).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      issue_number: 2709,
      title: 'Sharper title',
      body: 'Body with intentional trailing space ',
    });
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('hides and rehashes a Quick Task marker when editing its content', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const hash = (input: string) =>
      createHash('sha256').update(input).digest('hex');
    const original = {
      repository: 'supersprinklesracing/sprinkles',
      pipeline: 'claude',
      title: 'Original quick task',
      description: 'Original description',
    };
    const originalDigest = contractQuickTaskDigest(original, hash);
    const get = vi.fn().mockResolvedValue({
      data: {
        title: original.title,
        body: `${original.description}\n\n${formatQuickTaskMarker({ requestId, digest: originalDigest })}`,
      },
    });
    const update = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, update } },
    });

    await updateIssueContent(DEFAULT_REPO, 2709, {
      title: 'Edited quick task',
      body: 'Edited description',
    });

    const persisted = update.mock.calls[0][0].body as string;
    expect(parseTerminalQuickTaskBody(persisted)).toEqual({
      requestId,
      digest: contractQuickTaskDigest(
        {
          ...original,
          title: 'Edited quick task',
          description: 'Edited description',
        },
        hash,
      ),
      description: 'Edited description',
    });
  });

  it('refuses to add a Quick Task marker to an ordinary issue', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { title: 'Ordinary issue', body: 'Ordinary body' },
    });
    const update = vi.fn();
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, update } },
    });

    await expect(
      updateIssueContent(DEFAULT_REPO, 2709, {
        title: 'Ordinary issue',
        body: formatQuickTaskMarker({
          requestId: '11111111-1111-4111-8111-111111111111',
          digest: 'a'.repeat(64),
        }),
      }),
    ).rejects.toThrow('cannot be added');
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an empty title before calling GitHub', async () => {
    const update = vi.fn();
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { update } },
    });

    await expect(
      updateIssueContent(DEFAULT_REPO, 2709, { title: '  ', body: '' }),
    ).rejects.toThrow('Issue title is required');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('updatePrBranch', () => {
  it('updates the PR branch with the latest base branch changes and never notifies', async () => {
    const updateBranch = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { pulls: { updateBranch }, actions: { createWorkflowDispatch } },
    });

    await updatePrBranch(DEFAULT_REPO, 2709);

    expect(updateBranch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 2709,
    });
    // A branch update doesn't write any fact the dispatch ledger tracks -
    // no reconcile ping should ever follow it.
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('propagates a GitHub API error', async () => {
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        pulls: {
          updateBranch: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Merge conflict'), { status: 422 }),
            ),
        },
      },
    });

    await expect(updatePrBranch(DEFAULT_REPO, 2709)).rejects.toThrow(
      'Merge conflict',
    );
  });
});

describe('clearNeedsHumanLabel', () => {
  function mockOctokit() {
    const removeLabel = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { removeLabel } },
    });
    return { removeLabel };
  }

  it('removes the needs-human status label from the given issue', async () => {
    const { removeLabel } = mockOctokit();
    fixtureOrchestratorRuntime();

    await clearNeedsHumanLabel(DEFAULT_REPO, 2709);

    expect(removeLabel).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      issue_number: 2709,
      name: 'status:needs-human',
    });
  });

  it('sweeps the orchestrator after clearing the park state (#1183)', async () => {
    mockOctokit();
    const { orchestrator } = fixtureOrchestratorRuntime();
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');

    await clearNeedsHumanLabel(DEFAULT_REPO, 2709);

    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows a 404 (label was already absent) and does not sweep', async () => {
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: {
          removeLabel: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
      },
    });
    const { orchestrator } = fixtureOrchestratorRuntime();
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');

    await expect(
      clearNeedsHumanLabel(DEFAULT_REPO, 2709),
    ).resolves.toBeUndefined();
    // The label write never happened - nothing changed for the orchestrator
    // to catch up on.
    expect(sweepSpy).not.toHaveBeenCalled();
  });
});

describe('postComment (direct Work admission)', () => {
  function mockOctokit(
    currentLabels = ['agent:codex'],
    kind: 'issue' | 'pr' = 'issue',
  ) {
    // clearNeedsHumanLabel's own sweep-the-orchestrator follow-up (#1183)
    // fires on every successful removeLabel below - give it somewhere real
    // to land instead of a bare unmocked createOrchestratorRuntime().
    fixtureOrchestratorRuntime();
    const createComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/1#issuecomment-1' },
    });
    const removeLabel = vi.fn().mockResolvedValue({});
    const setLabels = vi.fn().mockResolvedValue({});
    const get = vi.fn().mockResolvedValue({
      data: {
        // `state` matters only to the assign-on-reply path below, which
        // refuses anything but an open issue; the other cases ignore it.
        state: 'open',
        title: 'Fixture issue',
        body: 'Fixture issue body.',
        labels: currentLabels,
        ...(kind === 'pr'
          ? { pull_request: { url: 'https://github.test/pr' } }
          : {}),
      },
    });
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { createComment, get, removeLabel, setLabels } },
    });
    return { createComment, get, removeLabel, setLabels };
  }

  it('rejects a blank body without calling GitHub', async () => {
    const { createComment } = mockOctokit();

    await expect(
      postComment(DEFAULT_REPO, 2709, '   ', 'jlapenna'),
    ).rejects.toThrow('Comment body is required');
    expect(createComment).not.toHaveBeenCalled();
  });

  it('posts plain text when no agent label is present', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', 'jlapenna');

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2' }),
    );
  });

  it('admits reply mode only when the canonical assignment is explicit', async () => {
    const { createComment } = mockOctokit();
    const { orchestrator, store } = fixtureOrchestratorRuntime();
    const taskId = { repo: DEFAULT_REPO_KEY, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed-reply',
      pipeline: 'codex',
      params: { mode: 'implement' },
      work: testWork('codex'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', 'jlapenna', 'codex');

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2' }),
    );
    const runs = await store.listRuns(taskId);
    expect(runs.at(-1)?.params).toEqual({
      mode: 'reply',
      reply: 'Use option 2',
    });
  });

  it('admits a reply when the current assignment is a canonical review label', async () => {
    const { removeLabel } = mockOctokit(['review:codex'], 'pr');
    const { orchestrator, store } = fixtureOrchestratorRuntime();
    const taskId = { repo: DEFAULT_REPO_KEY, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed-review-reply',
      pipeline: 'codex',
      params: { mode: 'review' },
      work: testWork('codex'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });

    await postComment(
      DEFAULT_REPO,
      2709,
      'Please address this',
      'jlapenna',
      'codex',
    );

    expect((await store.listRuns(taskId)).at(-1)?.params).toEqual({
      mode: 'reply',
      reply: 'Please address this',
    });
    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'status:needs-human' }),
    );
  });

  // jlapenna/homelab#855: `derivePrimaryAction` prescribes `reply` for every
  // needs-human item, including ones carrying no agent:* label at all. That
  // reply used to post a comment, dispatch nobody, and still report success,
  // so the queue kept prescribing the same dead end.
  it('assigns and dispatches when the maintainer picks an agent for an unassigned issue', async () => {
    const { createComment, setLabels, removeLabel } = mockOctokit([
      'type:security',
      'status:needs-human',
    ]);
    const { store } = fixtureOrchestratorRuntime();
    const taskId = { repo: DEFAULT_REPO_KEY, issue: 2709 };

    const result = await postComment(
      DEFAULT_REPO,
      2709,
      "You don't need a human for this",
      'jlapenna',
      'claude',
    );

    expect(result.dispatched).toBe(true);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "You don't need a human for this" }),
    );
    expect((await store.listRuns(taskId)).at(-1)?.params).toEqual({
      mode: 'implement',
    });
    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.arrayContaining(['type:security', 'agent:claude']),
      }),
    );
    // The handoff is done, so the item must stop asking for a human.
    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'status:needs-human' }),
    );
  });

  it('preserves the posted reply and admitted dispatch when assignment labeling fails', async () => {
    const { createComment, setLabels } = mockOctokit(['status:needs-human']);
    const { store } = fixtureOrchestratorRuntime();
    setLabels.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(
      postComment(
        DEFAULT_REPO,
        2709,
        'Please investigate',
        'jlapenna',
        'claude',
      ),
    ).resolves.toEqual({
      url: expect.any(String),
      dispatched: true,
      dispatchWarning: 'assignment-update-failed',
    });
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(
      (await store.listRuns({ repo: DEFAULT_REPO_KEY, issue: 2709 })).at(-1),
    ).toMatchObject({ pipeline: 'claude', params: { mode: 'implement' } });
  });

  it('preserves the posted reply when reading dispatch state fails', async () => {
    const { createComment, get } = mockOctokit(['status:needs-human']);
    fixtureOrchestratorRuntime();
    get.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await expect(
      postComment(
        DEFAULT_REPO,
        2709,
        'Please investigate',
        'jlapenna',
        'claude',
      ),
    ).resolves.toEqual({
      url: expect.any(String),
      dispatched: false,
      dispatchWarning: 'dispatch-failed',
    });
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('reports dispatched: false for a comment on an unassigned issue', async () => {
    mockOctokit(['status:needs-human']);

    const result = await postComment(
      DEFAULT_REPO,
      2709,
      'just a note',
      'jlapenna',
    );

    expect(result.dispatched).toBe(false);
  });

  it('never assigns a pull request from a reply', async () => {
    const { setLabels } = mockOctokit([], 'pr');

    const result = await postComment(
      DEFAULT_REPO,
      2709,
      'a note',
      'jlapenna',
      'claude',
    );

    expect(result.dispatched).toBe(false);
    expect(setLabels).not.toHaveBeenCalled();
  });

  it('leaves needs-human on a plain comment with no assignment', async () => {
    const { removeLabel } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'hi', 'jlapenna');

    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('treats a stale client assignment removed after render as a plain comment', async () => {
    const { createComment, removeLabel } = mockOctokit([]);
    const { orchestrator, store } = fixtureOrchestratorRuntime();
    const taskId = { repo: DEFAULT_REPO_KEY, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed-stale-assignment',
      pipeline: 'codex',
      params: { mode: 'implement' },
      work: testWork('codex'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });

    await postComment(
      DEFAULT_REPO,
      2709,
      'A human-only note',
      'jlapenna',
      'codex',
    );

    expect(createComment).toHaveBeenCalledOnce();
    expect(await store.listRuns(taskId)).toHaveLength(1);
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('does not trust a crafted pipeline that differs from the current assignment', async () => {
    const { removeLabel } = mockOctokit(['agent:claude']);
    const { orchestrator, store } = fixtureOrchestratorRuntime();
    const taskId = { repo: DEFAULT_REPO_KEY, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed-crafted-assignment',
      pipeline: 'claude',
      params: { mode: 'implement' },
      work: testWork('claude'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });

    await postComment(
      DEFAULT_REPO,
      2709,
      'A human-only note',
      'jlapenna',
      'codex',
    );

    expect(await store.listRuns(taskId)).toHaveLength(1);
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('does not revive immutable Work after the explicit assignment changes pipeline', async () => {
    const { createComment, removeLabel } = mockOctokit(['agent:claude']);
    const { orchestrator, store } = fixtureOrchestratorRuntime();
    const taskId = { repo: DEFAULT_REPO_KEY, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed-rejected-label-change',
      pipeline: 'codex',
      params: { mode: 'implement' },
      work: testWork('codex'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });

    await postComment(
      DEFAULT_REPO,
      2709,
      'A human-only note',
      'jlapenna',
      'claude',
    );

    expect(createComment).toHaveBeenCalledOnce();
    expect(await store.listRuns(taskId)).toHaveLength(1);
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('does not dispatch or clear needs-human when Task outlives its assignment label', async () => {
    const { removeLabel } = mockOctokit();
    const { orchestrator, store } = fixtureOrchestratorRuntime();
    const taskId = { repo: DEFAULT_REPO_KEY, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed-unassigned-comment',
      pipeline: 'codex',
      params: { mode: 'implement' },
      work: testWork('codex'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });

    await postComment(DEFAULT_REPO, 2709, 'A human-only note', 'jlapenna');

    expect(await store.listRuns(taskId)).toHaveLength(1);
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('clears needs-human after an explicitly assigned reply starts a run', async () => {
    const { removeLabel } = mockOctokit();
    const { orchestrator } = fixtureOrchestratorRuntime();
    const seeded = await orchestrator.request({
      taskId: { repo: DEFAULT_REPO_KEY, issue: 2709 },
      requestId: 'seed-needs-human-reply',
      pipeline: 'codex',
      params: { mode: 'implement' },
      work: testWork('codex'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });

    await postComment(DEFAULT_REPO, 2709, 'hi', 'jlapenna', 'codex');

    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'status:needs-human' }),
    );
  });

  it('preserves the admitted reply when needs-human projection refresh fails', async () => {
    const { createComment } = mockOctokit();
    const { orchestrator } = fixtureOrchestratorRuntime();
    const seeded = await orchestrator.request({
      taskId: { repo: DEFAULT_REPO_KEY, issue: 2709 },
      requestId: 'seed-refresh-failure-reply',
      pipeline: 'codex',
      params: { mode: 'implement' },
      work: testWork('codex'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });
    refreshCurrentGithubAnchorProjection.mockRejectedValueOnce(
      new Error('projection unavailable'),
    );

    await expect(
      postComment(DEFAULT_REPO, 2709, 'hi', 'jlapenna', 'codex'),
    ).resolves.toEqual({
      url: expect.any(String),
      dispatched: true,
      dispatchWarning: 'projection-refresh-failed',
    });
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('posting an unassigned comment does not sweep the orchestrator', async () => {
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: {
          createComment: vi.fn().mockResolvedValue({
            data: {
              html_url: 'https://github.com/o/r/issues/1#issuecomment-1',
            },
          }),
          // Plain comments never clear this handoff label, so creating one is
          // inert from the orchestrator's perspective.
          removeLabel: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
      },
    });
    const { orchestrator } = fixtureOrchestratorRuntime();
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');

    await postComment(DEFAULT_REPO, 2709, 'hi', 'jlapenna');

    expect(sweepSpy).not.toHaveBeenCalled();
  });
});

describe('approveAndRebasePr', () => {
  function mockOctokit() {
    const createReview = vi.fn().mockResolvedValue({});
    const updateBranch = vi.fn().mockResolvedValue({});
    const get = vi.fn().mockResolvedValue({ data: { node_id: 'PR_kwAB' } });
    const graphql = vi.fn().mockResolvedValue({});
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        pulls: { createReview, updateBranch, get },
        actions: { createWorkflowDispatch },
      },
      graphql,
    });
    return { createReview, updateBranch, get, graphql, createWorkflowDispatch };
  }

  it('approves, updates the branch, then enables squash auto-merge - and never notifies', async () => {
    const { createReview, updateBranch, get, graphql, createWorkflowDispatch } =
      mockOctokit();

    await approveAndRebasePr(DEFAULT_REPO, 42);

    expect(createReview).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
      event: 'APPROVE',
    });
    expect(updateBranch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
    });
    expect(get).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
    });
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('enablePullRequestAutoMerge'),
      {
        pullRequestId: 'PR_kwAB',
        mergeMethod: 'SQUASH',
        headers: { [REPO_HEADER]: 'supersprinklesracing/sprinkles' },
      },
    );
    // Approving, updating the branch, and merely *enabling* auto-merge
    // write no ledger-tracked fact themselves - the eventual merge is a
    // normal GitHub-initiated event the hosted controller observes on its
    // own, so no reconcile ping should follow any of these calls.
    expect(createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('propagates a GitHub API error from the approval step', async () => {
    const { createReview, updateBranch } = mockOctokit();
    createReview.mockRejectedValue(
      Object.assign(new Error('Review already submitted'), { status: 422 }),
    );

    await expect(approveAndRebasePr(DEFAULT_REPO, 42)).rejects.toThrow(
      'Review already submitted',
    );
    expect(updateBranch).not.toHaveBeenCalled();
  });
});

describe('approveAndMergePr', () => {
  function mockOctokit() {
    const createReview = vi.fn().mockResolvedValue({});
    const merge = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { pulls: { createReview, merge } },
    });
    return { createReview, merge };
  }

  it('approves then squash-merges the PR', async () => {
    const { createReview, merge } = mockOctokit();
    fixtureOrchestratorRuntime();

    await approveAndMergePr(DEFAULT_REPO, 42);

    expect(createReview).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
      event: 'APPROVE',
    });
    expect(merge).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      pull_number: 42,
      merge_method: 'squash',
    });
  });

  it('sweeps the orchestrator to catch up after the merge (#1183)', async () => {
    mockOctokit();
    const { orchestrator } = fixtureOrchestratorRuntime();
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');

    await approveAndMergePr(DEFAULT_REPO, 42);

    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates a GitHub API error from the approval step and never merges or sweeps', async () => {
    const { createReview, merge } = mockOctokit();
    createReview.mockRejectedValue(
      Object.assign(new Error('Review already submitted'), { status: 422 }),
    );
    const { orchestrator } = fixtureOrchestratorRuntime();
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');

    await expect(approveAndMergePr(DEFAULT_REPO, 42)).rejects.toThrow(
      'Review already submitted',
    );
    expect(merge).not.toHaveBeenCalled();
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('propagates a GitHub API error from the merge step and never sweeps', async () => {
    const { merge } = mockOctokit();
    merge.mockRejectedValue(
      Object.assign(new Error('Pull Request is not mergeable'), {
        status: 405,
      }),
    );
    const { orchestrator } = fixtureOrchestratorRuntime();
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');

    await expect(approveAndMergePr(DEFAULT_REPO, 42)).rejects.toThrow(
      'Pull Request is not mergeable',
    );
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('still resolves the merge when the orchestrator runtime cannot be constructed', async () => {
    const { merge } = mockOctokit();
    (createOrchestratorRuntime as Mock).mockImplementation(() => {
      throw new Error('orchestrator unavailable');
    });

    await expect(approveAndMergePr(DEFAULT_REPO, 42)).resolves.toBeUndefined();
    expect(merge).toHaveBeenCalled();
  });
});

describe('dispatchUnstickPrs', () => {
  it('creates an audit anchor and admits the runbook through Work directly', async () => {
    const listForRepo = vi.fn().mockResolvedValue({ data: [] });
    const create = vi.fn().mockResolvedValue({
      data: {
        number: 88,
        title: 'playbook: unstick stuck PRs (2026-08-31)',
        body: 'Unstick the queue.',
      },
    });
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { listForRepo, create } },
    });
    const { store } = fixtureOrchestratorRuntime();

    await dispatchUnstickPrs('  PR #123 stuck  ', DEFAULT_REPO, 'jlapenna');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['automation:unstick-prs'] }),
    );
    const runs = await store.listRuns({ repo: DEFAULT_REPO_KEY, issue: 88 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.params).toEqual(
      expect.objectContaining({
        mode: 'implement',
        runbook: 'unsticking-stuck-prs',
        context: 'PR #123 stuck',
      }),
    );
  });

  it('reuses an open audit anchor without a repository workflow', async () => {
    const listForRepo = vi.fn().mockResolvedValue({
      data: [{ number: 88, title: 'Unstick', body: 'Existing anchor' }],
    });
    const createComment = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { listForRepo, createComment } },
    });
    fixtureOrchestratorRuntime();

    await dispatchUnstickPrs(undefined, DEFAULT_REPO, 'jlapenna');

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 88,
        body: 'Re-dispatched by @jlapenna. Context: (none)',
      }),
    );
  });
});

describe('retriggerIssue (orchestrator dispatch, #1183)', () => {
  // retriggerIssue no longer checks GitHub labels at all - the orchestrator
  // is the one dispatch entry point, and its `request()` is keyed by the
  // clicked item's own cross-repository TaskId. `getGithubClient()` is still
  // needed for clearNeedsHumanLabel's label removal and an optional
  // steering-note comment.
  function mockOctokit() {
    const removeLabel = vi.fn().mockResolvedValue({});
    const createComment = vi.fn().mockResolvedValue({});
    // Read by the `work` derivation below when the task has no `work` yet
    // (every test in this block, unless it seeds one) - a default so the
    // existing tests, which don't care about `work`, don't have to stub it.
    const get = vi.fn().mockResolvedValue({
      data: { title: 'Issue title', body: 'Issue body' },
    });
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { removeLabel, createComment, get } },
    });
    return { removeLabel, createComment, get };
  }

  it('requires an authoritative pipeline when the task has no prior run', async () => {
    const { calls } = fixtureOrchestratorRuntime();
    mockOctokit();

    await expect(
      retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID),
    ).rejects.toThrow('No authoritative Work is recorded for this task');
    expect(calls.some((call) => call.url.includes('/actions/workflows/'))).toBe(
      false,
    );
  });

  it("reads the task's immutable Work instead of defaulting", async () => {
    const { store, orchestrator, calls } = fixtureOrchestratorRuntime();
    mockOctokit();
    const taskId = { repo: DEFAULT_REPO_KEY, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed',
      pipeline: 'opencode',
      work: testWork('opencode'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    // Settle the seeded run so the task's lock is free for retriggerIssue's
    // own request below - only the pipeline history should matter here.
    await orchestrator.report(seeded.run.runId, { ok: true });

    await retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID);
    expect(calls.some((call) => call.url.includes('/actions/workflows/'))).toBe(
      false,
    );
    expect((await store.listRuns(taskId)).length).toBe(2);
  });

  it('refuses with a structured 409 when a run is already active for the task', async () => {
    const { orchestrator } = fixtureOrchestratorRuntime();
    mockOctokit();
    await orchestrator.request({
      taskId: { repo: DEFAULT_REPO_KEY, issue: 2709 },
      requestId: 'already-live',
      pipeline: 'claude',
      work: testWork('claude'),
    });

    await expect(
      retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID),
    ).rejects.toThrow(
      new ActionError('A run is already active for this task', 409),
    );
  });

  it('posts the steering note and still dispatches when the note carries no mention', async () => {
    const { calls, orchestrator } = fixtureOrchestratorRuntime();
    const { createComment } = mockOctokit();
    const seeded = await orchestrator.request({
      taskId: { repo: DEFAULT_REPO_KEY, issue: 2709 },
      requestId: 'seed-note',
      pipeline: 'claude',
      work: testWork('claude'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });

    await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      'try a different approach',
    );

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'try a different approach' }),
    );
    expect(calls.some((call) => call.url.includes('/actions/workflows/'))).toBe(
      false,
    );
  });

  it('still dispatches directly when a steering note contains a GitHub reply trigger', async () => {
    const { orchestrator, store } = fixtureOrchestratorRuntime();
    const { createComment } = mockOctokit();
    const seeded = await orchestrator.request({
      taskId: { repo: DEFAULT_REPO_KEY, issue: 2709 },
      requestId: 'seed-mention',
      pipeline: 'claude',
      work: testWork('claude'),
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });

    const result = await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      'This is working now.\n\n@agent',
    );

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'This is working now.\n\n@agent' }),
    );
    expect(result).toBeUndefined();
    expect(
      await store.listRuns({ repo: DEFAULT_REPO_KEY, issue: 2709 }),
    ).toHaveLength(2);
  });

  it('400s on a malformed caller ID before ever touching the orchestrator', async () => {
    const { orchestrator } = fixtureOrchestratorRuntime();
    const requestSpy = vi.spyOn(orchestrator, 'request');

    await expect(
      retriggerIssue(DEFAULT_REPO, 2709, 'not-a-uuid'),
    ).rejects.toThrow('A valid dispatch caller ID is required');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("reuses the task's durable Work payload without re-reading GitHub", async () => {
    const { orchestrator } = fixtureOrchestratorRuntime();
    mockOctokit();
    const taskId = { repo: DEFAULT_REPO_KEY, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed',
      pipeline: 'claude',
      work: {
        origin: { principal: 'github:someone-else', channel: 'github' },
        spec: {
          title: 'Seed title',
          description: 'Seed body',
          pipeline: 'claude',
          target: { repo: 'supersprinklesracing/sprinkles' },
        },
      },
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    // Settle the seeded run so the task's lock is free for retriggerIssue's
    // own request below - only the pre-existing `work` should matter here.
    await orchestrator.report(seeded.run.runId, { ok: true });
    const { get } = mockOctokit();
    const requestSpy = vi.spyOn(orchestrator, 'request');

    await retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID, undefined);

    expect(get).not.toHaveBeenCalled();
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        work: {
          origin: { principal: 'github:someone-else', channel: 'github' },
          spec: {
            title: 'Seed title',
            description: 'Seed body',
            pipeline: 'claude',
            target: { repo: 'supersprinklesracing/sprinkles' },
          },
        },
      }),
    );
  });
});

describe('assignPipeline', () => {
  function mockOctokit(
    labels: string[],
    overrides: Record<string, unknown> = {},
  ) {
    const runtime = fixtureOrchestratorRuntime();
    const get = vi.fn().mockResolvedValue({
      data: {
        state: 'open',
        pull_request: undefined,
        labels,
        title: 'Fixture issue',
        body: 'Fixture issue body.',
        ...overrides,
      },
    });
    const setLabels = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, setLabels } },
    });
    return { get, setLabels, ...runtime };
  }

  it('409s before reading or relabeling GitHub when immutable Work already exists', async () => {
    const { get, orchestrator, setLabels } = mockOctokit(['type:bug']);
    await orchestrator.request({
      taskId: { repo: DEFAULT_REPO_KEY, issue: 2709 },
      requestId: 'already-admitted',
      pipeline: 'claude',
      work: testWork('claude'),
    });

    await expect(
      assignPipeline(DEFAULT_REPO, 2709, 'codex', 'jlapenna'),
    ).rejects.toThrow(
      new ActionError(
        'Issue already has immutable Work; retry its admitted pipeline instead',
        409,
      ),
    );
    expect(get).not.toHaveBeenCalled();
    expect(setLabels).not.toHaveBeenCalled();
  });

  it('adds the target pipeline label to an unclaimed issue', async () => {
    const { setLabels, store } = mockOctokit(['type:bug']);

    await assignPipeline(DEFAULT_REPO, 2709, 'claude', 'jlapenna');

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['type:bug', 'agent:claude'] }),
    );
    const runs = await store.listRuns({ repo: DEFAULT_REPO_KEY, issue: 2709 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      pipeline: 'claude',
      params: { mode: 'implement' },
    });
    expect(
      (await store.readTask({ repo: DEFAULT_REPO_KEY, issue: 2709 }))?.task
        .work,
    ).toMatchObject({
      origin: { principal: 'github:jlapenna', channel: 'github' },
    });
  });

  // The primary production path for this action: assigning straight from a
  // status:ready-for-agent Inbox item. Leaving that label in place would
  // have action-items.ts keep classifying the now-dispatched issue as
  // ready-for-agent even though it already carries an agent label (#859
  // review).
  it('clears status:ready-for-agent as part of the same label write', async () => {
    const { setLabels } = mockOctokit(['status:ready-for-agent', 'type:bug']);

    await assignPipeline(DEFAULT_REPO, 2709, 'codex', 'jlapenna');

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['type:bug', 'agent:codex'] }),
    );
  });

  it('400s when the issue already has an agent assignment', async () => {
    mockOctokit(['agent:claude']);

    await expect(
      assignPipeline(DEFAULT_REPO, 2709, 'codex', 'jlapenna'),
    ).rejects.toThrow('Issue already has an agent assignment');
  });

  it('400s for a closed issue', async () => {
    mockOctokit([], { state: 'closed' });

    await expect(
      assignPipeline(DEFAULT_REPO, 2709, 'claude', 'jlapenna'),
    ).rejects.toThrow('Only open issues can be assigned to an agent');
  });

  it('400s for a pull request', async () => {
    mockOctokit([], { pull_request: {} });

    await expect(
      assignPipeline(DEFAULT_REPO, 2709, 'claude', 'jlapenna'),
    ).rejects.toThrow('Only open issues can be assigned to an agent');
  });
});
