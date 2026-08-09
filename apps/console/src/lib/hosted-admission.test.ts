import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getIssue,
  listEventsForTimeline,
  paginate,
  processHostedControllerEvent,
} = vi.hoisted(() => ({
  getIssue: vi.fn(),
  listEventsForTimeline: vi.fn(),
  paginate: vi.fn(),
  processHostedControllerEvent: vi.fn(),
}));

vi.mock('./hosted-controller', () => ({ processHostedControllerEvent }));

vi.mock('./github-client', () => ({
  getGithubClient: () => ({
    paginate,
    rest: { issues: { get: getIssue, listEventsForTimeline } },
  }),
}));

import { AuthorityStateMissingError } from '@agent-lcars/dispatch-controller/storage/authority';

import {
  admitGitHubWebhook,
  deliveryTransportId,
  loadTimeline,
  parseHostedAdmissionMode,
} from './hosted-admission';

const repository = 'jlapenna/agent-lcars';
const repositoryId = 1_307_149_765;
const issueNumber = 20;
const eventTime = '2026-08-08T12:00:00.000Z';
const deliveryId = '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820';

function statusLabelPayload() {
  return {
    action: 'labeled',
    label: { name: 'status:needs-human' },
    repository: { id: repositoryId, full_name: repository },
    sender: { login: 'github-actions[bot]' },
    issue: {
      id: 2_000,
      number: issueNumber,
      title: 'Retired task',
      body: '',
      state: 'closed',
      labels: [{ name: 'status:needs-human' }],
      created_at: '2026-08-07T00:00:00.000Z',
      updated_at: eventTime,
    },
  };
}

function authorityGap(compatibilityQuiescent: boolean) {
  return new AuthorityStateMissingError(
    { repository, repositoryId, issue: issueNumber },
    compatibilityQuiescent,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DISPATCH_AUTHORITY_EPOCH', '2026-08-08T00:00:00.000Z');
  processHostedControllerEvent.mockResolvedValue(undefined);
  paginate.mockResolvedValue([
    {
      id: 42,
      event: 'labeled',
      label: { name: 'status:needs-human' },
      actor: { login: 'github-actions[bot]' },
      created_at: eventTime,
    },
  ]);
  getIssue.mockResolvedValue({ data: statusLabelPayload().issue });
});

describe('hosted webhook admission primitives', () => {
  it('requires authority mode after the storage cutover', () => {
    expect(parseHostedAdmissionMode('authority')).toBe('authority');
    expect(() => parseHostedAdmissionMode(undefined)).toThrow(
      'unset configuration were retired',
    );
    expect(() => parseHostedAdmissionMode('off')).toThrow('were retired');
    expect(() => parseHostedAdmissionMode(' shadow ')).toThrow('were retired');
    expect(() => parseHostedAdmissionMode('enabled')).toThrow(
      "must be 'authority'",
    );
  });

  it('maps a delivery UUID deterministically into a positive safe integer', () => {
    const delivery = '4ed2d2a6-7530-11f0-9f9d-8f1bc3e88820';
    const first = deliveryTransportId(delivery);
    expect(deliveryTransportId(delivery)).toBe(first);
    expect(first).toBeGreaterThan(0);
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(deliveryTransportId(`${delivery}-other`)).not.toBe(first);
  });

  it('paginates the complete issue timeline before normalization', async () => {
    const timeline = Array.from({ length: 150 }, (_, id) => ({
      id,
      event: 'labeled',
      created_at: '2026-08-08T00:00:00.000Z',
    }));
    paginate.mockResolvedValue(timeline);

    await expect(
      loadTimeline('issues', {
        action: 'labeled',
        repository: { full_name: 'jlapenna/agent-lcars' },
        issue: {
          id: 736,
          number: 736,
          title: 'Hosted broker',
          created_at: '2026-08-08T00:00:00.000Z',
          updated_at: '2026-08-08T00:00:00.000Z',
        },
      }),
    ).resolves.toEqual(timeline);
    expect(paginate).toHaveBeenCalledWith(listEventsForTimeline, {
      owner: 'jlapenna',
      repo: 'agent-lcars',
      issue_number: 736,
      per_page: 100,
    });
  });

  it.each([true, false])(
    'acknowledges a retired replay after checking live GitHub state (compatibilityQuiescent=%s)',
    async (compatibilityQuiescent) => {
      processHostedControllerEvent.mockRejectedValueOnce(
        authorityGap(compatibilityQuiescent),
      );

      await expect(
        admitGitHubWebhook({
          deliveryId,
          eventName: 'issues',
          payload: statusLabelPayload(),
          mode: 'authority',
        }),
      ).resolves.toMatchObject({
        outcome: 'ignored',
        reason: 'retired pre-cutover task quarantined',
      });
      expect(getIssue).toHaveBeenCalledWith({
        owner: 'jlapenna',
        repo: 'agent-lcars',
        issue_number: issueNumber,
      });
    },
  );

  it.each([
    {
      name: 'the issue is still open',
      compatibilityQuiescent: true,
      liveIssue: { ...statusLabelPayload().issue, state: 'open' },
    },
    {
      name: 'live dispatch intent remains',
      compatibilityQuiescent: true,
      liveIssue: {
        ...statusLabelPayload().issue,
        labels: [{ name: 'agent:codex' }],
      },
    },
    {
      name: 'the issue was created after cutover',
      compatibilityQuiescent: true,
      liveIssue: {
        ...statusLabelPayload().issue,
        created_at: '2026-08-09T00:00:00.000Z',
      },
    },
  ])('keeps failing closed when $name', async (scenario) => {
    const gap = authorityGap(scenario.compatibilityQuiescent);
    processHostedControllerEvent.mockRejectedValueOnce(gap);
    getIssue.mockResolvedValueOnce({ data: scenario.liveIssue });

    await expect(
      admitGitHubWebhook({
        deliveryId,
        eventName: 'issues',
        payload: statusLabelPayload(),
        mode: 'authority',
      }),
    ).rejects.toBe(gap);
  });
});
