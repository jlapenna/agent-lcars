import { logger } from '@agent-lcars/logging';
import { isE2eTesting } from '@agent-lcars/util-server';
import { NextRequest, NextResponse } from 'next/server';

import { controlPlaneRepository } from '../../../../../lib/deployment';
import {
  addFixtureComment,
  configureGithubActionFixture,
  createFixtureUnstickAnchor,
  E2E_FIXTURE_REPO,
  E2E_FIXTURE_REPOSITORY_ID,
  fixtureUnstickAnchor,
  githubAnchorGraphqlDetail,
  githubMutationJournal,
  issue,
  issueComments,
  mergeFixturePr,
  pullRequest,
  recordGithubMutation,
  selfHostedRunners,
  setFixtureLabels,
  updateFixtureIssueContent,
  updateFixturePrBranch,
} from '../../../../../lib/e2e-github-fixtures';
import { SESSION_EXPIRY_WORKFLOW_FILE } from '../../../../../lib/github-actions-oidc';

/**
 * Stands in for the bounded GitHub REST surface console writes and exact
 * detail reads when
 * `github-client.ts` is pointed at `AGENT_CONSOLE_GITHUB_API_BASE_URL` —
 * only ever set by the agent-lcars e2e suite, which has no real GitHub
 * token and would otherwise 401 against the real API.
 *
 * Queue fixtures are written to the orchestrator emulator instead; this route
 * must not emulate a list or GraphQL queue-discovery path.
 *
 * Anything not matched here 404s deliberately rather than falling through
 * to an empty 200: a silently-empty response for a call this fixture
 * doesn't know about looks exactly like "GitHub has nothing", which is how
 * a missing fixture would hide instead of failing.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }

  const { path } = await params;

  if (path.join('/') === '_fixture') {
    return NextResponse.json(githubMutationJournal());
  }
  if (
    path[0] === 'repos' &&
    path.slice(1, 3).join('/') !==
      `${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}`
  ) {
    return NextResponse.json(
      { message: 'Unknown fixture repository' },
      { status: 404 },
    );
  }
  // Everything below is repo-scoped: /repos/{owner}/{repo}/...
  if (path[0] === 'repos') {
    const rest = path.slice(3);

    // Repository metadata remains available to evidence consumers.
    if (rest.length === 0) {
      return NextResponse.json({ id: E2E_FIXTURE_REPOSITORY_ID });
    }

    // Only the exact Unstick audit-anchor lookup, never queue discovery.
    if (
      rest.length === 1 &&
      rest[0] === 'issues' &&
      _req.nextUrl.searchParams.get('labels') === 'automation:unstick-prs' &&
      _req.nextUrl.searchParams.get('state') === 'open' &&
      _req.nextUrl.searchParams.get('per_page') === '1'
    ) {
      const anchor = fixtureUnstickAnchor();
      return NextResponse.json(anchor ? [issue(anchor.number)] : []);
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

    // GET /repos/{o}/{r}/pulls/{number}
    if (rest[0] === 'pulls' && rest.length === 2) {
      const pr = pullRequest(Number(rest[1]));
      return pr
        ? NextResponse.json(pr)
        : NextResponse.json({ message: 'Not Found' }, { status: 404 });
    }

    // GET /repos/{o}/{r}/actions/runners
    if (rest[0] === 'actions' && rest[1] === 'runners') {
      return NextResponse.json(selfHostedRunners());
    }
  }

  logger.error('agent-lcars: no e2e GitHub fixture for /%s', path.join('/'));
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }
  const { path } = await params;
  const bodyForJournal = await req
    .clone()
    .json()
    .catch(() => null);
  if (path.join('/') === '_fixture') {
    configureGithubActionFixture(bodyForJournal);
    return NextResponse.json({ ok: true });
  }
  const rejection = recordGithubMutation(
    req.method,
    path.join('/'),
    bodyForJournal,
  );
  if (rejection)
    return NextResponse.json({ message: rejection }, { status: 422 });
  if (
    path[0] === 'repos' &&
    path.slice(1, 3).join('/') !==
      `${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}` &&
    !(
      path[3] === 'actions' &&
      path.slice(1, 3).join('/') === controlPlaneRepository()
    )
  ) {
    return NextResponse.json(
      { message: 'Unknown fixture repository' },
      { status: 404 },
    );
  }
  if (
    path[0] === 'repos' &&
    path[3] === 'pulls' &&
    path[5] === 'reviews' &&
    pullRequest(Number(path[4]))
  ) {
    return bodyForJournal?.event === 'APPROVE'
      ? NextResponse.json(
          { id: Number(path[4]), state: 'APPROVED' },
          { status: 201 },
        )
      : NextResponse.json(
          { message: 'Expected APPROVE review' },
          { status: 422 },
        );
  }
  if (
    path[0] === 'repos' &&
    path.length === 4 &&
    path[3] === 'issues' &&
    bodyForJournal?.labels?.length === 1 &&
    bodyForJournal.labels[0] === 'automation:unstick-prs' &&
    typeof bodyForJournal.title === 'string' &&
    typeof bodyForJournal.body === 'string'
  ) {
    return NextResponse.json(
      createFixtureUnstickAnchor(bodyForJournal.title, bodyForJournal.body),
      { status: 201 },
    );
  }
  if (
    path.join('/') === 'graphql' &&
    bodyForJournal?.query?.includes('mutation EnableAutoMerge')
  ) {
    const variables = bodyForJournal.variables ?? bodyForJournal;
    const valid =
      variables.mergeMethod === 'SQUASH' &&
      /^PR_e2e_\d+$/.test(variables.pullRequestId ?? '') &&
      pullRequest(
        Number(String(variables.pullRequestId).replace('PR_e2e_', '')),
      ) !== undefined;
    return valid
      ? NextResponse.json({
          data: { enablePullRequestAutoMerge: { clientMutationId: null } },
        })
      : NextResponse.json(
          { message: 'Invalid auto-merge fixture request' },
          { status: 422 },
        );
  }

  // Exact control-plane refreshes use GitHub GraphQL for presentation fields
  // that REST issue detail omits. This accepts only explicitly aliased anchor
  // reads; it is not a queue/list discovery fixture.
  if (path.length === 1 && path[0] === 'graphql') {
    const body = (await req.json()) as {
      query?: unknown;
      variables?: { owner?: unknown; name?: unknown };
      owner?: unknown;
      name?: unknown;
    };
    const variables = body.variables ?? body;
    if (
      typeof body.query !== 'string' ||
      variables.owner !== E2E_FIXTURE_REPO.owner ||
      variables.name !== E2E_FIXTURE_REPO.name
    ) {
      return NextResponse.json(
        { message: 'Invalid GraphQL anchor refresh fixture request' },
        { status: 422 },
      );
    }
    const aliases = Array.from(
      body.query.matchAll(
        /([A-Za-z_]\w*):\s*issueOrPullRequest\(number:\s*(\d+)\)/gu,
      ),
      ([, alias, number]) => ({ alias, number: Number(number) }),
    );
    if (aliases.length === 0) {
      return NextResponse.json(
        { message: 'Invalid GraphQL anchor refresh fixture request' },
        { status: 422 },
      );
    }
    return NextResponse.json({
      data: {
        repository: Object.fromEntries(
          aliases.map(({ alias, number }) => [
            alias,
            githubAnchorGraphqlDetail(number) ?? null,
          ]),
        ),
      },
    });
  }
  // The broker's outbox drain uses raw fetch rather than Octokit. These two
  // handler keeps the QueueExecutor dispatch coverage inside the same local
  // GitHub boundary while validating the production request shape.
  if (
    path[0] === 'repos' &&
    path.length === 7 &&
    path.slice(1, 3).join('/') === controlPlaneRepository() &&
    path[3] === 'actions' &&
    path[4] === 'workflows' &&
    path[6] === 'dispatches'
  ) {
    const body = (await req.json()) as {
      ref?: unknown;
      inputs?: Record<string, unknown>;
    };
    const inputs = body.inputs;
    if (path[5] === SESSION_EXPIRY_WORKFLOW_FILE) {
      // A native item's close starts its telemetry session expiry.
      return body.ref === 'main' &&
        typeof inputs?.['item'] === 'string' &&
        inputs['item'] !== ''
        ? new NextResponse(null, { status: 204 })
        : NextResponse.json(
            { message: 'Invalid session expiry dispatch fixture request' },
            { status: 422 },
          );
    }
    const valid =
      body.ref === 'main' &&
      inputs !== undefined &&
      typeof inputs['issue'] === 'string' &&
      ['implement', 'plan'].includes(String(inputs['mode'])) &&
      typeof inputs['broker_intent_id'] === 'string' &&
      typeof inputs['broker_generation'] === 'string' &&
      typeof inputs['broker_dispatch_token'] === 'string';
    return valid
      ? new NextResponse(null, { status: 204 })
      : NextResponse.json(
          { message: 'Invalid workflow dispatch fixture request' },
          { status: 422 },
        );
  }
  if (
    path[0] === 'repos' &&
    path.length === 6 &&
    path.slice(1, 3).join('/') ===
      `${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}` &&
    path[3] === 'issues' &&
    path[5] === 'comments'
  ) {
    const body = (await req.json()) as { body?: unknown };
    const fixtureIssue = issue(Number(path[4]));
    return fixtureIssue && typeof body.body === 'string' && body.body.length > 0
      ? NextResponse.json(addFixtureComment(Number(path[4]), body.body), {
          status: 201,
        })
      : NextResponse.json(
          { message: 'Invalid issue comment fixture request' },
          { status: 422 },
        );
  }
  logger.error(
    'agent-lcars: no e2e GitHub fixture for POST /%s',
    path.join('/'),
  );
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }
  const { path } = await params;
  const bodyForJournal = await req
    .clone()
    .json()
    .catch(() => null);
  const rejection = recordGithubMutation(
    req.method,
    path.join('/'),
    bodyForJournal,
  );
  if (rejection)
    return NextResponse.json({ message: rejection }, { status: 422 });
  if (
    path[0] === 'repos' &&
    path.slice(1, 3).join('/') !==
      `${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}` &&
    !(
      path[3] === 'actions' &&
      path.slice(1, 3).join('/') === controlPlaneRepository()
    )
  ) {
    return NextResponse.json(
      { message: 'Unknown fixture repository' },
      { status: 404 },
    );
  }

  if (path[0] === 'repos' && path.length === 5 && path[3] === 'issues') {
    const body = (await req.json()) as { title?: unknown; body?: unknown };
    if (typeof body.title !== 'string' || typeof body.body !== 'string') {
      return NextResponse.json(
        { message: 'Invalid issue edit fixture request' },
        { status: 422 },
      );
    }
    const updated = updateFixtureIssueContent(Number(path[4]), {
      title: body.title,
      body: body.body,
    });
    return updated
      ? NextResponse.json(updated)
      : NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }
  logger.error(
    'agent-lcars: no e2e GitHub fixture for PATCH /%s',
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
  const bodyForJournal = await req
    .clone()
    .json()
    .catch(() => null);
  const rejection = recordGithubMutation(
    req.method,
    path.join('/'),
    bodyForJournal,
  );
  if (rejection)
    return NextResponse.json({ message: rejection }, { status: 422 });
  if (
    path[0] === 'repos' &&
    path.slice(1, 3).join('/') !==
      `${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}` &&
    !(
      path[3] === 'actions' &&
      path.slice(1, 3).join('/') === controlPlaneRepository()
    )
  ) {
    return NextResponse.json(
      { message: 'Unknown fixture repository' },
      { status: 404 },
    );
  }
  if (
    path[0] === 'repos' &&
    path[3] === 'pulls' &&
    pullRequest(Number(path[4]))
  ) {
    if (path[5] === 'merge' && bodyForJournal?.merge_method === 'squash') {
      mergeFixturePr(Number(path[4]));
      return NextResponse.json({
        merged: true,
        sha: 'e2e-merged',
        message: 'Pull Request successfully merged',
      });
    }
    if (path[5] === 'update-branch') {
      updateFixturePrBranch(Number(path[4]));
      return NextResponse.json(
        { message: 'Updating pull request branch', url: '' },
        { status: 202 },
      );
    }
  }

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
    setFixtureLabels(Number(path[4]), body.labels ?? []);
    return NextResponse.json((body.labels ?? []).map((name) => ({ name })));
  }
  logger.error(
    'agent-lcars: no e2e GitHub fixture for PUT /%s',
    path.join('/'),
  );
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isE2eTesting()) {
    return NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }
  const { path } = await params;
  const bodyForJournal = await req
    .clone()
    .json()
    .catch(() => null);
  const rejection = recordGithubMutation(
    req.method,
    path.join('/'),
    bodyForJournal,
  );
  if (rejection)
    return NextResponse.json({ message: rejection }, { status: 422 });
  if (
    path[0] === 'repos' &&
    path.slice(1, 3).join('/') !==
      `${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}` &&
    !(
      path[3] === 'actions' &&
      path.slice(1, 3).join('/') === controlPlaneRepository()
    )
  ) {
    return NextResponse.json(
      { message: 'Unknown fixture repository' },
      { status: 404 },
    );
  }

  if (
    path[0] === 'repos' &&
    path.length === 7 &&
    path[3] === 'issues' &&
    path[5] === 'labels' &&
    path[6] === 'status:needs-human' &&
    issue(Number(path[4]))
  ) {
    setFixtureLabels(
      Number(path[4]),
      (issue(Number(path[4]))?.labels ?? [])
        .map(({ name }) => name)
        .filter((name) => name !== 'status:needs-human'),
    );
    return new NextResponse(null, { status: 204 });
  }
  logger.error(
    'agent-lcars: no e2e GitHub fixture for DELETE /%s',
    path.join('/'),
  );
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}
