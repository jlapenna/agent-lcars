import { isE2eTesting } from '@repo/util-server';
import { NextRequest, NextResponse } from 'next/server';

import {
  checkRuns,
  enrichmentGraphql,
  issueComments,
  openIssues,
  openPulls,
  pullRequest,
  selfHostedRunners,
  workflowRuns,
} from '../../../../../lib/e2e-github-fixtures';

/**
 * Stands in for the whole GitHub REST surface the dashboard reads when
 * `github-client.ts` is pointed at `AGENT_CONSOLE_GITHUB_API_BASE_URL` —
 * only ever set by the agent-lcars e2e suite, which has no real GitHub
 * token and would otherwise 401 against the real API.
 *
 * This started life as a single `search/issues` route serving only the
 * branch->PR join `getCliSessions()` needs - that route is gone now, the
 * console having stopped calling the search API at all (#13). #40 needed the dashboard
 * rendered against non-empty data — action-item cards, run rows, a runner
 * fleet — so it grew into the catch-all it is now. The fixture data itself
 * (and the populated-mode toggle that keeps it invisible to the older
 * specs) lives in `lib/e2e-github-fixtures.ts`; this file is only the
 * URL->fixture routing.
 *
 * Anything not matched here 404s deliberately rather than falling through
 * to an empty 200: a silently-empty response for a call this fixture
 * doesn't know about looks exactly like "GitHub has nothing", which is how
 * a missing fixture would hide instead of failing.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }

  const { path } = await params;
  const query = req.nextUrl.searchParams;

  // Everything below is repo-scoped: /repos/{owner}/{repo}/...
  if (path[0] === 'repos') {
    const rest = path.slice(3);

    // GET /repos/{o}/{r}/issues/{number}/comments
    if (rest[0] === 'issues' && rest[2] === 'comments') {
      return NextResponse.json(issueComments(Number(rest[1])));
    }

    // GET /repos/{o}/{r}/issues - the action-item board's item universe
    // since #13. Page 2+ is empty so the app's pagination loop terminates.
    if (rest[0] === 'issues' && rest.length === 1) {
      const page = Number(query.get('page') ?? '1');
      return NextResponse.json(page > 1 ? [] : openIssues());
    }

    // GET /repos/{o}/{r}/pulls - supplies the review-requested predicate.
    if (rest[0] === 'pulls' && rest.length === 1) {
      const page = Number(query.get('page') ?? '1');
      return NextResponse.json(page > 1 ? [] : openPulls());
    }

    // GET /repos/{o}/{r}/pulls/{number}
    if (rest[0] === 'pulls' && rest.length === 2) {
      const pr = pullRequest(Number(rest[1]));
      return pr
        ? NextResponse.json(pr)
        : NextResponse.json({ message: 'Not Found' }, { status: 404 });
    }

    // GET /repos/{o}/{r}/commits/{ref}/check-runs
    if (rest[0] === 'commits' && rest[2] === 'check-runs') {
      return NextResponse.json(checkRuns(rest[1]));
    }

    // GET /repos/{o}/{r}/actions/workflows/{file}/runs
    if (
      rest[0] === 'actions' &&
      rest[1] === 'workflows' &&
      rest[3] === 'runs'
    ) {
      return NextResponse.json(
        workflowRuns(rest[2], query.get('status') ?? undefined),
      );
    }

    // GET /repos/{o}/{r}/actions/runners
    if (rest[0] === 'actions' && rest[1] === 'runners') {
      return NextResponse.json(selfHostedRunners());
    }
  }

  console.error('agent-lcars: no e2e GitHub fixture for /%s', path.join('/'));
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}

/**
 * `POST /graphql`. Octokit's `graphql()` posts to `{baseUrl}/graphql`, so
 * pointing the client at this fixture catches the enrichment query too -
 * without this the console would reach past the fixture to the real API
 * mid-suite (and 401, having no real token).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }
  const { path } = await params;
  if (path[0] === 'graphql') {
    return NextResponse.json({ data: enrichmentGraphql() });
  }
  console.error(
    'agent-lcars: no e2e GitHub fixture for POST /%s',
    path.join('/'),
  );
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}
