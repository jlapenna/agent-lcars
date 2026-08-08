import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listEventsForTimeline, paginate } = vi.hoisted(() => ({
  listEventsForTimeline: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock('./github-client', () => ({
  getGithubClient: () => ({
    paginate,
    rest: { issues: { listEventsForTimeline } },
  }),
}));

import {
  deliveryTransportId,
  loadTimeline,
  parseHostedAdmissionMode,
} from './hosted-admission';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hosted webhook admission primitives', () => {
  it('accepts only the configured migration modes', () => {
    expect(parseHostedAdmissionMode(undefined)).toBe('off');
    expect(parseHostedAdmissionMode(' shadow ')).toBe('shadow');
    expect(parseHostedAdmissionMode('authority')).toBe('authority');
    expect(() => parseHostedAdmissionMode('enabled')).toThrow(
      'must be one of off, shadow, authority',
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
});
