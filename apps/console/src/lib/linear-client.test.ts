// @vitest-environment node
import {
  TRACKER_ISSUE_DESCRIPTION_MAX,
  TRACKER_ISSUE_TITLE_MAX,
} from '@agent-lcars/dispatch-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  linearIssueSnapshot,
  LinearIssueTooLargeError,
  listLinearIssues,
} from './linear-client';

const org = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';

function node(identifier: string, title: string, description: string) {
  return {
    id: crypto.randomUUID(),
    identifier,
    title,
    description,
    url: `https://linear.app/example/issue/${identifier}`,
    updatedAt: '2026-11-04T10:00:00.000Z',
    team: { id: team },
    state: { id: crypto.randomUUID(), name: 'Todo', type: 'unstarted' },
    archivedAt: null,
    trashed: null,
    assignee: null,
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
  };
}

beforeEach(() => vi.stubEnv('AGENT_LCARS_LINEAR_API_KEY', 'lin_test'));
afterEach(() => vi.unstubAllEnvs());

describe('Linear issue snapshot bounds', () => {
  it('keeps a title and description at the bound whole', () => {
    const title = 't'.repeat(TRACKER_ISSUE_TITLE_MAX);
    const description = 'd'.repeat(TRACKER_ISSUE_DESCRIPTION_MAX);
    const snapshot = linearIssueSnapshot(
      org,
      node('ENG-1', title, description),
    );
    expect(snapshot.title).toBe(title);
    expect(snapshot.description).toBe(description);
  });

  it.each([
    ['title', 't'.repeat(TRACKER_ISSUE_TITLE_MAX + 1), 'ok'],
    ['description', 'ok', 'd'.repeat(TRACKER_ISSUE_DESCRIPTION_MAX + 1)],
  ])('refuses rather than cuts an oversized %s', (_, title, description) => {
    expect(() =>
      linearIssueSnapshot(org, node('ENG-2', title, description)),
    ).toThrow(LinearIssueTooLargeError);
  });

  it('reports an oversized issue on a page without blocking the others', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: {
          organization: { id: org },
          team: {
            issues: {
              nodes: [
                node('ENG-3', 'fits', 'fits'),
                node(
                  'ENG-4',
                  'big',
                  'd'.repeat(TRACKER_ISSUE_DESCRIPTION_MAX + 1),
                ),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    ) as unknown as typeof fetch;
    const page = await listLinearIssues(org, team, undefined, fetchImpl);
    expect(page.issues.map((issue) => issue.identifier)).toEqual(['ENG-3']);
    expect(page.oversized).toEqual(['ENG-4']);
  });
});
