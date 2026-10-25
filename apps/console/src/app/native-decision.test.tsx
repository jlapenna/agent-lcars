import { MantineProvider } from '@mantine/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  inboxCardMetadata,
  inboxCardSignature,
  type NativeDecisionCard,
} from './inbox-card';
import { NativeDecisionDetail, NativeDecisionRow } from './native-decision';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const card: NativeDecisionCard = {
  kind: 'decision',
  queued: true,
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
  it('shows the decision brief while preserving the full handoff and reply', () => {
    render(
      <MantineProvider>
        <NativeDecisionDetail
          card={{
            ...card,
            decisionSummary: (
              <span>Choose a storage backend before the agent continues.</span>
            ),
          }}
          replyToWorkItem={vi.fn()}
        />
      </MantineProvider>,
    );
    expect(screen.getByLabelText('Inbox summary')).toHaveTextContent(
      'Choose a storage backend',
    );
    expect(screen.getByText('Which storage should I use?')).toBeTruthy();
    expect(
      screen.getByRole('textbox', { name: 'Reply to the agent' }),
    ).toBeTruthy();
  });

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
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Reply admitted');
        expect(screen.queryByRole('textbox')).toBeNull();
      });
    },
  );

  it('retains the in-flight draft when work starts until reply admission settles', async () => {
    let admit!: (result: [null, { resumed: boolean }]) => void;
    const admission = new Promise<[null, { resumed: boolean }]>((resolve) => {
      admit = resolve;
    });
    const reply = vi.fn().mockReturnValue(admission);
    const { rerender } = render(
      <MantineProvider>
        <NativeDecisionDetail card={card} replyToWorkItem={reply} />
      </MantineProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Use Firestore.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply', exact: true }));
    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith({
        id: card.work.anchor.workId,
        text: 'Use Firestore.',
      }),
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
    expect(screen.getByRole('textbox')).toHaveValue('Use Firestore.');
    expect(
      screen.getByRole('button', { name: 'Reply', exact: true }),
    ).toBeDisabled();
    await act(async () => {
      admit([null, { resumed: false }]);
      await admission;
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        /Reply admitted.*fresh session/,
      );
      expect(screen.queryByRole('textbox')).toBeNull();
    });
  });

  it('keeps a refused reply editable with distinct summary and reply statuses', async () => {
    const reply = vi
      .fn()
      .mockResolvedValue([
        { code: 'CONFLICT', message: 'run-live' },
        undefined,
      ]);
    render(
      <MantineProvider>
        <NativeDecisionDetail
          card={{
            ...card,
            decisionSummary: (
              <span role="status" aria-label="Decision summary">
                Summary unavailable.
              </span>
            ),
          }}
          replyToWorkItem={reply}
        />
      </MantineProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Use Firestore.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply', exact: true }));
    await waitFor(() =>
      expect(
        screen.getByRole('status', { name: 'Reply status' }),
      ).toHaveTextContent('run-live'),
    );
    expect(
      screen.getByRole('status', { name: 'Decision summary' }),
    ).toHaveTextContent('Summary unavailable.');
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

it('discloses historical actions beside the complete handoff, and hides them after resume', () => {
  const actions = [
    { text: 'Inspect the deployment.', command: 'check --production' },
    { text: 'Send the output back to resume.' },
  ];
  const summarized: NativeDecisionCard = {
    ...card,
    work: {
      ...card.work,
      runs: [
        {
          ...card.work.runs[0],
          result: { ...card.work.runs[0].result!, humanNeededActions: actions },
        },
      ],
    },
  };
  const { rerender } = render(
    <MantineProvider>
      <NativeDecisionDetail card={summarized} />
    </MantineProvider>,
  );
  expect(screen.getByText('check --production')).not.toBeVisible();
  fireEvent.click(screen.getByText('Earlier handoff · AI summary'));
  const summary = screen.getByRole('region', { name: 'Human work summary' });
  expect(within(summary).getAllByRole('listitem')).toHaveLength(2);
  expect(within(summary).getByText('check --production')).toBeVisible();
  expect(screen.getByText('Which storage should I use?')).toBeVisible();
  rerender(
    <MantineProvider>
      <NativeDecisionDetail
        card={{ ...summarized, work: { ...summarized.work, state: 'running' } }}
      />
    </MantineProvider>,
  );
  expect(
    screen.queryByRole('region', { name: 'Human work summary' }),
  ).toBeNull();
});

const report: NativeDecisionCard = {
  ...card,
  kind: 'report',
  work: {
    ...card.work,
    state: 'done',
    runs: [
      {
        ...card.work.runs[0],
        result: {
          ok: true,
          summary: 'report',
          message: '# Findings\n\nAll clear.',
        },
      },
    ],
  },
};

describe('native report card', () => {
  it('binds its snooze to the report run, not later item bookkeeping', () => {
    const before = inboxCardSignature(report);
    expect(
      inboxCardSignature({
        ...report,
        work: { ...report.work, updatedAt: '2026-10-10T00:00:00Z' },
      }),
    ).toBe(before);
    expect(
      inboxCardSignature({
        ...report,
        work: {
          ...report.work,
          runs: [...report.work.runs, { ...report.work.runs[0], runId: 'r2' }],
        },
      }),
    ).not.toBe(before);
    expect(before).not.toBe(inboxCardSignature(card));
  });

  it('dates a report by its run, not by a later edit of the item', () => {
    const edited = {
      ...report,
      work: { ...report.work, updatedAt: '2026-10-12T00:00:00Z' },
    };
    const settled = report.work.runs[0].updatedAt;
    expect(inboxCardMetadata(edited)).toMatchObject({
      updatedAt: settled,
      waitingSince: settled,
    });
    expect(inboxCardMetadata({ ...card, work: edited.work }).updatedAt).toBe(
      '2026-10-12T00:00:00Z',
    );
  });

  it('files under Report ready, ranked below decisions, searchable by its text', () => {
    const meta = inboxCardMetadata(report);
    expect(meta.actionTypes).toEqual(['report-ready']);
    expect(meta.rank).toBeGreaterThan(inboxCardMetadata(card).rank);
    expect(meta.search).toContain('All clear.');
  });

  it('reads as a report to dismiss, never as a human decision', () => {
    const onSnooze = vi.fn();
    render(
      <MantineProvider>
        <NativeDecisionRow
          card={report}
          href="/inbox?item=x"
          selected={false}
          onNavigate={vi.fn()}
          onSnooze={onSnooze}
        />
      </MantineProvider>,
    );
    expect(screen.getByText('Report ready')).toBeTruthy();
    expect(screen.queryByText('Human needed')).toBeNull();
    expect(screen.getByText(/All clear\./u)).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss Choose storage' }),
    );
    expect(onSnooze).toHaveBeenCalledTimes(1);
  });

  it('offers a follow-up on the report in the detail pane', () => {
    render(
      <MantineProvider>
        <NativeDecisionDetail card={report} replyToWorkItem={vi.fn()} />
      </MantineProvider>,
    );
    expect(screen.getByText(/Report ready/u)).toBeTruthy();
    expect(screen.getByLabelText('Ask a follow-up')).toBeTruthy();
    expect(screen.queryByText(/Agent parked without a question/u)).toBeNull();
  });
});
