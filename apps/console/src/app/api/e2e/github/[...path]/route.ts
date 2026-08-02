import { isE2eTesting } from '@repo/util-server';
import { NextRequest, NextResponse } from 'next/server';

import {
  checkRuns,
  enrichmentGraphql,
  issue,
  issueComments,
  openIssues,
  openPulls,
  pullRequest,
  selfHostedRunners,
  workflowRuns,
} from '../../../../../lib/e2e-github-fixtures';

const E2E_BASE_COMMIT_SHA = '1111111111111111111111111111111111111111';
const quickTaskTagObjects = new Map<string, { message: string; tag: string }>();
const quickTaskClaimRefs = new Map<string, string>();
let quickTaskTagSequence = 0;

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

    // Quick Task's GitHub-native idempotency ledger resolves the repository's
    // default branch only to give its annotated claim tag a valid target.
    if (rest.length === 0) {
      return NextResponse.json({ default_branch: 'main' });
    }

    // GET /repos/{o}/{r}/git/ref/{ref...}
    if (rest[0] === 'git' && rest[1] === 'ref') {
      const ref = rest.slice(2).join('/');
      if (ref === 'heads/main') {
        return NextResponse.json({
          ref: 'refs/heads/main',
          object: { type: 'commit', sha: E2E_BASE_COMMIT_SHA },
        });
      }
      const tagSha = quickTaskClaimRefs.get(ref);
      return tagSha
        ? NextResponse.json({
            ref: `refs/${ref}`,
            object: { type: 'tag', sha: tagSha },
          })
        : NextResponse.json({ message: 'Not Found' }, { status: 404 });
    }

    // GET /repos/{o}/{r}/git/tags/{sha}
    if (rest[0] === 'git' && rest[1] === 'tags' && rest[2]) {
      const tag = quickTaskTagObjects.get(rest[2]);
      return tag
        ? NextResponse.json({ ...tag, sha: rest[2] })
        : NextResponse.json({ message: 'Not Found' }, { status: 404 });
    }

    // GET /repos/{o}/{r}/issues/{number}/comments
    if (rest[0] === 'issues' && rest[2] === 'comments') {
      return NextResponse.json(issueComments(Number(rest[1])));
    }

    // GET /repos/{o}/{r}/issues/{number} - mutation precondition reads.
    if (rest[0] === 'issues' && rest.length === 2) {
      const fixtureIssue = issue(Number(rest[1]));
      return fixtureIssue
        ? NextResponse.json(fixtureIssue)
        : NextResponse.json({ message: 'Not Found' }, { status: 404 });
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
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }
  const { path } = await params;
  if (path[0] === 'graphql') {
    return NextResponse.json({ data: enrichmentGraphql() });
  }
  if (
    path[0] === 'repos' &&
    path.length === 7 &&
    path[3] === 'actions' &&
    path[4] === 'workflows' &&
    path[5] === 'agent-router.yml' &&
    path[6] === 'dispatches'
  ) {
    const body = (await req.json()) as {
      inputs?: Record<string, string>;
      ref?: string;
    };
    const callerId = body.inputs?.['caller_id'] ?? '';
    if (
      body.ref !== 'main' ||
      body.inputs?.['mode'] !== 'implement' ||
      !['claude', 'codex', 'opencode'].includes(
        body.inputs?.['pipeline'] ?? '',
      ) ||
      !/^\d+$/u.test(body.inputs?.['issue'] ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        callerId,
      )
    ) {
      return NextResponse.json(
        { message: 'Invalid router dispatch fixture request' },
        { status: 422 },
      );
    }
    return NextResponse.json({ workflow_run_id: 99001 });
  }
  if (path[0] === 'repos' && path.length === 4 && path[3] === 'issues') {
    const body = (await req.json()) as {
      body?: string;
      labels?: string[];
      title?: string;
    };
    const requestMarker =
      /<!-- agent-lcars:quick-task-request:v1 id=([0-9a-f-]{36}) digest=([0-9a-f]{64}) -->/u.exec(
        body.body ?? '',
      );
    const claimSha = requestMarker
      ? quickTaskClaimRefs.get(
          `tags/agent-lcars/quick-task/${requestMarker[1]}`,
        )
      : undefined;
    const claim = claimSha ? quickTaskTagObjects.get(claimSha) : undefined;
    let hasMatchingClaim = false;
    if (
      requestMarker &&
      claim?.message.startsWith('agent-lcars:quick-task-claim:v1 ')
    ) {
      const persisted = JSON.parse(
        claim.message.slice('agent-lcars:quick-task-claim:v1 '.length),
      ) as Record<string, unknown>;
      hasMatchingClaim =
        persisted['requestId'] === requestMarker[1] &&
        persisted['digest'] === requestMarker[2] &&
        typeof persisted['claimantId'] === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          persisted['claimantId'],
        );
    }
    if (
      !body.title?.trim() ||
      !hasMatchingClaim ||
      !body.labels?.includes('intake:quick-task') ||
      !body.labels.includes('agent:claude')
    ) {
      return NextResponse.json(
        { message: 'Invalid Quick Task fixture request' },
        { status: 422 },
      );
    }
    return NextResponse.json({
      number: 9999,
      html_url: 'https://github.com/supersprinklesracing/sprinkles/issues/9999',
      title: body.title,
      body: body.body,
      labels: body.labels.map((name) => ({ name })),
    });
  }
  if (
    path[0] === 'repos' &&
    path.length === 5 &&
    path[3] === 'git' &&
    path[4] === 'tags'
  ) {
    const body = (await req.json()) as {
      message?: string;
      object?: string;
      tag?: string;
      type?: string;
    };
    if (
      !body.tag?.startsWith('agent-lcars/quick-task/') ||
      !body.message?.startsWith('agent-lcars:quick-task-claim:v1 ') ||
      body.object !== E2E_BASE_COMMIT_SHA ||
      body.type !== 'commit'
    ) {
      return NextResponse.json(
        { message: 'Invalid Quick Task claim tag' },
        { status: 422 },
      );
    }
    const sha = `${String(++quickTaskTagSequence).padStart(40, 'a')}`;
    quickTaskTagObjects.set(sha, { message: body.message, tag: body.tag });
    return NextResponse.json({
      sha,
      tag: body.tag,
      message: body.message,
      object: { type: 'commit', sha: body.object },
    });
  }
  if (
    path[0] === 'repos' &&
    path.length === 5 &&
    path[3] === 'git' &&
    path[4] === 'refs'
  ) {
    const body = (await req.json()) as { ref?: string; sha?: string };
    const ref = body.ref?.replace(/^refs\//u, '');
    if (
      !ref?.startsWith('tags/agent-lcars/quick-task/') ||
      !body.sha ||
      !quickTaskTagObjects.has(body.sha)
    ) {
      return NextResponse.json(
        { message: 'Invalid Quick Task claim ref' },
        { status: 422 },
      );
    }
    if (quickTaskClaimRefs.has(ref)) {
      return NextResponse.json(
        { message: 'Reference already exists' },
        { status: 422 },
      );
    }
    quickTaskClaimRefs.set(ref, body.sha);
    return NextResponse.json({
      ref: body.ref,
      object: { type: 'tag', sha: body.sha },
    });
  }
  console.error(
    'agent-lcars: no e2e GitHub fixture for POST /%s',
    path.join('/'),
  );
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }
  const { path } = await params;
  if (
    path[0] === 'repos' &&
    path.length === 6 &&
    path[3] === 'issues' &&
    path[5] === 'labels'
  ) {
    const fixtureIssue = issue(Number(path[4]));
    const body = (await req.json()) as { labels?: string[] };
    const originalNonControlLabels = (fixtureIssue?.labels ?? [])
      .map((label) => label.name)
      .filter(
        (label) =>
          !label.startsWith('agent:') && label !== 'status:needs-human',
      );
    const agentLabels = (body.labels ?? []).filter((label) =>
      label.startsWith('agent:'),
    );
    const unrelatedLabels = (body.labels ?? []).filter(
      (label) => !label.startsWith('agent:'),
    );
    if (
      !fixtureIssue ||
      agentLabels.length !== 1 ||
      !['agent:claude', 'agent:codex', 'agent:opencode'].includes(
        agentLabels[0],
      ) ||
      JSON.stringify(unrelatedLabels) !==
        JSON.stringify(originalNonControlLabels)
    ) {
      return NextResponse.json(
        { message: 'Invalid atomic label-set fixture request' },
        { status: 422 },
      );
    }
    return NextResponse.json((body.labels ?? []).map((name) => ({ name })));
  }
  console.error(
    'agent-lcars: no e2e GitHub fixture for PUT /%s',
    path.join('/'),
  );
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }
  const { path } = await params;
  if (
    path[0] === 'repos' &&
    path.length === 7 &&
    path[3] === 'issues' &&
    path[5] === 'labels' &&
    path[6] === 'status:needs-human' &&
    issue(Number(path[4]))
  ) {
    return new NextResponse(null, { status: 204 });
  }
  console.error(
    'agent-lcars: no e2e GitHub fixture for DELETE /%s',
    path.join('/'),
  );
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}
