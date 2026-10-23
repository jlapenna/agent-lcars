// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoardCard } from '../app/board-card';
import {
  inboxDecisionContext,
  summarizeInboxDecision,
} from './inbox-decision-summary';

const card: BoardCard = {
  item: {
    kind: 'pr',
    repo: { owner: 'owner', name: 'repo' },
    number: 7,
    title: 'Change retention',
    body: 'Keep audit records.',
    lastCommentBody: 'Choose 30 or 90 days before we proceed.',
    url: 'https://github.com/owner/repo/pull/7',
    updatedAt: '2026-10-23T00:00:00Z',
    actionTypes: ['needs-human'],
    labels: [],
    assigneeLogins: [],
  },
};
const fetchMock = vi.fn();
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) } }],
    }),
  );

beforeEach(() => {
  vi.stubEnv(
    'AGENT_LCARS_HANDOFF_SUMMARY_URL',
    'https://summary.example.test/v1/chat/completions',
  );
  vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_API_KEY', 'test-only-key');
  vi.stubEnv('AGENT_LCARS_HANDOFF_SUMMARY_MODEL', 'small-summary-model');
  vi.stubGlobal('fetch', fetchMock.mockReset());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Inbox decision descriptions', () => {
  it('summarizes the pending question with source evidence without changing the item', async () => {
    const original = structuredClone(card);
    fetchMock.mockResolvedValue(
      response({
        description:
          'Choose whether audit records should be retained for 30 or 90 days.',
      }),
    );
    expect(await summarizeInboxDecision(inboxDecisionContext(card))).toBe(
      'Choose whether audit records should be retained for 30 or 90 days.',
    );
    const [, init] = fetchMock.mock.calls[0];
    const input = JSON.parse(JSON.parse(init.body).messages[1].content);
    expect(input).toMatchObject({
      reasons: ['needs-human'],
      latestComment: card.item.lastCommentBody,
      body: card.item.body,
    });
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(card).toEqual(original);
  });

  it('invalidates the summary input for a changed comment or review state', () => {
    const before = inboxDecisionContext(card);
    expect(
      inboxDecisionContext({
        item: {
          ...card.item,
          lastCommentBody:
            'Approved 30 days. Decide whether to apply it retroactively.',
        },
      }),
    ).not.toBe(before);
    expect(
      inboxDecisionContext({
        item: {
          ...card.item,
          actionTypes: ['merge-blocked'],
          unresolvedReviewThreadCount: 2,
        },
      }),
    ).not.toBe(before);
  });

  it('bounds source text while keeping the latest question separate from the original request', () => {
    const context = JSON.parse(
      inboxDecisionContext({
        item: { ...card.item, body: 'x'.repeat(100_000) },
      }),
    );
    expect(context.body.length).toBeLessThanOrEqual(5_000);
    expect(context.latestComment).toBe(card.item.lastCommentBody);
  });

  it('retains a decision at the end of a long handoff', () => {
    const context = JSON.parse(
      inboxDecisionContext({
        item: {
          ...card.item,
          lastCommentBody:
            'Evidence: ' +
            'x'.repeat(20_000) +
            '\nDecision: choose 30 or 90 days.',
        },
      }),
    );
    expect(context.latestComment).toMatch(/^Evidence:/);
    expect(context.latestComment).toContain('Decision: choose 30 or 90 days.');
    expect(context.latestComment.length).toBeLessThanOrEqual(6_000);
  });

  it('expires queued work without sending another provider request', async () => {
    vi.useFakeTimers();
    const pending: Array<(response: Response) => void> = [];
    try {
      fetchMock.mockImplementation(
        () => new Promise<Response>((resolve) => pending.push(resolve)),
      );
      const running = Array.from({ length: 4 }, () =>
        summarizeInboxDecision(inboxDecisionContext(card)),
      );
      const queued = summarizeInboxDecision(inboxDecisionContext(card));
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await queued).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(4);
      pending.forEach((resolve) =>
        resolve(response({ description: 'Choose retention.' })),
      );
      await Promise.all(running);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { description: '' },
    { description: 'x'.repeat(601) },
    { description: 'Approve', execute: 'deploy' },
    { actions: [] },
  ])(
    'preserves the original context when model output is invalid: %j',
    async (output) => {
      fetchMock.mockResolvedValue(response(output));
      expect(
        await summarizeInboxDecision(inboxDecisionContext(card)),
      ).toBeUndefined();
      expect(card.item.lastCommentBody).toContain('30 or 90 days');
    },
  );

  it('does not call an unconfigured endpoint', async () => {
    for (const key of ['URL', 'API_KEY', 'MODEL'])
      vi.stubEnv(`AGENT_LCARS_HANDOFF_SUMMARY_${key}`, '');
    expect(
      await summarizeInboxDecision(inboxDecisionContext(card)),
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the inbox available when the provider refuses or returns oversized data', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('upstream failure', { status: 503 }),
    );
    expect(
      await summarizeInboxDecision(inboxDecisionContext(card)),
    ).toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(65_537)));
    expect(
      await summarizeInboxDecision(inboxDecisionContext(card)),
    ).toBeUndefined();
  });

  it('bounds concurrent provider calls and releases slots after failures', async () => {
    const pending: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    );
    const summaries = Array.from({ length: 5 }, () =>
      summarizeInboxDecision(inboxDecisionContext(card)),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    pending.shift()!(new Response('refused', { status: 503 }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    pending.forEach((resolve) =>
      resolve(response({ description: 'Choose 30 or 90 days.' })),
    );
    expect(await Promise.all(summaries)).toEqual([
      undefined,
      ...Array(4).fill('Choose 30 or 90 days.'),
    ]);
  });
});
