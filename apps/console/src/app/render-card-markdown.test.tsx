import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { BoardCard } from './board-card';
import { inboxCardKey, type NativeDecisionCard } from './inbox-card';
import {
  renderCardMarkdown,
  renderInboxCardMarkdown,
  renderInboxListMarkdown,
} from './render-card-markdown';

const item: ActionItem = {
  kind: 'issue',
  repo: { owner: 'agent', name: 'lcars' },
  number: 2201,
  title: 'Ready decision',
  url: 'https://github.com/agent/lcars/issues/2201',
  updatedAt: '2026-10-14T19:00:00Z',
  actionTypes: ['needs-human'],
  labels: [],
  assigneeLogins: [],
};

describe('server-rendered card context', () => {
  it('retains formatted context and safe links without interpreting raw HTML or dangerous URLs', () => {
    const card = renderCardMarkdown({
      item: {
        ...item,
        body: '**Decision** [evidence](https://example.com/proof) <script>alert(1)</script>',
        lastCommentBody: '[unsafe](javascript:alert%281%29)\n\n- [x] checked',
      },
    });
    const description = renderToStaticMarkup(card.description);
    const comment = renderToStaticMarkup(card.lastComment);
    expect(description).toContain('<strong>Decision</strong>');
    expect(description).toContain('href="https://example.com/proof"');
    expect(description).not.toContain('<script>');
    expect(description).toContain('&lt;script&gt;');
    expect(comment).not.toContain('href="javascript:');
    expect(comment).toContain('type="checkbox"');
    expect(comment).toContain('disabled');
  });

  it('uses refreshed bodies for the same anchor without changing its action', () => {
    const action = { kind: 'reply' as const, label: 'Reply' };
    const before = renderCardMarkdown({
      item: { ...item, body: 'Old context' },
      primaryAction: action,
    });
    const after = renderCardMarkdown({
      item: { ...item, body: 'Fresh context' },
      primaryAction: action,
    });
    expect(renderToStaticMarkup(before.description)).toContain('Old context');
    expect(renderToStaticMarkup(after.description)).toContain('Fresh context');
    expect(renderToStaticMarkup(after.description)).not.toContain(
      'Old context',
    );
    expect(after.primaryAction).toEqual(action);
  });
});

describe('server-rendered native decision question', () => {
  it('renders the parked question as Markdown and escapes raw HTML', () => {
    const native = {
      canReply: true,
      work: {
        id: 'work:1',
        anchor: { workId: '1' },
        state: 'parked',
        createdAt: '2026-10-09T00:00:00Z',
        updatedAt: '2026-10-09T00:30:00Z',
        origin: { principal: 'user:maintainer', channel: 'console' },
        spec: { title: 'T', pipeline: 'claude', target: { repo: 'o/r' } },
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
              message: '**Pick one**\n\n- a\n- b <script>x</script>',
            },
          },
        ],
      },
    } as unknown as NativeDecisionCard;
    const out = renderInboxCardMarkdown(native) as NativeDecisionCard;
    const html = renderToStaticMarkup(out.question);
    expect(html).toContain('<strong>Pick one</strong>');
    expect(html).toContain('<li>a</li>');
    expect(html).not.toContain('<script>');
  });
});

describe('queue-list Markdown separation (#2201)', () => {
  const native: NativeDecisionCard = {
    canReply: true,
    queued: true,
    kind: 'decision',
    work: {
      id: 'work:9',
      anchor: { workId: '9' },
      state: 'parked',
      createdAt: '2026-10-09T00:00:00Z',
      updatedAt: '2026-10-09T00:30:00Z',
      origin: { principal: 'user:maintainer', channel: 'console' },
      spec: { title: 'T', pipeline: 'claude', target: { repo: 'o/r' } },
      runs: [
        {
          runId: 'r1',
          state: 'finished',
          pipeline: 'claude',
          createdAt: '2026-10-09T00:00:00Z',
          updatedAt: '2026-10-09T00:30:00Z',
          result: { ok: true, summary: 'park', message: '**Pick one**' },
        },
      ],
    },
  } as unknown as NativeDecisionCard;
  const board: BoardCard = {
    item: { ...item, body: 'Hidden **body**' },
  };
  const nativeKey = inboxCardKey(native);
  const boardKey = inboxCardKey(board);
  const question = (card: NativeDecisionCard) =>
    card.question ? renderToStaticMarkup(card.question) : undefined;

  it('renders Markdown for every card while browsing with no selection', () => {
    const [nativeOut, boardOut] = renderInboxListMarkdown([native, board]);
    expect(question(nativeOut as NativeDecisionCard)).toContain(
      '<strong>Pick one</strong>',
    );
    expect(renderToStaticMarkup((boardOut as BoardCard).description)).toContain(
      '<strong>body</strong>',
    );
  });

  it('attaches Markdown only to the selected decision, leaving hidden rows plain', () => {
    const selectedNative = renderInboxListMarkdown([native, board], nativeKey);
    expect(question(selectedNative[0] as NativeDecisionCard)).toContain(
      '<strong>Pick one</strong>',
    );
    expect(selectedNative[1].description).toBeUndefined();

    const selectedBoard = renderInboxListMarkdown([native, board], boardKey);
    expect(question(selectedBoard[0] as NativeDecisionCard)).toBeUndefined();
    expect(renderToStaticMarkup(selectedBoard[1].description)).toContain(
      '<strong>body</strong>',
    );
  });
});
