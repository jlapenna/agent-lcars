// @vitest-environment node
import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
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
    const brief = workAtRun(issue, work) as typeof work;
    expect(brief.spec.description).toContain('Search returns no results.');
  });

  it('returns the admitted payload unchanged when the issue grew past the bounds', () => {
    const admitted = {
      ...work,
      spec: { ...work.spec, description: 'a'.repeat(16_384) },
    };
    const brief = workAtRun(
      {
        ...issue,
        title: 't'.repeat(256),
        description: '',
        oversized: true,
      },
      admitted,
    );
    expect(brief).toBe(admitted);
  });
});
