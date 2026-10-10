import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { inboxCardSignature, type NativeDecisionCard } from './inbox-card';
import { NativeDecisionDetail } from './native-decision';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const card: NativeDecisionCard = {
  canReply: true,
  work: {
    id: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G',
    anchor: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
    state: 'parked',
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:30:00Z',
    origin: { principal: 'user:maintainer', channel: 'console' },
    spec: {
      title: 'Choose storage',
      description: 'Persist the result',
      pipeline: 'claude',
      target: { repo: 'owner/repo' },
    },
    runs: [
      {
        runId: 'r1',
        state: 'finished',
        pipeline: 'claude',
        createdAt: '2026-10-09T00:00:00Z',
        updatedAt: '2026-10-09T00:30:00Z',
        result: {
          ok: true,
          summary: 'park',
          message: 'Which storage should I use?',
        },
      },
    ],
  },
};

describe('native decision Reply', () => {
  it('interrupts a snooze when a later parked question arrives', () => {
    const before = inboxCardSignature(card);
    expect(inboxCardSignature({ ...card, canReply: false })).toBe(before);
    const latest = card.work.runs[0];
    expect(
      inboxCardSignature({
        ...card,
        work: {
          ...card.work,
          runs: [...card.work.runs, { ...latest, runId: 'r2' }],
        },
      }),
    ).not.toBe(before);
    expect(
      inboxCardSignature({
        ...card,
        work: { ...card.work, updatedAt: '2026-10-09T01:00:00Z' },
      }),
    ).not.toBe(before);
  });
  it.each([true, false])(
    'reports admission honestly for resumed=%s and retains it when work starts',
    async (resumed) => {
      const reply = vi.fn().mockResolvedValue([null, { resumed }]);
      const { rerender } = render(
        <MantineProvider>
          <NativeDecisionDetail card={card} replyToWorkItem={reply} />
        </MantineProvider>,
      );
      fireEvent.change(
        screen.getByRole('textbox', { name: 'Reply to the agent' }),
        { target: { value: 'Use Firestore.' } },
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Reply', exact: true }),
      );
      await waitFor(() =>
        expect(reply).toHaveBeenCalledWith({
          id: card.work.anchor.workId,
          text: 'Use Firestore.',
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(
          resumed ? /Resume will be attempted/ : /fresh session/,
        ),
      );
      rerender(
        <MantineProvider>
          <NativeDecisionDetail
            card={{
              ...card,
              canReply: false,
              work: { ...card.work, state: 'running' },
            }}
            replyToWorkItem={reply}
          />
        </MantineProvider>,
      );
      expect(screen.getByRole('status')).toHaveTextContent('Reply admitted');
      expect(screen.queryByRole('textbox')).toBeNull();
    },
  );

  it('keeps a refused reply editable with the admission error', async () => {
    const reply = vi
      .fn()
      .mockResolvedValue([
        { code: 'CONFLICT', message: 'run-live' },
        undefined,
      ]);
    render(
      <MantineProvider>
        <NativeDecisionDetail card={card} replyToWorkItem={reply} />
      </MantineProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Use Firestore.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply', exact: true }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('run-live'),
    );
    expect(screen.getByRole('textbox')).toHaveValue('Use Firestore.');
  });

  it('withholds Reply for an ungranted principal while preserving the question and history', () => {
    render(
      <MantineProvider>
        <NativeDecisionDetail card={{ ...card, canReply: false }} />
      </MantineProvider>,
    );
    expect(screen.getByText('Which storage should I use?')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Full history' })).toHaveAttribute(
      'href',
      `/work/${card.work.anchor.workId}`,
    );
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });
});
