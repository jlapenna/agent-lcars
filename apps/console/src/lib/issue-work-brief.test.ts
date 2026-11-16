// @vitest-environment node
import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import type { Run } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { workAtRun } from './issue-work-brief';

const issue: TrackerIssue = {
  reference: {
    tracker: 'linear',
    organizationId: '11111111-1111-4111-8111-111111111111',
    issueId: '44444444-4444-4444-8444-444444444444',
  },
  identifier: 'ENG-42',
  url: 'https://linear.app/example/issue/ENG-42',
  title: 'Fix search',
  description: 'Search returns no results.',
  updatedAt: '2026-11-04T10:00:00.000Z',
  state: 'open',
  labels: [],
  assignees: [],
};
const work = {
  origin: { principal: 'svc:linear', channel: 'linear' },
  spec: {
    title: 'ENG-42: Fix search',
    description: 'Linear issue: admitted text',
    pipeline: 'codex',
    target: { repo: 'owner/repo' },
  },
};

describe('workAtRun', () => {
  it('builds the brief from the run issue snapshot', () => {
    const brief = workAtRun({ issue } as unknown as Run, work) as typeof work;
    expect(brief.spec.description).toContain('Search returns no results.');
  });

  it('keeps the admitted brief whole when the issue grew past the bounds', () => {
    const brief = workAtRun(
      {
        issue: { ...issue, description: '', oversized: true },
      } as unknown as Run,
      work,
    ) as typeof work;
    expect(brief.spec.description).toContain('Linear issue: admitted text');
    expect(brief.spec.description).toContain(issue.url);
  });
});
