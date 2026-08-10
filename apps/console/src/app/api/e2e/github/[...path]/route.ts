import { parseQuickTaskMarker } from '@agent-lcars/dispatch-contracts';
import { FirestoreStoragePort } from '@agent-lcars/dispatch-controller/storage/firestore-port';
import { isE2eTesting } from '@agent-lcars/util-server';
import { NextRequest, NextResponse } from 'next/server';

import {
  checkRuns,
  createQuickTaskClaimRef,
  createQuickTaskClaimTag,
  deleteQuickTaskClaimRef,
  E2E_FIXTURE_REPO,
  E2E_FIXTURE_REPOSITORY_ID,
  E2E_QUICK_TASK_DELAY_DESCRIPTION,
  E2E_QUICK_TASK_FORCE_4XX_DESCRIPTION,
  enrichmentGraphql,
  getQuickTaskClaimRefSha,
  getQuickTaskClaimTag,
  issue,
  issueComments,
  openIssues,
  openPulls,
  pullRequest,
  quickTaskControllerState,
  quickTaskListingIssues,
  reassignFixtureIssuePipeline,
  recordQuickTaskIssue,
  selfHostedRunners,
  updateFixtureIssueContent,
  workflowRuns,
} from '../../../../../lib/e2e-github-fixtures';

const E2E_BASE_COMMIT_SHA = '1111111111111111111111111111111111111111';
const QUICK_TASK_LABEL = 'intake:quick-task';
const QUICK_TASK_AGENT_LABELS = [
  'agent:claude',
  'agent:codex',
  'agent:opencode',
];

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
      return NextResponse.json({
        id: E2E_FIXTURE_REPOSITORY_ID,
        default_branch: 'main',
      });
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
      const tagSha = getQuickTaskClaimRefSha(ref);
      return tagSha
        ? NextResponse.json({
            ref: `refs/${ref}`,
            object: { type: 'tag', sha: tagSha },
          })
        : NextResponse.json({ message: 'Not Found' }, { status: 404 });
    }

    // GET /repos/{o}/{r}/git/tags/{sha}
    if (rest[0] === 'git' && rest[1] === 'tags' && rest[2]) {
      const tag = getQuickTaskClaimTag(rest[2]);
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
    //
    // `state=all` is a distinct caller: `findExistingQuickTask` in
    // backend-actions.ts asks for it specifically to scan for its
    // request-ID marker across every issue regardless of open/closed state
    // - the `state=open` board listing (openIssues(), unchanged) never
    // needs to see a Quick Task issue at all.
    if (rest[0] === 'issues' && rest.length === 1) {
      const page = Number(query.get('page') ?? '1');
      if (page > 1) return NextResponse.json([]);
      return NextResponse.json(
        query.get('state') === 'all' ? quickTaskListingIssues() : openIssues(),
      );
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
  if (path[0] === 'controller-commands' && path.length === 1) {
    const body = (await req.json()) as Record<string, unknown>;
    const repository = body['repository'] as Record<string, unknown>;
    const validBase =
      repository?.['owner'] === E2E_FIXTURE_REPO.owner &&
      repository?.['name'] === E2E_FIXTURE_REPO.name &&
      Number.isSafeInteger(body['issueNumber']) &&
      typeof body['requestId'] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        body['requestId'],
      );
    if (!validBase) {
      return NextResponse.json(
        { message: 'Invalid hosted controller command fixture request' },
        { status: 422 },
      );
    }
    // agent-lcars#811: no real dispatch-controller logic runs against this
    // fixture (docs/e2e-security-boundary.md), so this stands in for
    // applyPipelineReassignment's own atomic replace + typed rejections
    // directly against the fixture's issue store, keeping the "one PUT,
    // unrelated labels preserved" contract observable end to end. Reads
    // targetLabel/pipelineLabels straight off the command body -- the
    // console resolves the repo's own label contract before posting here
    // (Codex review on #904), so this fixture never reconstructs a label
    // from a bare pipeline name either.
    if (body['kind'] === 'reassign-pipeline') {
      const targetPipeline = String(body['targetPipeline']);
      const targetLabel = body['targetLabel'];
      const pipelineLabels = body['pipelineLabels'];
      if (
        !['claude', 'codex', 'opencode'].includes(targetPipeline) ||
        typeof targetLabel !== 'string' ||
        !targetLabel ||
        !Array.isArray(pipelineLabels) ||
        pipelineLabels.length === 0 ||
        !pipelineLabels.every((label) => typeof label === 'string') ||
        !pipelineLabels.includes(targetLabel)
      ) {
        return NextResponse.json(
          { message: 'Invalid hosted controller command fixture request' },
          { status: 422 },
        );
      }
      const result = reassignFixtureIssuePipeline(
        Number(body['issueNumber']),
        targetLabel,
        pipelineLabels,
      );
      return result.ok
        ? NextResponse.json({ ok: true, requestId: body['requestId'] })
        : NextResponse.json(
            {
              message: `Pipeline reassignment fixture rejected: ${result.reason}`,
            },
            { status: 422 },
          );
    }
    const validCommand =
      body['kind'] === 'reconcile' ||
      (body['kind'] === 'retrigger' &&
        ['claude', 'codex', 'opencode'].includes(String(body['pipeline'])));
    return validCommand
      ? NextResponse.json({ ok: true, requestId: body['requestId'] })
      : NextResponse.json(
          { message: 'Invalid hosted controller command fixture request' },
          { status: 422 },
        );
  }
  if (path[0] === 'repos' && path.length === 4 && path[3] === 'issues') {
    const body = (await req.json()) as {
      body?: string;
      labels?: string[];
      title?: string;
    };
    const requestMarker = parseQuickTaskMarker(body.body);
    const claimSha = requestMarker
      ? getQuickTaskClaimRefSha(
          `tags/agent-lcars/quick-task/${requestMarker.requestId}`,
        )
      : undefined;
    const claim = claimSha ? getQuickTaskClaimTag(claimSha) : undefined;
    let hasMatchingClaim = false;
    if (
      requestMarker &&
      claim?.message.startsWith('agent-lcars:quick-task-claim:v1 ')
    ) {
      const persisted = JSON.parse(
        claim.message.slice('agent-lcars:quick-task-claim:v1 '.length),
      ) as Record<string, unknown>;
      hasMatchingClaim =
        persisted['requestId'] === requestMarker.requestId &&
        persisted['digest'] === requestMarker.digest &&
        typeof persisted['claimantId'] === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          persisted['claimantId'],
        );
    }
    // Exactly `intake:quick-task` plus one `agent:*` label - the one-write
    // contract in docs/quick-task-identity.md (no extra labels, no more
    // than one agent selected, matching real backend-actions.ts's
    // `labels: [QUICK_TASK_LABEL, integration.label]`).
    const agentLabels = (body.labels ?? []).filter((label) =>
      QUICK_TASK_AGENT_LABELS.includes(label),
    );
    if (
      !body.title?.trim() ||
      !hasMatchingClaim ||
      body.labels?.length !== 2 ||
      !body.labels.includes(QUICK_TASK_LABEL) ||
      agentLabels.length !== 1
    ) {
      return NextResponse.json(
        { message: 'Invalid Quick Task fixture request' },
        { status: 422 },
      );
    }
    // Deliberate failure-injection sentinel (see this constant's own doc
    // comment) - lets a spec drive a definitive, claim-releasing 4xx through
    // the real description field rather than an out-of-band control channel.
    if (body.body?.split('\n', 1)[0] === E2E_QUICK_TASK_FORCE_4XX_DESCRIPTION) {
      return NextResponse.json(
        { message: 'E2E fixture: forced definitive Quick Task failure' },
        { status: 422 },
      );
    }
    if (body.body?.split('\n', 1)[0] === E2E_QUICK_TASK_DELAY_DESCRIPTION) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    const pipeline = agentLabels[0].slice('agent:'.length) as
      'claude' | 'codex' | 'opencode';
    const created = recordQuickTaskIssue({
      title: body.title,
      body: body.body ?? '',
      labels: body.labels,
      pipeline,
    });
    const controllerState = quickTaskControllerState(created.number);
    if (controllerState) {
      const port = new FirestoreStoragePort({
        projectId: process.env['PROJECT_ID'] ?? 'demo-no-project',
        databaseId:
          process.env['DISPATCH_FIRESTORE_DATABASE_ID'] ?? '(default)',
      });
      const task = {
        repositoryId: E2E_FIXTURE_REPOSITORY_ID,
        repository: `${E2E_FIXTURE_REPO.owner}/${E2E_FIXTURE_REPO.name}`,
        issue: created.number,
      };
      const current = await port.readTask(task);
      await port.writeTask(task, current?.revision, {
        signals: [],
        intents: [],
        controllerState,
      });
    }
    return NextResponse.json(created);
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
    const { sha } = createQuickTaskClaimTag(body.message, body.tag);
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
      !getQuickTaskClaimTag(body.sha)
    ) {
      return NextResponse.json(
        { message: 'Invalid Quick Task claim ref' },
        { status: 422 },
      );
    }
    if (!createQuickTaskClaimRef(ref, body.sha)) {
      return NextResponse.json(
        { message: 'Reference already exists' },
        { status: 422 },
      );
    }
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
  console.error(
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
  // DELETE /repos/{o}/{r}/git/refs/{ref} - releaseQuickTaskClaim's half of
  // the claim-tag protocol (docs/quick-task-identity.md), reached after a
  // definitive 4xx create failure. Octokit's `ref` path param already
  // excludes the leading `refs/`, matching the GET .../git/ref/{ref} and
  // POST .../git/refs handlers above.
  if (path[0] === 'repos' && path[3] === 'git' && path[4] === 'refs') {
    const ref = path.slice(5).join('/');
    return deleteQuickTaskClaimRef(ref)
      ? new NextResponse(null, { status: 204 })
      : NextResponse.json({ message: 'Not Found' }, { status: 404 });
  }
  console.error(
    'agent-lcars: no e2e GitHub fixture for DELETE /%s',
    path.join('/'),
  );
  return NextResponse.json({ message: 'Not Found' }, { status: 404 });
}
