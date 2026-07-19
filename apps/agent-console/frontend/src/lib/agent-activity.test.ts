import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  type AgentRun,
  displayRunTitle,
  findStalledQueuedRun,
  getAgentActivity,
  issueNumberFromDisplayTitle,
} from './agent-activity';
import { getGithubClient } from './github-client';

vi.mock('./github-client', () => ({
  getGithubClient: vi.fn(),
  REPO_OWNER: 'supersprinklesracing',
  REPO_NAME: 'members',
}));

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
    html_url: 'https://github.com/supersprinklesracing/members/actions/runs/1',
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
    pipeline: 'claude',
    status: 'completed',
    conclusion: 'success',
    event: 'issues',
    url: 'https://github.com/supersprinklesracing/members/actions/runs/1',
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
          { name: 'runner-a', status: 'online', busy: true, labels: [] },
          { name: 'runner-b', status: 'online', busy: false, labels: [] },
          { name: 'runner-c', status: 'offline', busy: false, labels: [] },
        ],
      },
    });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.fleet).toEqual({ online: 2, busy: 1 });
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
