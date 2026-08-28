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
  cancelWorkflowRun,
  clearHumanNeededLabel,
  closeIssue,
  createQuickTask,
  deriveQuickTaskTitle,
  dispatchUnstickPrs,
  postComment,
  reassignPipeline,
  retriggerIssue,
  updateIssueContent,
  updatePrBranch,
} from './backend-actions';
import { type DispatchTokenProvider, REPO_HEADER } from './github-app-tokens';
import { getGithubClient } from './github-client';
import { drainOutbox } from './orchestrator-dispatch';
import { createOrchestratorRuntime } from './orchestrator-runtime';
import { settleTerminalRuns } from './orchestrator-terminal-runs';

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };
const DISPATCH_ID = '11111111-1111-4111-8111-111111111111';
// `controlPlaneRepository()`'s own fallback (see deployment.ts) - no env
// var overrides it in this test environment (see orchestrator-routes.test.ts's
// identical comment), so this is the repo retriggerIssue/reassignPipeline
// build their orchestrator `TaskId` from regardless of `DEFAULT_REPO` above.
const CONTROL_PLANE_REPO = 'jlapenna/agent-lcars';

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
});

/** Builds a fresh orchestrator runtime the same shape
 * `orchestrator-runtime.ts`'s `createOrchestratorRuntime` does - a
 * `MemoryStore`, an `Orchestrator` over it, and `drain` composed from
 * `drainOutbox` with a fake `fetch` (see orchestrator-routes.test.ts's
 * identical fixture) - then installs it as the mocked runtime backend-
 * actions.ts's retriggerIssue/reassignPipeline read via
 * `createOrchestratorRuntime()`. */
function fixtureOrchestratorRuntime(
  now = '2026-08-15T12:00:00.000Z',
  options: { dispatchExecutor?: 'queue' } = {},
) {
  const clock = { now: () => now };
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, clock);
  const calls: { url: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    // The reconcile sweep's terminal-run probe (#1361) lists a workflow's
    // runs; serve it an empty listing so nothing is settled that way here
    // and these tests keep exercising the lease sweep they are about.
    if (url.includes('/runs?event=workflow_dispatch')) {
      return new Response(JSON.stringify({ workflow_runs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const status = url.includes('/actions/workflows/') ? 204 : 201;
    return new Response(null, { status });
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
  const settleTerminal = () =>
    settleTerminalRuns({ store, orchestrator, tokens, fetchImpl });
  (createOrchestratorRuntime as Mock).mockReturnValue({
    store,
    orchestrator,
    ...options,
    drain,
    settleTerminal,
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

describe('clearHumanNeededLabel', () => {
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

    await clearHumanNeededLabel(DEFAULT_REPO, 2709);

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

    await clearHumanNeededLabel(DEFAULT_REPO, 2709);

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
      clearHumanNeededLabel(DEFAULT_REPO, 2709),
    ).resolves.toBeUndefined();
    // The label write never happened - nothing changed for the orchestrator
    // to catch up on.
    expect(sweepSpy).not.toHaveBeenCalled();
  });
});

describe('postComment (mention routing)', () => {
  function mockOctokit() {
    // clearNeedsHumanLabel's own sweep-the-orchestrator follow-up (#1183)
    // fires on every successful removeLabel below - give it somewhere real
    // to land instead of a bare unmocked createOrchestratorRuntime().
    fixtureOrchestratorRuntime();
    const createComment = vi.fn().mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/1#issuecomment-1' },
    });
    const removeLabel = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { createComment, removeLabel } },
    });
    return { createComment, removeLabel };
  }

  it('rejects a blank body without calling GitHub', async () => {
    const { createComment } = mockOctokit();

    await expect(postComment(DEFAULT_REPO, 2709, '   ')).rejects.toThrow(
      'Comment body is required',
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it('posts plain text when no agent label is present', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2');

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2' }),
    );
  });

  it('appends @claude for an item carrying only the claude label', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', ['agent:claude']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n@claude' }),
    );
  });

  it('appends /oc for an item carrying only the opencode label', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', ['agent:opencode']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n/oc' }),
    );
  });

  it('appends /codex for an item carrying the codex label', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', ['agent:codex']);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2\n\n/codex' }),
    );
  });

  it('posts plain text for contradictory multi-agent labels', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Use option 2', [
      'agent:claude',
      'agent:opencode',
    ]);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Use option 2' }),
    );
  });

  it('preserves a GitHub-style @claude mention in ordinary prose', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Ping @claude please', [
      'agent:claude',
    ]);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Ping @claude please' }),
    );
  });

  it('appends an exact /oc command when prose merely mentions /opencode', async () => {
    const { createComment } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'Please /opencode this', [
      'agent:opencode',
    ]);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Please /opencode this\n\n/oc' }),
    );
  });

  it('clears the needs-human status after posting', async () => {
    const { removeLabel } = mockOctokit();

    await postComment(DEFAULT_REPO, 2709, 'hi', ['agent:claude']);

    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'status:needs-human' }),
    );
  });

  it('posting a comment alone (no label actually cleared) does not sweep the orchestrator', async () => {
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: {
          createComment: vi.fn().mockResolvedValue({
            data: {
              html_url: 'https://github.com/o/r/issues/1#issuecomment-1',
            },
          }),
          // 404: nothing to clear, so clearNeedsHumanLabel's own sweep never
          // fires either - isolates that createComment itself is inert from
          // the orchestrator's perspective, per the seam's own analysis.
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

    await postComment(DEFAULT_REPO, 2709, 'hi', ['agent:claude']);

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

describe('cancelWorkflowRun', () => {
  function mockOctokit({
    displayTitle = '#4242: Fix the flaky test',
    runStatuses = ['completed'],
  }: { displayTitle?: string; runStatuses?: string[] } = {}) {
    const cancelWorkflowRun_ = vi.fn().mockResolvedValue({});
    const getWorkflowRun = vi.fn().mockImplementation(async () => ({
      data: {
        display_title: displayTitle,
        status: runStatuses.shift() ?? 'completed',
      },
    }));
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        actions: { cancelWorkflowRun: cancelWorkflowRun_, getWorkflowRun },
      },
    });
    return { cancelWorkflowRun_, getWorkflowRun };
  }

  it('cancels the given run on the console repo', async () => {
    const { cancelWorkflowRun_ } = mockOctokit();
    fixtureOrchestratorRuntime();

    await cancelWorkflowRun(DEFAULT_REPO, 12345);

    expect(cancelWorkflowRun_).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      run_id: 12345,
    });
  });

  // #1183: cancelWorkflowRun's own GitHub Actions run id has no orchestrator
  // equivalent recorded anywhere (Run only ever carries the orchestrator's
  // own minted runId - see model.ts). The anchor issue number parsed from
  // the run's display_title is the only honest join available; the
  // orchestrator's one-live-run-per-task invariant means a live run found
  // under that anchor can only be the one this cancellation was acting on.
  it("cancels the anchor's live orchestrator run so its mutex releases immediately", async () => {
    const { getWorkflowRun } = mockOctokit({
      displayTitle: '#4242: Fix the flaky test',
    });
    const { store, orchestrator, calls } = fixtureOrchestratorRuntime();
    const taskId = { repo: CONTROL_PLANE_REPO, issue: 4242 };
    const requested = await orchestrator.request({
      taskId,
      requestId: 'live-run',
      pipeline: 'claude',
    });
    if ('refused' in requested) throw new Error('seed request was refused');

    await cancelWorkflowRun(DEFAULT_REPO, 12345);

    expect(getWorkflowRun).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      run_id: 12345,
    });
    const run = await store.readRun(requested.run.runId);
    expect(run?.state).toBe('canceled');
    // The cancellation's own report-outcome outbox entry gets drained as
    // part of the same sweep+drain notifyReconcile always runs afterward.
    expect(calls.some((c) => c.url.includes('/issues/4242/comments'))).toBe(
      true,
    );
  });

  it('leaves the orchestrator alone when the anchor has no live run', async () => {
    mockOctokit({ displayTitle: '#4242: Fix the flaky test' });
    const { orchestrator } = fixtureOrchestratorRuntime();
    const cancelSpy = vi.spyOn(orchestrator, 'cancel');

    await cancelWorkflowRun(DEFAULT_REPO, 12345);

    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('waits for GitHub to finish cancellation before reflecting into the orchestrator', async () => {
    vi.useFakeTimers();
    try {
      const { getWorkflowRun } = mockOctokit({
        runStatuses: ['in_progress', 'completed'],
      });
      const { orchestrator } = fixtureOrchestratorRuntime();
      const cancelSpy = vi.spyOn(orchestrator, 'cancel');

      const cancellation = cancelWorkflowRun(DEFAULT_REPO, 12345);
      await vi.advanceTimersByTimeAsync(0);
      expect(getWorkflowRun).toHaveBeenCalledTimes(1);
      expect(cancelSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await cancellation;
      expect(getWorkflowRun).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a slow cancellation to the scheduled sweep without reflecting early', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { getWorkflowRun } = mockOctokit({
        runStatuses: Array.from({ length: 6 }, () => 'in_progress'),
      });
      const { orchestrator } = fixtureOrchestratorRuntime();
      const cancelSpy = vi.spyOn(orchestrator, 'cancel');

      const cancellation = cancelWorkflowRun(DEFAULT_REPO, 12345);
      await vi.runAllTimersAsync();
      await cancellation;

      expect(getWorkflowRun).toHaveBeenCalledTimes(6);
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('scheduled sweep will converge it'),
        12345,
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('parses the anchor from an opencode display title the same way the dashboard does', async () => {
    mockOctokit({
      displayTitle: '#777: OpenCode issue agent [dispatch:g1:intent-777]',
    });
    const { store, orchestrator } = fixtureOrchestratorRuntime();
    const taskId = { repo: CONTROL_PLANE_REPO, issue: 777 };
    const requested = await orchestrator.request({
      taskId,
      requestId: 'live-run',
      pipeline: 'opencode',
    });
    if ('refused' in requested) throw new Error('seed request was refused');

    await cancelWorkflowRun(DEFAULT_REPO, 12345);

    const run = await store.readRun(requested.run.runId);
    expect(run?.state).toBe('canceled');
  });

  // A native work item's dispatch marker carries no leading `#<N>:` join
  // key for issueNumberFromDisplayTitle to parse - its marker's intentId IS
  // the orchestrator's own runId (see cancelAnchorFromDisplayTitle), so the
  // console cancels it directly instead of looking up an issue's active run
  // first (contrast with the two tests above, which both seed a task and go
  // through store.readActiveRun).
  it('cancels a native work item run directly from its dispatch marker, without an issue lookup', async () => {
    const nativeRunId = 'work:01M107KR3X6VDH7NZ4JDXZNSS2/r1';
    mockOctokit({
      displayTitle: `native work: Claude issue agent [dispatch:g1:${nativeRunId}]`,
    });
    const { store, orchestrator } = fixtureOrchestratorRuntime();
    const cancelSpy = vi.spyOn(orchestrator, 'cancel');
    const readActiveRunSpy = vi.spyOn(store, 'readActiveRun');
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');

    await cancelWorkflowRun(DEFAULT_REPO, 12345);

    expect(cancelSpy).toHaveBeenCalledWith(
      nativeRunId,
      'canceled from console',
    );
    expect(readActiveRunSpy).not.toHaveBeenCalled();
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('skips reflection and the sweep when the title carries no anchor number', async () => {
    mockOctokit({ displayTitle: 'Manually dispatched run' });
    const { orchestrator } = fixtureOrchestratorRuntime();
    const sweepSpy = vi.spyOn(orchestrator, 'sweepExpired');
    const cancelSpy = vi.spyOn(orchestrator, 'cancel');

    await expect(
      cancelWorkflowRun(DEFAULT_REPO, 12345),
    ).resolves.toBeUndefined();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('still resolves the cancel when looking up the anchor fails', async () => {
    const { cancelWorkflowRun_ } = mockOctokit();
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        actions: {
          cancelWorkflowRun: cancelWorkflowRun_,
          getWorkflowRun: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Not Found'), { status: 404 }),
            ),
        },
      },
    });
    fixtureOrchestratorRuntime();

    await expect(
      cancelWorkflowRun(DEFAULT_REPO, 12345),
    ).resolves.toBeUndefined();
    expect(cancelWorkflowRun_).toHaveBeenCalled();
  });

  it('propagates a GitHub API error (e.g. the run already completed) and never looks up an anchor', async () => {
    const getWorkflowRun = vi.fn();
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        actions: {
          cancelWorkflowRun: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error('Conflict'), { status: 409 }),
            ),
          getWorkflowRun,
        },
      },
    });

    await expect(cancelWorkflowRun(DEFAULT_REPO, 12345)).rejects.toThrow(
      'Conflict',
    );
    expect(getWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('dispatchUnstickPrs', () => {
  it('dispatches playbook-unstick-prs.yml with a trimmed context input', async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { actions: { createWorkflowDispatch } },
    });

    await dispatchUnstickPrs('  PR #123 stuck  ');

    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      workflow_id: 'playbook-unstick-prs.yml',
      ref: 'main',
      inputs: { context: 'PR #123 stuck' },
    });
  });

  it('omits the context input when none is given', async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { actions: { createWorkflowDispatch } },
    });

    await dispatchUnstickPrs();

    expect(createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: {} }),
    );
  });
});

describe('retriggerIssue (orchestrator dispatch, #1183)', () => {
  // retriggerIssue no longer checks GitHub labels at all - the orchestrator
  // is the one dispatch entry point, and its `request()` is keyed by the
  // task's own TaskId (issue number in `controlPlaneRepository()`, not the
  // `repo` argument - see backend-actions.ts's own doc comment on this
  // function). `getGithubClient()` is still needed for
  // clearNeedsHumanLabel's label removal and an optional steering-note
  // comment.
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

  it('falls back to claude and dispatches it when the task has no prior orchestrator run', async () => {
    const { calls } = fixtureOrchestratorRuntime();
    mockOctokit();

    const result = await retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID);

    expect(result).toEqual({ pipelineFallback: true });
    expect(
      calls.some((c) =>
        c.url.includes(
          `/repos/${CONTROL_PLANE_REPO}/actions/workflows/claude.yml/dispatches`,
        ),
      ),
    ).toBe(true);
  });

  it('uses QueueExecutor for a console retry after the global cutover', async () => {
    const { store, calls } = fixtureOrchestratorRuntime(undefined, {
      dispatchExecutor: 'queue',
    });
    mockOctokit();

    await retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID);

    const [run] = await store.listRuns({
      repo: CONTROL_PLANE_REPO,
      issue: 2709,
    });
    expect(run?.executor).toBe('queue');
    expect(calls.some((call) => call.url.includes('/actions/workflows/'))).toBe(
      false,
    );
  });

  it("reads the task's latest orchestrator run for the dispatch pipeline instead of defaulting", async () => {
    const { store, orchestrator, calls } = fixtureOrchestratorRuntime();
    mockOctokit();
    const taskId = { repo: CONTROL_PLANE_REPO, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed',
      pipeline: 'opencode',
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    // Settle the seeded run so the task's lock is free for retriggerIssue's
    // own request below - only the pipeline history should matter here.
    await orchestrator.report(seeded.run.runId, { ok: true });

    const result = await retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID);

    expect(result).toEqual({ pipelineFallback: false });
    expect(
      calls.some((c) =>
        c.url.includes(
          `/repos/${CONTROL_PLANE_REPO}/actions/workflows/opencode.yml/dispatches`,
        ),
      ),
    ).toBe(true);
    expect((await store.listRuns(taskId)).length).toBe(2);
  });

  it('refuses with a structured 409 when a run is already active for the task', async () => {
    const { orchestrator } = fixtureOrchestratorRuntime();
    mockOctokit();
    await orchestrator.request({
      taskId: { repo: CONTROL_PLANE_REPO, issue: 2709 },
      requestId: 'already-live',
      pipeline: 'claude',
    });

    await expect(
      retriggerIssue(DEFAULT_REPO, 2709, DISPATCH_ID),
    ).rejects.toThrow(
      new ActionError('A run is already active for this task', 409),
    );
  });

  it('posts the steering note and still dispatches when the note carries no mention', async () => {
    const { calls } = fixtureOrchestratorRuntime();
    const { createComment } = mockOctokit();

    const result = await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      'try a different approach',
    );

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'try a different approach' }),
    );
    expect(result.pipelineFallback).toBe(true);
    expect(
      calls.some((c) => c.url.includes('/actions/workflows/claude.yml/')),
    ).toBe(true);
  });

  it('skips the orchestrator request when a later line carries a reply-trigger alias (would double-dispatch)', async () => {
    const { calls } = fixtureOrchestratorRuntime();
    const { createComment } = mockOctokit();

    // No prior run falls back to Claude; @agent is its shared alias.
    const result = await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      'This is working now.\n\n@agent',
    );

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'This is working now.\n\n@agent' }),
    );
    expect(result).toEqual({ pipelineFallback: true });
    // The webhook-driven mention path is the sole trigger here - a direct
    // request() alongside it would double-dispatch (see this function's own
    // doc comment).
    expect(calls.some((c) => c.url.includes('/actions/workflows/'))).toBe(
      false,
    );
  });

  it('400s on a malformed caller ID before ever touching the orchestrator', async () => {
    const { orchestrator } = fixtureOrchestratorRuntime();
    const requestSpy = vi.spyOn(orchestrator, 'request');

    await expect(
      retriggerIssue(DEFAULT_REPO, 2709, 'not-a-uuid'),
    ).rejects.toThrow('A valid dispatch caller ID is required');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('derives and forwards work from the live issue when the task has none yet', async () => {
    const { orchestrator } = fixtureOrchestratorRuntime();
    const { get } = mockOctokit();
    get.mockResolvedValue({
      data: { title: 'Live title', body: 'Live body' },
    });
    const requestSpy = vi.spyOn(orchestrator, 'request');

    await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      undefined,
      'jlapenna',
    );

    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: DEFAULT_REPO.owner,
        repo: DEFAULT_REPO.name,
        issue_number: 2709,
      }),
    );
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'Live title',
            description: 'Live body',
            pipeline: 'claude',
            target: { repo: 'supersprinklesracing/sprinkles' },
          },
        },
      }),
    );
  });

  it('does not re-read the issue or forward work when the task already carries one', async () => {
    const { orchestrator } = fixtureOrchestratorRuntime();
    mockOctokit();
    const taskId = { repo: CONTROL_PLANE_REPO, issue: 2709 };
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

    await retriggerIssue(
      DEFAULT_REPO,
      2709,
      DISPATCH_ID,
      undefined,
      'jlapenna',
    );

    expect(get).not.toHaveBeenCalled();
    expect(requestSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ work: expect.anything() }),
    );
  });
});

describe('reassignPipeline (orchestrator dispatch, #1183)', () => {
  // reassignPipeline still swaps the issue's own `agent:*` label directly
  // (the dashboard/webhook-mention routing's own source of truth - see this
  // function's doc comment), then hands the task's orchestrator lock to the
  // new pipeline.
  function mockOctokit(labels: string[] = []) {
    // `title`/`body` feed the `work` derivation below (reusing this same
    // read) when the task has no `work` yet - every test in this block,
    // unless it seeds one - so they get defaults here too, same reasoning
    // as retriggerIssue's own `mockOctokit`'s `get` default.
    const get = vi.fn().mockResolvedValue({
      data: { title: 'Issue title', body: 'Issue body', labels },
    });
    const setLabels = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, setLabels } },
    });
    return { get, setLabels };
  }

  it('swaps the fleet-wide default label and requests the target pipeline when no run is live', async () => {
    const { setLabels } = mockOctokit(['agent:codex']);
    const { store, calls } = fixtureOrchestratorRuntime();

    await reassignPipeline(DEFAULT_REPO, 2709, 'claude', DISPATCH_ID);

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['agent:claude'] }),
    );
    expect(
      calls.some((c) =>
        c.url.includes(
          `/repos/${CONTROL_PLANE_REPO}/actions/workflows/claude.yml/dispatches`,
        ),
      ),
    ).toBe(true);
    const runs = await store.listRuns({
      repo: CONTROL_PLANE_REPO,
      issue: 2709,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].pipeline).toBe('claude');
  });

  it('uses QueueExecutor for a console reassignment after the global cutover', async () => {
    mockOctokit(['agent:codex']);
    const { store, calls } = fixtureOrchestratorRuntime(undefined, {
      dispatchExecutor: 'queue',
    });

    await reassignPipeline(DEFAULT_REPO, 2709, 'claude', DISPATCH_ID);

    const [run] = await store.listRuns({
      repo: CONTROL_PLANE_REPO,
      issue: 2709,
    });
    expect(run?.executor).toBe('queue');
    expect(calls.some((call) => call.url.includes('/actions/workflows/'))).toBe(
      false,
    );
  });

  // A reassignment hands the task to a fresh agent, so any pending
  // needs-human park state should clear in the same atomic label write -
  // otherwise the issue is left carrying a pipeline label that no longer
  // matches who owns the work alongside a stale "needs a human" flag.
  it('clears status:needs-human in the same atomic label swap', async () => {
    const { setLabels } = mockOctokit([
      'agent:codex',
      'status:needs-human',
      'priority:high',
    ]);
    fixtureOrchestratorRuntime();

    await reassignPipeline(DEFAULT_REPO, 2709, 'claude', DISPATCH_ID);

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ['priority:high', 'agent:claude'],
      }),
    );
  });

  // #811 Codex review on #904: a watched repo's own `agents` config can
  // override the `agent:*` label per pipeline - reassignPipeline must swap
  // THIS repo's actual configured labels, not the fleet-wide default.
  it('resolves a custom per-repo label contract instead of the fleet-wide default', async () => {
    const customRepo = {
      ...DEFAULT_REPO,
      agents: {
        claude: {
          workflowFile: 'claude.yml',
          label: 'bot:claude',
          replyTrigger: '@claude',
        },
        codex: {
          workflowFile: 'codex.yml',
          label: 'bot:codex',
          replyTrigger: '/codex',
        },
      },
    };
    const { setLabels } = mockOctokit(['bot:codex']);
    fixtureOrchestratorRuntime();

    await reassignPipeline(customRepo, 2709, 'claude', DISPATCH_ID);

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['bot:claude'] }),
    );
  });

  it('cancels the live run before requesting the new pipeline, carrying its mode forward', async () => {
    mockOctokit(['agent:codex']);
    const { store, orchestrator, calls } = fixtureOrchestratorRuntime();
    const taskId = { repo: CONTROL_PLANE_REPO, issue: 2709 };
    await orchestrator.request({
      taskId,
      requestId: 'live-codex',
      pipeline: 'codex',
      params: { mode: 'review' },
    });

    await reassignPipeline(DEFAULT_REPO, 2709, 'claude', DISPATCH_ID);

    const runs = await store.listRuns(taskId);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.pipeline === 'codex')?.state).toBe('canceled');
    const claudeRun = runs.find((r) => r.pipeline === 'claude');
    expect(claudeRun?.params).toEqual({ mode: 'review' });
    expect(
      calls.some((c) =>
        c.url.includes(
          `/repos/${CONTROL_PLANE_REPO}/actions/workflows/claude.yml/dispatches`,
        ),
      ),
    ).toBe(true);
  });

  it('400s on a malformed caller ID before ever calling GitHub or the orchestrator', async () => {
    const { setLabels } = mockOctokit();
    const { orchestrator } = fixtureOrchestratorRuntime();
    const requestSpy = vi.spyOn(orchestrator, 'request');

    await expect(
      reassignPipeline(DEFAULT_REPO, 2709, 'claude', 'not-a-uuid'),
    ).rejects.toThrow('A valid dispatch caller ID is required');
    expect(setLabels).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('400s when the repo declares no integration for the target pipeline, without calling GitHub or the orchestrator', async () => {
    const { setLabels } = mockOctokit();
    const { orchestrator } = fixtureOrchestratorRuntime();
    const requestSpy = vi.spyOn(orchestrator, 'request');

    await expect(
      reassignPipeline(
        { ...DEFAULT_REPO, agents: {} },
        2709,
        'claude',
        DISPATCH_ID,
      ),
    ).rejects.toThrow(/does not declare a claude agent integration/);
    expect(setLabels).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('derives and forwards work from the already-fetched issue when the task has none yet', async () => {
    const { get } = mockOctokit(['agent:codex']);
    get.mockResolvedValue({
      data: { title: 'Live title', body: 'Live body', labels: ['agent:codex'] },
    });
    const { orchestrator } = fixtureOrchestratorRuntime();
    const requestSpy = vi.spyOn(orchestrator, 'request');

    await reassignPipeline(
      DEFAULT_REPO,
      2709,
      'claude',
      DISPATCH_ID,
      'jlapenna',
    );

    // Not a second read: the label swap's own issues.get is the only one.
    expect(get).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        work: {
          origin: { principal: 'github:jlapenna', channel: 'github' },
          spec: {
            title: 'Live title',
            description: 'Live body',
            pipeline: 'claude',
            target: { repo: 'supersprinklesracing/sprinkles' },
          },
        },
      }),
    );
  });

  it('does not forward work when the task already carries one', async () => {
    mockOctokit(['agent:codex']);
    const { orchestrator } = fixtureOrchestratorRuntime();
    const taskId = { repo: CONTROL_PLANE_REPO, issue: 2709 };
    const seeded = await orchestrator.request({
      taskId,
      requestId: 'seed',
      pipeline: 'codex',
      work: {
        origin: { principal: 'github:someone-else', channel: 'github' },
        spec: {
          title: 'Seed title',
          description: 'Seed body',
          pipeline: 'codex',
          target: { repo: 'supersprinklesracing/sprinkles' },
        },
      },
    });
    if ('refused' in seeded) throw new Error('seed request was refused');
    await orchestrator.report(seeded.run.runId, { ok: true });
    const requestSpy = vi.spyOn(orchestrator, 'request');

    await reassignPipeline(
      DEFAULT_REPO,
      2709,
      'claude',
      DISPATCH_ID,
      'jlapenna',
    );

    expect(requestSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ work: expect.anything() }),
    );
  });
});

describe('assignPipeline', () => {
  function mockOctokit(
    labels: string[],
    overrides: Record<string, unknown> = {},
  ) {
    const get = vi.fn().mockResolvedValue({
      data: { state: 'open', pull_request: undefined, labels, ...overrides },
    });
    const setLabels = vi.fn().mockResolvedValue({});
    (getGithubClient as Mock).mockReturnValue({
      rest: { issues: { get, setLabels } },
    });
    return { get, setLabels };
  }

  it('adds the target pipeline label to an unclaimed issue', async () => {
    const { setLabels } = mockOctokit(['type:bug']);

    await assignPipeline(DEFAULT_REPO, 2709, 'claude');

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['type:bug', 'agent:claude'] }),
    );
  });

  // The primary production path for this action: assigning straight from a
  // status:ready-for-agent Inbox item. Leaving that label in place would
  // have action-items.ts keep classifying the now-dispatched issue as
  // ready-for-agent even though it already carries an agent label (#859
  // review).
  it('clears status:ready-for-agent as part of the same label write', async () => {
    const { setLabels } = mockOctokit(['status:ready-for-agent', 'type:bug']);

    await assignPipeline(DEFAULT_REPO, 2709, 'codex');

    expect(setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['type:bug', 'agent:codex'] }),
    );
  });

  it('400s when the issue already has an agent assignment', async () => {
    mockOctokit(['agent:claude']);

    await expect(assignPipeline(DEFAULT_REPO, 2709, 'codex')).rejects.toThrow(
      'Issue already has an agent assignment',
    );
  });

  it('400s for a closed issue', async () => {
    mockOctokit([], { state: 'closed' });

    await expect(assignPipeline(DEFAULT_REPO, 2709, 'claude')).rejects.toThrow(
      'Only open issues can be assigned to an agent',
    );
  });

  it('400s for a pull request', async () => {
    mockOctokit([], { pull_request: {} });

    await expect(assignPipeline(DEFAULT_REPO, 2709, 'claude')).rejects.toThrow(
      'Only open issues can be assigned to an agent',
    );
  });
});

describe('deriveQuickTaskTitle', () => {
  it('takes the first line and collapses internal whitespace', () => {
    expect(
      deriveQuickTaskTitle('Fix the   flaky   test\nmore detail here'),
    ).toBe('Fix the flaky test');
  });

  it('truncates long first lines with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const title = deriveQuickTaskTitle(long);
    expect(title.length).toBe(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('leaves short first lines untouched', () => {
    expect(deriveQuickTaskTitle('short task')).toBe('short task');
  });
});

describe('createQuickTask', () => {
  const request = {
    requestId: '11111111-1111-4111-8111-111111111111',
    repository: DEFAULT_REPO,
    pipeline: 'claude' as const,
    description: '  Fix the flaky test\nmore context  ',
  };

  function mockOctokit(
    overrides: {
      createIssue?: Mock;
      listForRepo?: Mock;
      searchIssues?: Mock;
      getRef?: Mock;
      getTag?: Mock;
      createTag?: Mock;
      createRef?: Mock;
      deleteRef?: Mock;
      getRepository?: Mock;
    } = {},
  ) {
    const createIssue =
      overrides.createIssue ??
      vi.fn().mockResolvedValue({
        data: { number: 99, html_url: 'https://github.com/x/y/issues/99' },
      });
    const listForRepo =
      overrides.listForRepo ?? vi.fn().mockResolvedValue({ data: [] });
    const searchIssues =
      overrides.searchIssues ??
      vi.fn().mockResolvedValue({ data: { items: [] } });
    const tagObjects = new Map<string, { message: string }>();
    const claimRefs = new Map<string, string>();
    let tagSequence = 0;
    const getRef =
      overrides.getRef ??
      vi.fn().mockImplementation(async ({ ref }) => {
        if (ref === 'heads/main') {
          return {
            data: { object: { type: 'commit', sha: 'base-commit-sha' } },
          };
        }
        const sha = claimRefs.get(ref);
        if (!sha) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { object: { type: 'tag', sha } } };
      });
    const getTag =
      overrides.getTag ??
      vi.fn().mockImplementation(async ({ tag_sha }) => ({
        data: { message: tagObjects.get(tag_sha)?.message ?? '' },
      }));
    const createTag =
      overrides.createTag ??
      vi.fn().mockImplementation(async ({ message }) => {
        const sha = `claim-tag-${++tagSequence}`;
        tagObjects.set(sha, { message });
        return { data: { sha } };
      });
    const createRef =
      overrides.createRef ??
      vi.fn().mockImplementation(async ({ ref, sha }) => {
        const shortRef = ref.replace(/^refs\//u, '');
        if (claimRefs.has(shortRef)) {
          throw Object.assign(new Error('Reference already exists'), {
            status: 422,
          });
        }
        claimRefs.set(shortRef, sha);
        return { data: { ref, object: { type: 'tag', sha } } };
      });
    const deleteRef =
      overrides.deleteRef ??
      vi.fn().mockImplementation(async ({ ref }) => {
        claimRefs.delete(ref);
        return { data: {} };
      });
    const getRepository =
      overrides.getRepository ??
      vi.fn().mockResolvedValue({
        data: { default_branch: 'main', id: 123, visibility: 'private' },
      });
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        issues: { create: createIssue, listForRepo },
        search: { issuesAndPullRequests: searchIssues },
        repos: {
          get: getRepository,
        },
        git: { getRef, getTag, createTag, createRef, deleteRef },
      },
    });
    return {
      createIssue,
      listForRepo,
      searchIssues,
      getRef,
      getTag,
      createTag,
      createRef,
      deleteRef,
      getRepository,
    };
  }

  const evidenceLifecycle = (
    overrides: {
      prepare?: Mock;
      rollback?: Mock;
    } = {},
  ) => {
    const prepare =
      overrides.prepare ??
      vi.fn().mockResolvedValue({
        binding: {
          schemaVersion: 'v1',
          evidenceId: '22222222-2222-4222-8222-222222222222',
          requestId: request.requestId,
          repositoryId: 123,
          normalizedSha256: 'a'.repeat(64),
          visibilityAtUpload: 'private',
          createdAt: '2026-08-14T00:00:00.000Z',
        },
        generation: '1',
      });
    const rollback = overrides.rollback ?? vi.fn().mockResolvedValue(undefined);
    return {
      lifecycle: {
        intent: {
          ...request,
          evidenceId: '22222222-2222-4222-8222-222222222222',
          source: { route: '/', identities: '', capturedAt: '' },
        },
        hook: {
          prepare,
          rollbackDefinitiveCreateFailure: rollback,
        },
      },
      prepare,
      rollback,
    };
  };

  it('rejects a blank description without calling GitHub', async () => {
    const { createIssue } = mockOctokit({});

    expect(() => createQuickTask({ ...request, description: '   ' })).toThrow(
      'Task description is required',
    );
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('rejects an invalid request ID without calling GitHub', async () => {
    const { createIssue, listForRepo } = mockOctokit();

    expect(() =>
      createQuickTask({ ...request, requestId: 'not-a-uuid' }),
    ).toThrow('A valid Quick Task request ID is required');
    expect(listForRepo).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('creates one immediately-dispatchable issue with a durable request marker', async () => {
    const { createIssue, createTag, createRef } = mockOctokit();

    const result = await createQuickTask(request);

    expect(createIssue).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      title: 'Fix the flaky test',
      body: expect.stringMatching(
        /^Fix the flaky test\nmore context\n\n<!-- agent-lcars:quick-task-request:v1 id=11111111-1111-4111-8111-111111111111 digest=[0-9a-f]{64} -->$/u,
      ),
      labels: ['intake:quick-task', 'agent:claude'],
    });
    expect(createTag).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: 'agent-lcars/quick-task/11111111-1111-4111-8111-111111111111',
        message: expect.stringMatching(
          /^agent-lcars:quick-task-claim:v1 \{"requestId":"11111111-1111-4111-8111-111111111111","digest":"[0-9a-f]{64}","claimantId":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}$/u,
        ),
        object: 'base-commit-sha',
        type: 'commit',
      }),
    );
    expect(createRef).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      ref: 'refs/tags/agent-lcars/quick-task/11111111-1111-4111-8111-111111111111',
      sha: 'claim-tag-1',
    });
    expect(result).toEqual({
      requestId: request.requestId,
      task: { repository: DEFAULT_REPO, issueNumber: 99 },
      url: 'https://github.com/supersprinklesracing/sprinkles/issues/99',
    });
  });

  it('puts the selected pipeline label in the same creation write', async () => {
    const { createIssue } = mockOctokit();

    await createQuickTask({ ...request, pipeline: 'opencode' });

    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ['intake:quick-task', 'agent:opencode'],
      }),
    );
  });

  it('prepares evidence only after winning the claim and resolving immutable repository metadata', async () => {
    const { createIssue, getRepository } = mockOctokit();
    const { lifecycle, prepare } = evidenceLifecycle();

    await createQuickTask(request, lifecycle);

    expect(getRepository).toHaveBeenCalledWith({
      owner: request.repository.owner,
      repo: request.repository.name,
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: 123, visibility: 'private' }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('does not prepare evidence after losing the claim race', async () => {
    const { createIssue } = mockOctokit();
    await createQuickTask(request);
    const { lifecycle, prepare } = evidenceLifecycle();

    await expect(createQuickTask(request, lifecycle)).rejects.toThrow(
      'Quick Task creation is already claimed',
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when evidence preparation fails before issue creation', async () => {
    const prepare = vi
      .fn()
      .mockRejectedValue(new Error('decoder rejected image'));
    const { deleteRef, createIssue } = mockOctokit();
    const { lifecycle } = evidenceLifecycle({ prepare });

    await expect(createQuickTask(request, lifecycle)).rejects.toThrow(
      'decoder rejected image',
    );
    expect(deleteRef).toHaveBeenCalledTimes(1);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('rolls back the exact prepared evidence and releases the claim after a definitive GitHub rejection', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const { deleteRef } = mockOctokit({ createIssue });
    const { lifecycle, rollback } = evidenceLifecycle();

    await expect(createQuickTask(request, lifecycle)).rejects.toThrow(
      'Validation Failed',
    );
    expect(rollback).toHaveBeenCalledWith(
      expect.objectContaining({ generation: '1' }),
    );
    expect(deleteRef).toHaveBeenCalledTimes(1);
  });

  it('retains the claim when definitive-failure evidence rollback is uncertain', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const { deleteRef } = mockOctokit({ createIssue });
    const rollback = vi.fn().mockRejectedValue(new Error('delete timed out'));
    const { lifecycle } = evidenceLifecycle({ rollback });

    await expect(createQuickTask(request, lifecycle)).rejects.toThrow(
      'delete timed out',
    );
    expect(deleteRef).not.toHaveBeenCalled();
  });

  it('retains prepared evidence and its claim after an ambiguous GitHub failure', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(new Error('socket timed out'));
    const { deleteRef } = mockOctokit({ createIssue });
    const { lifecycle, rollback } = evidenceLifecycle();

    await expect(createQuickTask(request, lifecycle)).rejects.toThrow(
      'socket timed out',
    );
    expect(rollback).not.toHaveBeenCalled();
    expect(deleteRef).not.toHaveBeenCalled();
  });

  it('rejects a distinct concurrent evidence lifecycle instead of sharing an unvalidated upload', async () => {
    let resolveCreate: (() => void) | undefined;
    const createIssue = vi.fn(
      () =>
        new Promise<{ data: { number: number } }>((resolve) => {
          resolveCreate = () => resolve({ data: { number: 99 } });
        }),
    );
    mockOctokit({ createIssue });
    const first = evidenceLifecycle();
    const second = evidenceLifecycle();

    const firstCall = createQuickTask(request, first.lifecycle);
    await expect(createQuickTask(request, second.lifecycle)).rejects.toThrow(
      'Quick Task evidence is already in flight',
    );
    await vi.waitFor(() => expect(resolveCreate).toBeTypeOf('function'));
    resolveCreate();
    await firstCall;
    expect(second.prepare).not.toHaveBeenCalled();
  });

  it('returns the original issue when the same request is retried', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      return { data: { number: 99 } };
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [{ number: 99, body: persistedBody }],
      }));
    mockOctokit({ createIssue, listForRepo });

    const first = await createQuickTask(request);
    const retry = await createQuickTask(request);

    expect(retry).toEqual(first);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('ignores a pull request that copied the Quick Task marker', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      return { data: { number: 99 } };
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [
          { number: 123, body: persistedBody, pull_request: { url: 'pr' } },
          { number: 99, body: persistedBody },
        ],
      }));
    mockOctokit({ createIssue, listForRepo });

    const first = await createQuickTask(request);
    const retry = await createQuickTask(request);

    expect(first.task.issueNumber).toBe(99);
    expect(retry).toEqual(first);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('searches beyond the recent issue window for an older retry', async () => {
    const recent = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1000,
      body: 'unrelated',
    }));
    const createIssue = vi.fn();
    const searchIssues = vi.fn().mockResolvedValue({
      data: {
        items: [
          {
            number: 99,
            body: expect.anything(),
          },
        ],
      },
    });
    const { listForRepo } = mockOctokit({
      createIssue,
      listForRepo: vi.fn().mockResolvedValue({ data: recent }),
      searchIssues,
    });

    // Obtain the exact digest marker from a normal create request, then use
    // it as the old search result on the second request.
    let body = '';
    createIssue.mockImplementationOnce(async (input) => {
      body = input.body;
      return { data: { number: 99 } };
    });
    listForRepo.mockResolvedValueOnce({ data: [] });
    await createQuickTask(request);
    listForRepo.mockResolvedValue({ data: recent });
    searchIssues.mockResolvedValue({
      data: { items: [{ number: 99, body }] },
    });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(searchIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining(`repo:supersprinklesracing/sprinkles`),
      }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent double submissions', async () => {
    let resolveCreate!: (value: { data: { number: number } }) => void;
    const createIssue = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const { listForRepo } = mockOctokit({ createIssue });

    const first = createQuickTask(request);
    const second = createQuickTask(request);
    resolveCreate({ data: { number: 99 } });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    ]);
    expect(listForRepo).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('reconciles the winner when another instance wins the claim-ref race', async () => {
    let claimMessage = '';
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'winner-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      const prefix = 'agent-lcars:quick-task-claim:v1 ';
      const claim = JSON.parse(input.message.slice(prefix.length));
      claimMessage = `${prefix}${JSON.stringify({
        ...claim,
        claimantId: '22222222-2222-4222-8222-222222222222',
      })}`;
      return { data: { sha: 'loser-tag-sha' } };
    });
    const createRef = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Reference already exists'), { status: 422 }),
      );
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const { createIssue } = mockOctokit({
      getRef,
      getTag,
      createTag,
      createRef,
    });

    await expect(createQuickTask(request)).rejects.toThrow(
      'Quick Task creation is already claimed but no issue is visible yet',
    );
    expect(createRef).toHaveBeenCalledTimes(1);
    expect(getTag).toHaveBeenCalledWith(
      expect.objectContaining({ tag_sha: 'winner-tag-sha' }),
    );
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('returns the issue a claim winner creates after the initial scan', async () => {
    let claimMessage = '';
    let digest = '';
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'winner-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      const prefix = 'agent-lcars:quick-task-claim:v1 ';
      const claim = JSON.parse(input.message.slice(prefix.length));
      digest = claim.digest;
      claimMessage = `${prefix}${JSON.stringify({
        ...claim,
        claimantId: '22222222-2222-4222-8222-222222222222',
      })}`;
      return { data: { sha: 'loser-tag-sha' } };
    });
    const createRef = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Reference already exists'), { status: 422 }),
      );
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [
          {
            number: 101,
            body: `Winner\n\n<!-- agent-lcars:quick-task-request:v1 id=${request.requestId} digest=${digest} -->`,
          },
        ],
      }));
    const { createIssue } = mockOctokit({
      getRef,
      getTag,
      createTag,
      createRef,
      listForRepo,
    });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 101 }),
      }),
    );
    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('retains ownership when GitHub loses the successful claim-ref response', async () => {
    let claimMessage = '';
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'our-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      claimMessage = input.message;
      return { data: { sha: 'our-tag-sha' } };
    });
    const createRef = vi
      .fn()
      .mockRejectedValue(new Error('claim response timed out'));
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const { createIssue } = mockOctokit({
      getRef,
      getTag,
      createTag,
      createRef,
    });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('retries reconciliation when a successful claim write is briefly invisible', async () => {
    let claimMessage = '';
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('Bad Gateway'), { status: 502 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'our-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      claimMessage = input.message;
      return { data: { sha: 'our-tag-sha' } };
    });
    const createRef = vi
      .fn()
      .mockRejectedValue(new Error('claim response timed out'));
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const { createIssue } = mockOctokit({
      getRef,
      getTag,
      createTag,
      createRef,
    });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(getRef).toHaveBeenCalledTimes(5);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('recovers an issue created before a transport timeout', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      throw new Error('socket timed out');
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [{ number: 99, body: persistedBody }],
      }));
    mockOctokit({ createIssue, listForRepo });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledTimes(2);
  });

  it('reconciles an HTTP 408 instead of releasing the uniqueness claim', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      throw Object.assign(new Error('Request Timeout'), { status: 408 });
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [{ number: 99, body: persistedBody }],
      }));
    const { deleteRef } = mockOctokit({ createIssue, listForRepo });

    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(deleteRef).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous claim and blocks a second process from creating', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(new Error('socket timed out'));
    const { createRef } = mockOctokit({ createIssue });

    await expect(createQuickTask(request)).rejects.toThrow('socket timed out');
    await expect(createQuickTask(request)).rejects.toThrow(
      'Quick Task creation is already claimed but no issue is visible yet',
    );

    expect(createRef).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('rejects different content when an ambiguous claim is stranded', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(new Error('socket timed out'));
    mockOctokit({ createIssue });

    await expect(createQuickTask(request)).rejects.toThrow('socket timed out');
    await expect(
      createQuickTask({ ...request, description: 'Different task' }),
    ).rejects.toThrow(
      'Quick Task request ID was already used for different task content',
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a request ID for different content', async () => {
    let persistedBody = '';
    const createIssue = vi.fn().mockImplementation(async (input) => {
      persistedBody = input.body;
      return { data: { number: 99 } };
    });
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({
        data: [{ number: 99, body: persistedBody }],
      }));
    mockOctokit({ createIssue, listForRepo });

    await createQuickTask(request);
    await expect(
      createQuickTask({ ...request, description: 'Different task' }),
    ).rejects.toThrow(
      'Quick Task request ID was already used for different task content',
    );
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it('does not retry a definitive label validation failure', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const { listForRepo, deleteRef } = mockOctokit({ createIssue });

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledTimes(1);
    expect(deleteRef).toHaveBeenCalledWith({
      owner: 'supersprinklesracing',
      repo: 'sprinkles',
      ref: 'tags/agent-lcars/quick-task/11111111-1111-4111-8111-111111111111',
    });
  });

  it('retries a transient claim-release failure before returning the create error', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      )
      .mockResolvedValueOnce({ data: { number: 99 } });
    const { deleteRef, createRef } = mockOctokit({ createIssue });
    deleteRef.mockRejectedValueOnce(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
    );

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(deleteRef).toHaveBeenCalledTimes(2);
    await expect(createQuickTask(request)).resolves.toEqual(
      expect.objectContaining({
        task: expect.objectContaining({ issueNumber: 99 }),
      }),
    );
    expect(createRef).toHaveBeenCalledTimes(2);
    expect(createIssue).toHaveBeenCalledTimes(2);
  });

  it('waits for a just-created claim to become visible before releasing it', async () => {
    let claimMessage = '';
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('Bad Gateway'), { status: 502 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'our-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      claimMessage = input.message;
      return { data: { sha: 'our-tag-sha' } };
    });
    const getTag = vi.fn().mockImplementation(async () => ({
      data: { message: claimMessage },
    }));
    const { deleteRef } = mockOctokit({
      createIssue,
      getRef,
      getTag,
      createTag,
    });

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(getRef).toHaveBeenCalledTimes(5);
    expect(deleteRef).toHaveBeenCalledTimes(1);
  });

  it('reconciles a claim deletion whose successful response was lost', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const { deleteRef } = mockOctokit({ createIssue });
    const deleteImplementation = deleteRef.getMockImplementation();
    deleteRef.mockImplementationOnce(async (input) => {
      await deleteImplementation?.(input);
      throw new Error('delete response timed out');
    });

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(deleteRef).toHaveBeenCalledTimes(1);
  });

  it('never deletes a replacement owner after losing a delete response', async () => {
    let ourClaimMessage = '';
    let replacementClaimMessage = '';
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const getRef = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'commit', sha: 'base-commit-sha' } },
      })
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'our-tag-sha' } },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Bad Gateway'), { status: 502 }),
      )
      .mockResolvedValueOnce({
        data: { object: { type: 'tag', sha: 'replacement-tag-sha' } },
      });
    const createTag = vi.fn().mockImplementation(async (input) => {
      const prefix = 'agent-lcars:quick-task-claim:v1 ';
      const claim = JSON.parse(input.message.slice(prefix.length));
      ourClaimMessage = input.message;
      replacementClaimMessage = `${prefix}${JSON.stringify({
        ...claim,
        claimantId: '22222222-2222-4222-8222-222222222222',
      })}`;
      return { data: { sha: 'our-tag-sha' } };
    });
    const getTag = vi.fn().mockImplementation(async ({ tag_sha }) => ({
      data: {
        message:
          tag_sha === 'our-tag-sha' ? ourClaimMessage : replacementClaimMessage,
      },
    }));
    const deleteRef = vi.fn().mockRejectedValue(new Error('response lost'));
    mockOctokit({ createIssue, getRef, getTag, createTag, deleteRef });

    await expect(createQuickTask(request)).rejects.toThrow('Validation Failed');
    expect(deleteRef).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly when a definitive failure claim cannot be released', async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Validation Failed'), { status: 422 }),
      );
    const { deleteRef } = mockOctokit({ createIssue });
    deleteRef.mockRejectedValue(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
    );

    await expect(createQuickTask(request)).rejects.toThrow(
      'claim could not be released; manual reconciliation is required',
    );
    expect(deleteRef).toHaveBeenCalledTimes(3);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });
});
