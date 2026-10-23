import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getInboxDecisionSummary } from '../lib/inbox-decision-summary';
import type { NativeDecisionCard } from './inbox-card';
import {
  InboxDecisionDescription,
  withInboxDecisionSummary,
} from './inbox-decision-summary';

vi.mock('../lib/inbox-decision-summary', () => ({
  getInboxDecisionSummary: vi.fn(),
  inboxDecisionContext: () => 'source context',
}));
afterEach(() => vi.resetAllMocks());

const card: NativeDecisionCard = {
  kind: 'decision',
  queued: true,
  canReply: true,
  work: {
    id: 'work:choice',
    anchor: { workId: 'choice' },
    state: 'parked',
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    origin: { principal: 'user:maintainer', channel: 'console' },
    spec: {
      title: 'Retention',
      description: 'Persist audit records.',
      pipeline: 'codex',
      target: { repo: 'owner/repo' },
    },
    runs: [
      {
        runId: 'run-1',
        state: 'finished',
        pipeline: 'codex',
        createdAt: '2026-10-23T00:00:00Z',
        updatedAt: '2026-10-23T00:00:00Z',
        result: { ok: true, summary: 'park', message: 'Choose 30 or 90 days.' },
      },
    ],
  },
};

describe('server-rendered Inbox summary', () => {
  it('keeps the native question visible while the summary is pending', () => {
    vi.mocked(getInboxDecisionSummary).mockReturnValue(
      new Promise(() => undefined),
    );
    const prepared = withInboxDecisionSummary(card);
    expect(
      renderToStaticMarkup(<div>{prepared.decisionSummary}</div>),
    ).toContain('Choose 30 or 90 days.');
  });

  it('keeps the source fallback visible when generation is unavailable', async () => {
    vi.mocked(getInboxDecisionSummary).mockResolvedValue(undefined);
    const element = await InboxDecisionDescription({
      context: 'source',
      fallback: 'Choose 30 or 90 days.',
    });
    expect(renderToStaticMarkup(element)).toContain('Choose 30 or 90 days.');
  });

  it('renders model output as inert text', async () => {
    vi.mocked(getInboxDecisionSummary).mockResolvedValue(
      '<script>approve()</script>',
    );
    const element = await InboxDecisionDescription({
      context: 'source',
      fallback: 'Original context',
    });
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain('&lt;script&gt;approve()&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
  });
});
