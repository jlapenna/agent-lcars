import { logger } from '@agent-lcars/logging';
import { isE2eTesting } from '@agent-lcars/util-server';
import { NextRequest, NextResponse } from 'next/server';

import { controlPlaneRepository } from '../../../../../lib/deployment';
import {
  E2E_FIXTURE_REPO,
  E2E_FIXTURE_REPOSITORY_ID,
  githubAnchorGraphqlDetail,
  issue,
  issueComments,
  pullRequest,
  selfHostedRunners,
  updateFixtureIssueContent,
} from '../../../../../lib/e2e-github-fixtures';

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

  // Everything below is repo-scoped: /repos/{owner}/{repo}/...
  if (path[0] === 'repos') {
    const rest = path.slice(3);

    // Repository metadata remains available to evidence consumers.
    if (rest.length === 0) {
      return NextResponse.json({ id: E2E_FIXTURE_REPOSITORY_ID });
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
    path.slice(1, 3).join('/') === controlPlaneRepository() &&
    path[3] === 'issues' &&
    path[5] === 'comments'
  ) {
    const body = (await req.json()) as { body?: unknown };
    const fixtureIssue = issue(Number(path[4]));
    return fixtureIssue && typeof body.body === 'string' && body.body.length > 0
      ? NextResponse.json(
          { id: Number(path[4]) * 1000, body: body.body },
          { status: 201 },
        )
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
  logger.error(
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
  logger.error(
    'agent-lcars: no e2e GitHub fixture for DELETE /%s',
    path.join('/'),
  );
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}
