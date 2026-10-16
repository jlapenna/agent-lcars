import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { NativeDecisionCard } from './inbox-card';
import {
  renderCardMarkdown,
  renderInboxCardMarkdown,
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
