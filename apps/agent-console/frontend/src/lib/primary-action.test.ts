import { describe, expect, it } from 'vitest';

import type { ActionItem } from './action-items';
import { derivePrimaryAction, pipelineForLabels } from './primary-action';

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/members/issues/1',
    updatedAt: '2026-07-12T00:00:00Z',
    actionTypes: [],
    labels: [],
    ...overrides,
  };
}

describe('derivePrimaryAction', () => {
  it('leads with approve-merge for a ready PR under review request', () => {
    expect(
      derivePrimaryAction(
        makeItem({
          kind: 'pr',
          actionTypes: ['review-requested'],
          draft: false,
        }),
      ),
    ).toEqual({ kind: 'approve-merge' });
  });

  it('never offers approve-merge on a draft', () => {
    expect(
      derivePrimaryAction(
        makeItem({
          kind: 'pr',
          actionTypes: ['review-requested'],
          draft: true,
        }),
      ),
    ).toBeUndefined();
  });

  it('leads with reply for human-needed', () => {
    expect(
      derivePrimaryAction(makeItem({ actionTypes: ['human-needed'] })),
    ).toEqual({ kind: 'reply' });
  });

  it('prefers the review over a failing run when both apply', () => {
    expect(
      derivePrimaryAction(
        makeItem({
          kind: 'pr',
          actionTypes: ['review-requested', 'run-failed'],
          failingChecks: [{ name: 'Verify', url: 'https://ci/1' }],
        }),
      ),
    ).toEqual({ kind: 'approve-merge' });
  });

  it('points at the first failing check for run-failed', () => {
    expect(
      derivePrimaryAction(
        makeItem({
          kind: 'pr',
          actionTypes: ['run-failed'],
          failingChecks: [
            { name: 'Verify', url: 'https://ci/1' },
            { name: 'E2E Tests', url: 'https://ci/2' },
          ],
        }),
      ),
    ).toEqual({
      kind: 'fix-ci',
      checkName: 'Verify',
      checkUrl: 'https://ci/1',
    });
  });

  it('derives nothing for deploy-waits and unlabeled items', () => {
    expect(
      derivePrimaryAction(makeItem({ actionTypes: ['post-deploy-action'] })),
    ).toBeUndefined();
    expect(derivePrimaryAction(makeItem())).toBeUndefined();
  });
});

describe('pipelineForLabels', () => {
  it('routes to opencode when only the opencode label is present', () => {
    expect(pipelineForLabels(['opencode'])).toBe('opencode');
  });

  it('routes to claude when only the claude label is present', () => {
    expect(pipelineForLabels(['claude'])).toBe('claude');
  });

  it('routes to claude when neither pipeline label is present', () => {
    expect(pipelineForLabels([])).toBe('claude');
    expect(pipelineForLabels(['human-needed'])).toBe('claude');
  });

  it('routes to claude when both labels are present - one console action must never dispatch two pipelines', () => {
    expect(pipelineForLabels(['claude', 'opencode'])).toBe('claude');
  });
});
