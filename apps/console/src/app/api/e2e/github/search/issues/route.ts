import { isE2eTesting } from '@repo/util-server';
import { NextRequest, NextResponse } from 'next/server';

import {
  E2E_FIXTURE_BRANCH,
  E2E_FIXTURE_PR_NUMBER,
  E2E_FIXTURE_PR_TITLE,
  E2E_FIXTURE_PR_URL,
} from '../../../../../../lib/e2e-fixtures';

/**
 * Stands in for `GET /search/issues` (Octokit's `search.issuesAndPullRequests`)
 * when `github-client.ts` is pointed at `AGENT_CONSOLE_GITHUB_API_BASE_URL` —
 * only ever set by the agent-lcars e2e suite, which has no real GitHub
 * token and would otherwise 401 against the real API. `getCliSessions()`'s
 * `joinBranchToPr()` is the one caller this needs to satisfy so the "joined
 * PR" acceptance criterion is verifiable without live GitHub access; every
 * other query (e.g. `getActionItems()`'s dashboard searches) legitimately
 * finds nothing here and degrades to an empty list, same as it would against
 * a real token with no matching issues.
 */
export async function GET(req: NextRequest) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }

  const q = req.nextUrl.searchParams.get('q') ?? '';
  const matchesFixtureBranch =
    q.includes('is:pr') &&
    q.includes('is:open') &&
    q.includes(`head:${E2E_FIXTURE_BRANCH}`);

  if (!matchesFixtureBranch) {
    return NextResponse.json({
      total_count: 0,
      incomplete_results: false,
      items: [],
    });
  }

  return NextResponse.json({
    total_count: 1,
    incomplete_results: false,
    items: [
      {
        number: E2E_FIXTURE_PR_NUMBER,
        title: E2E_FIXTURE_PR_TITLE,
        html_url: E2E_FIXTURE_PR_URL,
        pull_request: {},
      },
    ],
  });
}
