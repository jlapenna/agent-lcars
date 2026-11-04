// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deliverLinearOutcome } from './linear-outcome';
import type { OutcomeWebhookPayload } from './outcome-webhook';

const org = '11111111-1111-4111-8111-111111111111';
const issueId = '44444444-4444-4444-8444-444444444444';
const payload: OutcomeWebhookPayload = {
  itemId: '01J5Z3K9QX8F0N2B4V6C8D1E4H',
  runId: 'run-1',
  state: 'finished',
  ok: true,
  parked: true,
  message: 'Which database should I use?',
  thread: JSON.stringify({ organizationId: org, issueId }),
  consoleUrl: 'https://lcars.example/work/item',
};
afterEach(() => vi.unstubAllEnvs());
function api() {
  vi.stubEnv('AGENT_LCARS_LINEAR_API_KEY', 'test-api-key');
  const comments = new Map<string, string>();
  const archived = new Set<string>();
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(init?.body as string) as {
      variables: {
        id?: string;
        includeArchived?: boolean;
        input?: { id: string; body: string; issueId: string };
      };
    };
    const input = request.variables.input;
    if (input) {
      comments.set(input.id, input.body);
      return Response.json({
        data: {
          commentCreate: {
            success: true,
            comment: { id: input.id, issue: { id: input.issueId } },
          },
        },
      });
    }
    return Response.json({
      data: {
        organization: { id: org },
        comments: {
          nodes:
            comments.has(request.variables.id!) &&
            (!archived.has(request.variables.id!) ||
              request.variables.includeArchived)
              ? [{ id: request.variables.id, issue: { id: issueId } }]
              : [],
        },
      },
    });
  });
  return { fetchImpl, comments, archived };
}
describe('Linear outcome delivery', () => {
  it('posts the outcome once and rediscovers it on outbox retry', async () => {
    const { fetchImpl, comments } = api();
    await deliverLinearOutcome(payload, fetchImpl);
    await deliverLinearOutcome(payload, fetchImpl);
    expect(comments.size).toBe(1);
    expect([...comments.values()][0]).toContain('Needs input');
    expect([...comments.values()][0]).toContain(payload.consoleUrl);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.linear.app/graphql');
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'test-api-key',
    });
  });
  it('deduplicates a write whose successful response was lost', async () => {
    const { fetchImpl, comments } = api();
    const lostResponse: typeof fetch = async (url, init) => {
      const response = await fetchImpl(url, init);
      if (comments.size > 0) throw new Error('connection reset');
      return response;
    };
    await expect(deliverLinearOutcome(payload, lostResponse)).rejects.toThrow(
      'connection reset',
    );
    await deliverLinearOutcome(payload, fetchImpl);
    expect(comments.size).toBe(1);
  });
  it('rediscovers an archived comment rather than recreating its UUID', async () => {
    const { fetchImpl, comments, archived } = api();
    await deliverLinearOutcome(payload, fetchImpl);
    for (const id of comments.keys()) archived.add(id);
    await deliverLinearOutcome(payload, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(comments.size).toBe(1);
  });
  it('posts protected delivery separately from execution settlement', async () => {
    const { fetchImpl, comments } = api();
    await deliverLinearOutcome(
      {
        ...payload,
        parked: false,
        ref: 'https://github.com/owner/repo/pull/1',
      },
      fetchImpl,
    );
    await deliverLinearOutcome(
      {
        ...payload,
        parked: false,
        eventId: 'delivery-outcome/run-1',
        deliveryStage: 'complete',
      },
      fetchImpl,
    );
    expect(comments.size).toBe(2);
    expect([...comments.values()][0]).toContain('Execution finished');
    expect([...comments.values()][0]).toContain(
      'https://github.com/owner/repo/pull/1',
    );
    expect([...comments.values()][1]).toContain('Delivery complete');
  });
  it.each([429, 500])('keeps HTTP %s retryable', async (status) => {
    vi.stubEnv('AGENT_LCARS_LINEAR_API_KEY', 'test-api-key');
    await expect(
      deliverLinearOutcome(
        payload,
        vi.fn().mockResolvedValue(new Response('', { status })),
      ),
    ).rejects.toThrow(String(status));
  });
  it('rejects GraphQL errors, unsuccessful writes and credentials for a different organization', async () => {
    const { fetchImpl } = api();
    fetchImpl.mockResolvedValueOnce(
      Response.json({ errors: [{ message: 'permission denied' }] }),
    );
    await expect(deliverLinearOutcome(payload, fetchImpl)).rejects.toThrow(
      'GraphQL',
    );
    await expect(
      deliverLinearOutcome(
        {
          ...payload,
          thread: JSON.stringify({ organizationId: issueId, issueId }),
        },
        fetchImpl,
      ),
    ).rejects.toThrow('different organization');
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        data: { organization: { id: org }, comments: { nodes: [] } },
      }),
    );
    fetchImpl.mockResolvedValueOnce(
      Response.json({
        data: { commentCreate: { success: false, comment: null } },
      }),
    );
    await expect(deliverLinearOutcome(payload, fetchImpl)).rejects.toThrow(
      'not confirmed',
    );
  });
  it('keeps missing credentials retryable instead of dropping stored Linear outcomes', async () => {
    vi.stubEnv('AGENT_LCARS_LINEAR_API_KEY', '');
    await expect(deliverLinearOutcome(payload, vi.fn())).rejects.toThrow(
      'AGENT_LCARS_LINEAR_API_KEY',
    );
  });
});
