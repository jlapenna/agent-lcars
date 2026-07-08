import {
  getAgentActivity,
  issueNumberFromDisplayTitle,
} from './agent-activity';
import { getGithubClient } from './github-client';

jest.mock('./github-client', () => ({
  getGithubClient: jest.fn(),
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

describe('issueNumberFromDisplayTitle', () => {
  it('parses the leading run-name issue number', () => {
    expect(issueNumberFromDisplayTitle('#42: Fix the thing')).toBe(42);
  });

  it('returns undefined for a pre-rollout title with no leading number', () => {
    expect(issueNumberFromDisplayTitle('Fix the thing')).toBeUndefined();
  });
});

describe('getAgentActivity', () => {
  function setupOctokit({
    listWorkflowRuns,
    listSelfHostedRunnersForRepo,
  }: {
    listWorkflowRuns: jest.Mock;
    listSelfHostedRunnersForRepo: jest.Mock;
  }) {
    (getGithubClient as jest.Mock).mockReturnValue({
      rest: {
        actions: {
          listWorkflowRuns,
          listSelfHostedRunnersForRepo,
        },
      },
    });
  }

  it('parses issueNumber onto live runs from the run-name display title', async () => {
    const listWorkflowRuns = jest.fn().mockImplementation(({ status }) => {
      if (status === undefined) {
        return Promise.resolve({
          data: { workflow_runs: [makeRun({ id: 1, status: 'in_progress' })] },
        });
      }
      return Promise.resolve({ data: { workflow_runs: [] } });
    });
    const listSelfHostedRunnersForRepo = jest
      .fn()
      .mockResolvedValue({ data: { runners: [] } });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.warnings).toEqual([]);
    expect(activity.liveRuns).toHaveLength(1);
    expect(activity.liveRuns[0].issueNumber).toBe(42);
  });

  it('falls back to undefined issueNumber for a legacy title', async () => {
    const listWorkflowRuns = jest.fn().mockImplementation(({ status }) => {
      if (status === undefined) {
        return Promise.resolve({
          data: {
            workflow_runs: [makeRun({ id: 2, display_title: 'Fix the thing' })],
          },
        });
      }
      return Promise.resolve({ data: { workflow_runs: [] } });
    });
    const listSelfHostedRunnersForRepo = jest
      .fn()
      .mockResolvedValue({ data: { runners: [] } });
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.liveRuns[0].issueNumber).toBeUndefined();
    expect(activity.liveRuns[0].displayTitle).toBe('Fix the thing');
  });

  it('degrades the runner section and records a warning instead of throwing', async () => {
    const listWorkflowRuns = jest
      .fn()
      .mockResolvedValue({ data: { workflow_runs: [] } });
    const listSelfHostedRunnersForRepo = jest
      .fn()
      .mockRejectedValue(new Error('403 admin:read required'));
    setupOctokit({ listWorkflowRuns, listSelfHostedRunnersForRepo });

    const activity = await getAgentActivity();

    expect(activity.runners).toBeUndefined();
    expect(activity.liveRuns).toEqual([]);
    expect(
      activity.warnings.some((w) => w.includes('Runner fleet status')),
    ).toBe(true);
  });
});
