import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  type AgentRun,
  attemptMarkerFromDisplayTitle,
  collapseLogicalLiveRuns,
  displayRunTitle,
  findStalledQueuedRun,
  getAgentActivity,
  groupLiveRunsByIssue,
  issueNumberFromDisplayTitle,
  issueUrlForRun,
} from './agent-activity';
import { getGithubClient, getWatchedRepos } from './github-client';

const DEFAULT_REPO = { owner: 'supersprinklesracing', name: 'sprinkles' };

vi.mock('./github-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-client')>();
  return {
    ...actual,
    getGithubClient: vi.fn(),
    getWatchedRepos: vi.fn(() => [DEFAULT_REPO]),
  };
});

interface FakeWorkflowRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  event: string;
  html_url: string;
  display_title: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
}

function makeRun(overrides: Partial<FakeWorkflowRun> = {}): FakeWorkflowRun {
  return {
    id: 1,
    status: 'in_progress',
    conclusion: null,
    event: 'issues',
    html_url:
      'https://github.com/supersprinklesracing/sprinkles/actions/runs/1',
    display_title: '#42: Fix the thing',
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
    run_started_at: '2026-07-07T00:00:00Z',
    ...overrides,
  };
}

function makeAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 1,
    repo: DEFAULT_REPO,
    pipeline: 'claude',
    status: 'completed',
    conclusion: 'success',
    event: 'issues',
    url: 'https://github.com/supersprinklesracing/sprinkles/actions/runs/1',
    displayTitle: '#42: Fix the thing',
    issueNumber: 42,
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:00:00Z',
    elapsedSeconds: 60,
    ...overrides,
  };
}

describe('issueNumberFromDisplayTitle', () => {
  it('parses the leading run-name issue number', () => {
    expect(issueNumberFromDisplayTitle('#42: Fix the thing')).toBe(42);
  });

  it('parses the leading run-name issue number for opencode run-names', () => {
    expect(
      issueNumberFromDisplayTitle('opencode #99: Fix the other thing'),
    ).toBe(99);
  });

  it('returns undefined for a pre-rollout title with no leading number', () => {
    expect(issueNumberFromDisplayTitle('Fix the thing')).toBeUndefined();
  });
});

describe('attemptMarkerFromDisplayTitle', () => {
  it('parses the generation and intent id off a claude run-name', () => {
    expect(
      attemptMarkerFromDisplayTitle(
        '#42: Claude issue agent [dispatch:g3:intent-abc-123]',
      ),
    ).toEqual({ generation: 3, intentId: 'intent-abc-123' });
  });

  it('parses a codex run-name, which has no title text before the marker', () => {
    expect(
      attemptMarkerFromDisplayTitle('codex #7: [dispatch:g1:intent-xyz]'),
    ).toEqual({ generation: 1, intentId: 'intent-xyz' });
  });

  it('parses an opencode run-name', () => {
    expect(
      attemptMarkerFromDisplayTitle(
        'opencode #9: OpenCode [dispatch:g2:intent-oc]',
      ),
    ).toEqual({ generation: 2, intentId: 'intent-oc' });
  });

  it('returns undefined for a title with no marker (pre-broker run)', () => {
    expect(attemptMarkerFromDisplayTitle('#42: Fix the thing')).toBeUndefined();
  });

  it('returns undefined for a manual dispatch with a blank generation/intent', () => {
    expect(
      attemptMarkerFromDisplayTitle('#42: Claude issue agent [dispatch:g:]'),
    ).toBeUndefined();
  });
});

describe('displayRunTitle', () => {
  it('strips the redundant "opencode " prefix for opencode runs', () => {
    const run = makeAgentRun({
      pipeline: 'opencode',
      displayTitle: 'opencode #11: Fix the thing',
    });
    expect(displayRunTitle(run)).toBe('#11: Fix the thing');
  });

  it('leaves claude run titles unchanged', () => {
    const run = makeAgentRun({
      pipeline: 'claude',
      displayTitle: '#42: Fix the thing',
    });
    expect(displayRunTitle(run)).toBe('#42: Fix the thing');
  });
});

describe('issueUrlForRun', () => {
  it('links to /issues/<N> using the parsed issue number', () => {
    const run = makeAgentRun({ issueNumber: 42 });
    expect(issueUrlForRun(run)).toBe(
      'https://github.com/supersprinklesracing/sprinkles/issues/42',
    );
  });

  it('returns undefined for a legacy run with no parsed issue number', () => {
    const run = makeAgentRun({ issueNumber: undefined });
    expect(issueUrlForRun(run)).toBeUndefined();
  });
});

describe('findStalledQueuedRun', () => {
  it('returns undefined when no live run is queued past the threshold', () => {
    const runs = [
      makeAgentRun({ id: 1, status: 'queued', elapsedSeconds: 100 }),
      makeAgentRun({ id: 2, status: 'running', elapsedSeconds: 10_000 }),
    ];
    expect(findStalledQueuedRun(runs)).toBeUndefined();
  });

  it('returns the longest-stalled queued run past the threshold', () => {
    const short = makeAgentRun({
      id: 1,
      status: 'queued',
      elapsedSeconds: 301,
    });
    const long = makeAgentRun({ id: 2, status: 'queued', elapsedSeconds: 900 });
    expect(findStalledQueuedRun([short, long])?.id).toBe(2);
  });

  it('ignores queued runs at or under the threshold', () => {
    const run = makeAgentRun({ id: 1, status: 'queued', elapsedSeconds: 300 });
    expect(findStalledQueuedRun([run])).toBeUndefined();
  });
});

describe('groupLiveRunsByIssue', () => {
  it('clusters runs sharing the same repo and issue number into one group', () => {
    const first = makeAgentRun({ id: 1, issueNumber: 42 });
    const second = makeAgentRun({ id: 2, issueNumber: 42, pipeline: 'codex' });
    const groups = groupLiveRunsByIssue([first, second]);
    expect(groups).toHaveLength(1);
    expect(groups[0].issueNumber).toBe(42);
    expect(groups[0].runs.map((r) => r.id)).toEqual([1, 2]);
  });

  it('keeps runs on different issue numbers in separate groups', () => {
    const groups = groupLiveRunsByIssue([
      makeAgentRun({ id: 1, issueNumber: 42 }),
      makeAgentRun({ id: 2, issueNumber: 43 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.runs[0].id)).toEqual([1, 2]);
  });

  it('never merges same-numbered issues across different repos', () => {
    const groups = groupLiveRunsByIssue([
      makeAgentRun({
        id: 1,
        issueNumber: 42,
        repo: { owner: 'ownerA', name: 'repoA' },
      }),
      makeAgentRun({
        id: 2,
        issueNumber: 42,
        repo: { owner: 'ownerB', name: 'repoB' },
      }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('gives each run with no parsed issue number its own singleton group', () => {
    const groups = groupLiveRunsByIssue([
      makeAgentRun({ id: 1, issueNumber: undefined }),
      makeAgentRun({ id: 2, issueNumber: undefined }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.runs.length === 1)).toBe(true);
  });
});

describe('collapseLogicalLiveRuns', () => {
  it('represents queued and running attempts for one agent item as one run', () => {
    const queued = makeAgentRun({
      id: 1,
      status: 'queued',
      createdAt: '2026-07-07T00:01:00Z',
    });
    const running = makeAgentRun({
      id: 2,
      status: 'running',
      createdAt: '2026-07-07T00:00:00Z',
    });

    expect(
      collapseLogicalLiveRuns([queued, running]).map((run) => run.id),
    ).toEqual([2]);
  });

  it('keeps different pipelines on the same issue visible', () => {
    const runs = collapseLogicalLiveRuns([
      makeAgentRun({ id: 1, status: 'running', pipeline: 'claude' }),
      makeAgentRun({ id: 2, status: 'queued', pipeline: 'codex' }),
    ]);

    expect(runs.map((run) => run.id)).toEqual([1, 2]);
  });

  it('never collapses unparsed or cross-repository runs', () => {
    const runs = collapseLogicalLiveRuns([
      makeAgentRun({ id: 1, issueNumber: undefined }),
      makeAgentRun({ id: 2, issueNumber: undefined }),
      makeAgentRun({ id: 3 }),
      makeAgentRun({
        id: 4,
        repo: { owner: 'elsewhere', name: 'sprinkles' },
      }),
    ]);

    expect(runs.map((run) => run.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('getAgentActivity', () => {
  function setupOctokit({
    listWorkflowRuns,
    listSelfHostedRunnersForRepo,
  }: {
    listWorkflowRuns: Mock;
    listSelfHostedRunnersForRepo: Mock;
  }) {
    (getGithubClient as Mock).mockReturnValue({
      rest: {
        actions: {
          listWorkflowRuns,
          listSelfHostedRunnersForRepo,
        },
      },
    });
  }

  it('parses issueNumber onto live runs from the run-name display title', async () => {
    const listWorkflowRuns = vi
      .fn()
      .mockImplementation(({ workflow_id, status }) => {
        if (workflow_id === 'claude.yml' && status === undefined) {
          return Promise.resolve({
            data: {
              workflow_runs: [makeRun({ id: 1, status: 'in_progress' })],
            },
          });
        }
        return Promise.resolve({ data: { workflow_runs: [] } });
      });
    const listSelfHostedRunnersForRepo = vi
      .fn()
      .mockResolvedValue({ data: { runners: [] } });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.warnings).toEqual([]);
    expect(activity.liveRuns).toHaveLength(1);
    expect(activity.liveRuns[0].issueNumber).toBe(42);
    expect(activity.liveRuns[0].pipeline).toBe('claude');
  });

  it('preserves every duplicate attempt of the same agent item instead of collapsing to one representative (#306)', async () => {
    const listWorkflowRuns = vi
      .fn()
      .mockImplementation(({ workflow_id, status }) => {
        if (workflow_id === 'claude.yml' && status === undefined) {
          return Promise.resolve({
            data: {
              workflow_runs: [
                makeRun({ id: 1, status: 'pending' }),
                makeRun({ id: 2, status: 'in_progress' }),
              ],
            },
          });
        }
        return Promise.resolve({ data: { workflow_runs: [] } });
      });
    const listSelfHostedRunnersForRepo = vi
      .fn()
      .mockResolvedValue({ data: { runners: [] } });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    // Both the queued and the running attempt survive into `liveRuns` -
    // #306 removed the representative-attempt collapse that used to leave
    // only the running one visible here. `liveRunAttempts` is no longer a
    // separate "raw" copy revealing evidence `liveRuns` hid; the two are
    // now the same evidence (see AgentActivity's own doc comments).
    expect(activity.liveRuns.map((run) => run.id)).toEqual([1, 2]);
    expect(activity.liveRunAttempts?.map((run) => run.id)).toEqual([1, 2]);
  });

  it('falls back to undefined issueNumber for a legacy title', async () => {
    const listWorkflowRuns = vi
      .fn()
      .mockImplementation(({ workflow_id, status }) => {
        if (workflow_id === 'claude.yml' && status === undefined) {
          return Promise.resolve({
            data: {
              workflow_runs: [
                makeRun({ id: 2, display_title: 'Fix the thing' }),
              ],
            },
          });
        }
        return Promise.resolve({ data: { workflow_runs: [] } });
      });
    const listSelfHostedRunnersForRepo = vi
      .fn()
      .mockResolvedValue({ data: { runners: [] } });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.liveRuns[0].issueNumber).toBeUndefined();
    expect(activity.liveRuns[0].displayTitle).toBe('Fix the thing');
  });

  it('keeps a valid pending follow-up even before its job is materialized', async () => {
    const listWorkflowRuns = vi
      .fn()
      .mockImplementation(({ workflow_id, status }) => {
        if (workflow_id === 'claude.yml' && status === undefined) {
          return Promise.resolve({
            data: {
              workflow_runs: [
                makeRun({
                  id: 3,
                  status: 'pending',
                  display_title: '#44: follow-up',
                }),
              ],
            },
          });
        }
        return Promise.resolve({ data: { workflow_runs: [] } });
      });
    const listSelfHostedRunnersForRepo = vi
      .fn()
      .mockResolvedValue({ data: { runners: [] } });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.liveRuns.map((run) => run.id)).toEqual([3]);
    expect(activity.liveRuns[0].status).toBe('queued');
  });

  it('fetches live runs from both pipelines in parallel and tags each with its source workflow', async () => {
    const listWorkflowRuns = vi
      .fn()
      .mockImplementation(({ workflow_id, status }) => {
        if (status !== undefined) {
          return Promise.resolve({ data: { workflow_runs: [] } });
        }
        if (workflow_id === 'claude.yml') {
          return Promise.resolve({
            data: {
              workflow_runs: [
                makeRun({ id: 1, display_title: '#10: Claude run' }),
              ],
            },
          });
        }
        if (workflow_id === 'opencode.yml') {
          return Promise.resolve({
            data: {
              workflow_runs: [
                makeRun({ id: 2, display_title: 'opencode #11: OpenCode run' }),
              ],
            },
          });
        }
        return Promise.resolve({ data: { workflow_runs: [] } });
      });
    const listSelfHostedRunnersForRepo = vi
      .fn()
      .mockResolvedValue({ data: { runners: [] } });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.liveRuns).toHaveLength(2);
    const claudeRun = activity.liveRuns.find((run) => run.id === 1);
    const opencodeRun = activity.liveRuns.find((run) => run.id === 2);
    expect(claudeRun?.pipeline).toBe('claude');
    expect(opencodeRun?.pipeline).toBe('opencode');
    expect(opencodeRun?.issueNumber).toBe(11);
  });

  it('merges recent runs across both pipelines, sorted by updatedAt desc, capped at 8 overall', async () => {
    const listWorkflowRuns = vi
      .fn()
      .mockImplementation(({ workflow_id, status }) => {
        if (status === undefined) {
          return Promise.resolve({ data: { workflow_runs: [] } });
        }
        // Only the 'success' conclusion query returns fixtures - keeps this
        // fixture small while still exercising the per-conclusion + per-
        // pipeline fan-out and the final merge/sort/cap.
        if (status !== 'success') {
          return Promise.resolve({ data: { workflow_runs: [] } });
        }
        if (workflow_id === 'claude.yml') {
          return Promise.resolve({
            data: {
              workflow_runs: [1, 2, 3, 4, 5].map((day) =>
                makeRun({
                  id: day,
                  status: 'completed',
                  conclusion: 'success',
                  display_title: `#${day}: claude run ${day}`,
                  updated_at: `2026-07-0${day}T00:00:00Z`,
                }),
              ),
            },
          });
        }
        if (workflow_id === 'opencode.yml') {
          return Promise.resolve({
            data: {
              workflow_runs: [3, 4, 5, 6, 7].map((day) =>
                makeRun({
                  id: 100 + day,
                  status: 'completed',
                  conclusion: 'success',
                  display_title: `opencode #${100 + day}: opencode run ${day}`,
                  updated_at: `2026-07-0${day}T12:00:00Z`,
                }),
              ),
            },
          });
        }
        return Promise.resolve({ data: { workflow_runs: [] } });
      });
    const listSelfHostedRunnersForRepo = vi
      .fn()
      .mockResolvedValue({ data: { runners: [] } });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.recentRuns).toHaveLength(8);
    // Strictly descending by updatedAt - the merge point where both
    // pipelines' fixtures interleave.
    const updatedAts = activity.recentRuns.map((run) => run.updatedAt);
    expect(updatedAts).toEqual(
      [...updatedAts].sort((a, b) => b.localeCompare(a)),
    );
    // Most recent is the opencode run - proves the two pipelines' results
    // were actually merged rather than one clobbering the other.
    expect(activity.recentRuns[0].pipeline).toBe('opencode');
    expect(activity.recentRuns.some((run) => run.pipeline === 'claude')).toBe(
      true,
    );
    // The two oldest claude fixtures (07-01, 07-02) fell outside the cap.
    expect(activity.recentRuns.some((run) => run.id === 1)).toBe(false);
    expect(activity.recentRuns.some((run) => run.id === 2)).toBe(false);
  });

  it('reduces self-hosted runners into an aggregate fleet summary without label filtering', async () => {
    const listWorkflowRuns = vi
      .fn()
      .mockResolvedValue({ data: { workflow_runs: [] } });
    const listSelfHostedRunnersForRepo = vi.fn().mockResolvedValue({
      data: {
        runners: [
          { id: 1, name: 'runner-a', status: 'online', busy: true, labels: [] },
          {
            id: 2,
            name: 'runner-b',
            status: 'online',
            busy: false,
            labels: [],
          },
          {
            id: 3,
            name: 'runner-c',
            status: 'offline',
            busy: false,
            labels: [],
          },
        ],
      },
    });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.fleet).toEqual({ online: 2, busy: 1 });
  });

  // Two watched repos sharing an org-level runner group both list the same
  // runner (by id) - counting it once per repo would inflate the fleet
  // gauge without a real capacity change.
  it('dedupes a runner shared across two watched repos by runner id', async () => {
    const repoA = { owner: 'org-a', name: 'repo-a' };
    const repoB = { owner: 'org-b', name: 'repo-b' };
    (getWatchedRepos as Mock).mockReturnValueOnce([repoA, repoB]);

    const listWorkflowRuns = vi
      .fn()
      .mockResolvedValue({ data: { workflow_runs: [] } });
    const listSelfHostedRunnersForRepo = vi.fn().mockImplementation(() =>
      Promise.resolve({
        data: {
          runners: [
            {
              id: 1,
              name: 'shared-runner',
              status: 'online',
              busy: true,
              labels: [],
            },
          ],
        },
      }),
    );
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(listSelfHostedRunnersForRepo).toHaveBeenCalledTimes(2);
    expect(activity.fleet).toEqual({ online: 1, busy: 1 });
    // Per-repo breakdown is NOT deduped - each repo's own API view still
    // reports the shared runner, since that's what that repo's endpoint
    // actually returned.
    expect(activity.fleetByRepo).toEqual({
      'org-a/repo-a': { online: 1, busy: 1 },
      'org-b/repo-b': { online: 1, busy: 1 },
    });
  });

  it('omits fleetByRepo entirely when only one repo is watched', async () => {
    const listWorkflowRuns = vi
      .fn()
      .mockResolvedValue({ data: { workflow_runs: [] } });
    const listSelfHostedRunnersForRepo = vi.fn().mockResolvedValue({
      data: { runners: [{ id: 1, status: 'online', busy: false, labels: [] }] },
    });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.fleet).toEqual({ online: 1, busy: 0 });
    expect(activity.fleetByRepo).toBeUndefined();
  });

  it('degrades the fleet section and records a warning instead of throwing', async () => {
    const listWorkflowRuns = vi
      .fn()
      .mockResolvedValue({ data: { workflow_runs: [] } });
    const listSelfHostedRunnersForRepo = vi
      .fn()
      .mockRejectedValue(new Error('403 admin:read required'));
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.fleet).toBeUndefined();
    expect(activity.liveRuns).toEqual([]);
    expect(
      activity.warnings.some((w) => w.includes('Runner fleet status')),
    ).toBe(true);
  });
});
