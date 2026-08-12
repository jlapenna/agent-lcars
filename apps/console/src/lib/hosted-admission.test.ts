import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listEventsForTimeline, paginate, processHostedControllerEvent } =
  vi.hoisted(() => ({
    listEventsForTimeline: vi.fn(),
    paginate: vi.fn(),
    processHostedControllerEvent: vi.fn(),
  }));

vi.mock('./hosted-controller', () => ({ processHostedControllerEvent }));

vi.mock('./github-client', () => ({
  getGithubClient: () => ({
    paginate,
    rest: { issues: { listEventsForTimeline } },
  }),
}));

import { AuthorityStateMissingError } from '@agent-lcars/dispatch-controller/storage/authority';

import {
  admitGitHubWebhook,
  deliveryTransportId,
  loadTimeline,
  parseHostedAdmissionMode,
  PermanentAdmissionError,
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

function authorityGap() {
  return new AuthorityStateMissingError({
    repository,
    repositoryId,
    issue: issueNumber,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
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

  it('propagates an authority gap unconditionally; there is no compatibility quarantine', async () => {
    const gap = authorityGap();
    processHostedControllerEvent.mockRejectedValueOnce(gap);

    await expect(
      admitGitHubWebhook({
        deliveryId,
        eventName: 'issues',
        payload: statusLabelPayload(),
        mode: 'authority',
      }),
    ).rejects.toBe(gap);
  });

  // #955: an ambiguous timeline (here, two same-label-same-actor entries
  // both inside the correlation window) used to throw out of normalizeEvent
  // and surface as a 500 -- a Cloud Tasks poison pill, since every retry
  // resubmits the identical webhook and the ambiguity never resolves.
  // Threading this route's own `deliveryId` through to normalizeEvent's
  // fallback keeps admission succeeding instead, with a sourceId derived
  // from the delivery itself.
  it('admits an ambiguous-timeline delivery using a delivery-derived sourceId instead of throwing (#955)', async () => {
    paginate.mockResolvedValue([
      {
        id: 42,
        event: 'labeled',
        label: { name: 'status:needs-human' },
        actor: { login: 'github-actions[bot]' },
        created_at: eventTime,
      },
      {
        id: 43,
        event: 'labeled',
        label: { name: 'status:needs-human' },
        actor: { login: 'github-actions[bot]' },
        created_at: eventTime,
      },
    ]);

    const result = await admitGitHubWebhook({
      deliveryId,
      eventName: 'issues',
      payload: statusLabelPayload(),
      mode: 'authority',
    });

    expect(result.outcome).toBe('processed');
    expect(processHostedControllerEvent).toHaveBeenCalledTimes(1);
    const { normalized } = processHostedControllerEvent.mock.calls[0][0];
    expect(normalized.kind).toBe('control-evidence');
    expect(normalized.evidence.sourceId).toBe(`github-delivery:${deliveryId}`);
  });
});

describe('permanent vs. transient admission failure classification', () => {
  it('wraps a normalizeEvent() failure as PermanentAdmissionError (deterministic given the payload -- e.g. a malformed pull request anchor)', async () => {
    // normalizeEvent() is a pure function of its arguments (no I/O), so any
    // exception it raises is deterministic given this exact payload -- every
    // retry of the same delivery would fail identically. `pull_request`
    // closed/reopened with a falsy id is one such rule (unrelated to the
    // #955 ambiguous-timeline fallback, which no longer throws at all).
    const rejection = admitGitHubWebhook({
      deliveryId,
      eventName: 'pull_request',
      payload: {
        action: 'closed',
        repository: { id: repositoryId, full_name: repository },
        sender: { login: 'github-actions[bot]' },
        pull_request: {
          id: 0,
          number: issueNumber,
          title: 'Malformed PR anchor',
          body: '',
          created_at: eventTime,
          updated_at: eventTime,
        },
      },
      mode: 'authority',
    });
    await expect(rejection).rejects.toBeInstanceOf(PermanentAdmissionError);
    await expect(rejection).rejects.toThrow(/Malformed pull request anchor/);
    expect(processHostedControllerEvent).not.toHaveBeenCalled();
  });

  it('rejects an unsupported event name as permanent', async () => {
    await expect(
      admitGitHubWebhook({
        deliveryId,
        eventName: 'release',
        payload: statusLabelPayload(),
        mode: 'authority',
      }),
    ).rejects.toBeInstanceOf(PermanentAdmissionError);
  });

  it('rejects a webhook outside the control-plane boundary as permanent', async () => {
    await expect(
      admitGitHubWebhook({
        deliveryId,
        eventName: 'issues',
        payload: {
          ...statusLabelPayload(),
          repository: {
            id: repositoryId,
            full_name: 'someone-else/other-repo',
          },
        },
        mode: 'authority',
      }),
    ).rejects.toBeInstanceOf(PermanentAdmissionError);
  });

  it('rejects a timeline lookup missing an issue number as permanent', async () => {
    await expect(
      loadTimeline('issues', {
        action: 'labeled',
        repository: { full_name: 'jlapenna/agent-lcars' },
      }),
    ).rejects.toBeInstanceOf(PermanentAdmissionError);
    expect(paginate).not.toHaveBeenCalled();
  });

  it('leaves a GitHub API failure during timeline lookup transient (not wrapped)', async () => {
    const outage = new Error('GitHub API is unavailable');
    paginate.mockRejectedValueOnce(outage);

    await expect(
      loadTimeline('issues', {
        action: 'labeled',
        repository: { full_name: 'jlapenna/agent-lcars' },
        issue: {
          id: 736,
          number: 736,
          title: 'Hosted broker',
          created_at: eventTime,
          updated_at: eventTime,
        },
      }),
    ).rejects.toBe(outage);
  });
});
