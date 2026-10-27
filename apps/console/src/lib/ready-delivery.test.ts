// @vitest-environment node

import { generateKeyPairSync } from 'node:crypto';

import {
  decidedRun,
  type DeliveryBinding,
  isRefusal,
  MemoryStore,
  Orchestrator,
  type Run,
  type Task,
} from '@agent-lcars/orchestrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppInstallationTokenProvider,
  ORCHESTRATOR_GITHUB_PERMISSIONS,
} from './github-app-tokens';
import {
  deliveryCorrectionAuthorized,
  observeGithubDelivery,
  readGithubIntakePermission,
  readyDeliveryBinding,
  UnqualifiedDeliveryError,
} from './ready-delivery';

vi.mock('./deployment', () => ({ isControlPlaneRepository: () => true }));

const NOW = '2026-10-13T10:00:00.000Z';
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const RUN = {
  runId: 'octo/example#7/r1',
  task: { repo: 'octo/example', issue: 7 },
} as Run;
const TASK = {
  work: {
    origin: { principal: 'user:operator', channel: 'api' },
    spec: {
      title: 'ship',
      description: 'ship',
      pipeline: 'claude',
      target: { repo: 'octo/example' },
    },
  },
} as unknown as Task;
const BINDING: DeliveryBinding = {
  runId: RUN.runId,
  repo: 'octo/example',
  number: 12,
  baseRef: 'main',
  head: HEAD,
  state: 'waiting',
  observedAt: NOW,
};

function fixture(
  overrides: {
    pr?: object;
    checks?: object;
    workflows?: object;
    jobs?: object;
    rules?: unknown;
    rulePages?: Record<number, unknown>;
    review?: object;
  } = {},
) {
  const pr = {
    number: 12,
    body: `<!-- attempt-claim:g1:${RUN.runId} -->`,
    state: 'open',
    draft: false,
    head: { sha: HEAD },
    base: { ref: 'main' },
    user: { login: 'author' },
    merged: false,
    merge_commit_sha: null,
    auto_merge: { merge_method: 'squash' },
    ...overrides.pr,
  };
  const checks = (overrides.checks ?? {
    total_count: 1,
    check_runs: [
      { name: 'Verify', head_sha: HEAD, status: 'queued', conclusion: null },
    ],
  }) as {
    total_count: number;
    check_runs: {
      id?: number;
      check_suite?: { id: number };
      name: string;
      head_sha: string;
      status: string;
      conclusion: string | null;
    }[];
  };
  checks.check_runs = checks.check_runs.map((check, index) => ({
    id: index + 1,
    check_suite: { id: 1 },
    ...check,
  }));
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith('/graphql'))
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              headRefOid: HEAD,
              reviews: {
                pageInfo: { hasPreviousPage: false },
                nodes: [
                  {
                    state: 'APPROVED',
                    author: { login: 'reviewer' },
                    commit: { oid: HEAD },
                  },
                ],
              },
              reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
              ...overrides.review,
            },
          },
        },
      });
    if (path.endsWith('/pulls/12')) return Response.json(pr);
    if (path.includes('/rules/branches/')) {
      const query = new URL(path).searchParams;
      const rules = overrides.rulePages?.[Number(query.get('page') ?? '1')] ??
        overrides.rules ?? [
          { type: 'pull_request' },
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'Verify' }] },
          },
        ];
      if (rules instanceof Response) return rules;
      return Response.json(
        Array.isArray(rules)
          ? rules.slice(0, Number(query.get('per_page') ?? '30'))
          : rules,
      );
    }
    if (path.includes('/check-runs')) return Response.json(checks);
    if (path.includes('/actions/runs?'))
      return Response.json(
        overrides.workflows ?? {
          total_count: 1,
          workflow_runs: [
            {
              id: 100,
              workflow_id: 10,
              run_number: 2,
              run_attempt: 1,
              head_sha: HEAD,
              check_suite_id: 1,
              event: 'pull_request',
              conclusion: null,
            },
          ],
        },
      );
    if (path.includes('/attempts/'))
      return Response.json(
        overrides.jobs ?? {
          total_count: checks.check_runs.length,
          jobs: checks.check_runs.map((check) => ({
            run_id: 100,
            head_sha: HEAD,
            check_run_url: `https://api.github.com/repos/octo/example/check-runs/${check.id}`,
            status: check.status,
            conclusion: check.conclusion,
          })),
        },
      );
    if (path.includes('/status?'))
      return Response.json({ total_count: 0, statuses: [] });
    throw Error(`Unexpected fixture request: ${path}`);
  });
  return {
    tokens: { tokenFor: async () => 'test-token' },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  };
}

describe('authenticated ready delivery evidence', () => {
  it('accepts an exact attempt-marked reviewed ready protected arm while own CI is queued', async () => {
    expect(
      await readyDeliveryBinding(fixture(), {
        run: RUN,
        task: TASK,
        repo: 'octo/example',
        number: 12,
        now: NOW,
      }),
    ).toEqual(BINDING);
    expect(await observeGithubDelivery(fixture(), BINDING)).toEqual({
      kind: 'waiting',
      head: HEAD,
    });
  });

  it('hands off an armed exact-head PR while independent review and own CI are pending', async () => {
    const review = {
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    };
    const deps = fixture({ review });
    const binding = await readyDeliveryBinding(deps, {
      run: RUN,
      task: TASK,
      repo: 'octo/example',
      number: 12,
      now: NOW,
    });
    expect(binding).toEqual(BINDING);
    expect(await observeGithubDelivery(deps, binding)).toEqual({
      kind: 'waiting',
      head: HEAD,
    });
  });

  it.each([
    {
      name: 'changes requested',
      review: {
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            {
              state: 'CHANGES_REQUESTED',
              author: { login: 'reviewer' },
              commit: { oid: HEAD },
            },
          ],
        },
      },
    },
    {
      name: 'unresolved thread',
      review: {
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [{ isResolved: false }],
        },
      },
    },
  ])('ends monitoring at merge despite late $name', async ({ review }) => {
    expect(
      await observeGithubDelivery(
        fixture({
          pr: {
            state: 'closed',
            merged: true,
            merge_commit_sha: MERGE,
            auto_merge: null,
          },
          review,
        }),
        BINDING,
      ),
    ).toEqual({ kind: 'merged', head: HEAD, mergeCommit: MERGE });
  });

  it('hands off an armed PR with one PR read, then settles its protected landing', async () => {
    const review = {
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    };
    const open = fixture({ review });
    const merged = fixture({
      pr: {
        state: 'closed',
        merged: true,
        merge_commit_sha: MERGE,
        auto_merge: null,
      },
      review,
    });
    let prReads = 0;
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).endsWith('/pulls/12') && prReads++ > 0
        ? merged.fetchImpl(url)
        : open.fetchImpl(url)) as typeof fetch;
    expect(
      await readyDeliveryBinding(
        { ...open, fetchImpl },
        { run: RUN, task: TASK, repo: 'octo/example', number: 12, now: NOW },
      ),
    ).toEqual(BINDING);
    expect(prReads).toBe(1);
    expect(await observeGithubDelivery(merged, BINDING)).toEqual({
      kind: 'merged',
      head: HEAD,
      mergeCommit: MERGE,
    });
  });

  it('settles an armed handoff on protected merge without an approval', async () => {
    const review = {
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    };
    const binding = await readyDeliveryBinding(fixture({ review }), {
      run: RUN,
      task: TASK,
      repo: 'octo/example',
      number: 12,
      now: NOW,
    });
    const pr = {
      state: 'closed',
      merged: true,
      merge_commit_sha: MERGE,
      auto_merge: null,
    };
    expect(
      await observeGithubDelivery(fixture({ pr, review }), binding),
    ).toEqual({
      kind: 'merged',
      head: HEAD,
      mergeCommit: MERGE,
    });
  });

  it('retains actionable review feedback in the monitor after an armed handoff', async () => {
    const deps = fixture({
      review: {
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            {
              state: 'CHANGES_REQUESTED',
              author: { login: 'reviewer' },
              commit: { oid: HEAD },
            },
          ],
        },
      },
    });
    const binding = await readyDeliveryBinding(deps, {
      run: RUN,
      task: TASK,
      repo: 'octo/example',
      number: 12,
      now: NOW,
    });
    expect(await observeGithubDelivery(deps, binding)).toMatchObject({
      kind: 'correction',
      head: HEAD,
    });
  });

  it.each([
    { pr: { draft: true }, unqualified: false },
    { pr: { auto_merge: null }, unqualified: true },
    { pr: { auto_merge: { merge_method: 'merge' } }, unqualified: false },
    { pr: { auto_merge: { merge_method: 'rebase' } }, unqualified: false },
    { pr: { auto_merge: null }, rules: [], unqualified: false },
    {
      pr: { auto_merge: null },
      rules: [{ type: 'pull_request' }],
      unqualified: false,
    },
    {
      pr: { auto_merge: null },
      rules: new Response(null, { status: 502 }),
      unqualified: false,
    },
    { pr: { body: '<!-- attempt-claim:old -->' }, unqualified: false },
    { pr: { auto_merge: null, body: null }, unqualified: false },
    {
      pr: { auto_merge: null, body: '<!-- attempt-claim:old -->' },
      unqualified: false,
    },
    { pr: { auto_merge: null, number: 13 }, unqualified: false },
    { pr: { auto_merge: null, draft: true }, unqualified: false },
    { pr: { auto_merge: null, state: 'closed' }, unqualified: false },
  ])(
    'refuses unready, unarmed or wrong-attempt evidence: $pr',
    async ({ pr, rules, unqualified }) => {
      const error = await readyDeliveryBinding(fixture({ pr, rules }), {
        run: RUN,
        task: TASK,
        repo: 'octo/example',
        number: 12,
        now: NOW,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      // Only this run's exact marked, open, ready PR that is merely unarmed
      // is the narrow unqualified state; everything else stays generic.
      expect(error instanceof UnqualifiedDeliveryError).toBe(unqualified);
    },
  );

  describe('a PR merged through protection before completion', () => {
    const merged = {
      state: 'closed',
      merged: true,
      merge_commit_sha: MERGE,
      auto_merge: null,
    };
    const noApproval = {
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    };
    const input = {
      run: RUN,
      task: TASK,
      repo: 'octo/example',
      number: 12,
      now: NOW,
    };

    it('settles with exact protected-merge proof and no review feedback, without an approval', async () => {
      expect(
        await readyDeliveryBinding(
          fixture({ pr: merged, review: noApproval }),
          input,
        ),
      ).toEqual({ ...BINDING, mergeCommit: MERGE, state: 'complete' });
    });

    it.each([
      {
        name: 'a failed protected rule suite',
        rules: new Response(null, { status: 502 }),
      },
      { name: 'a foreign attempt marker', body: '<!-- attempt-claim:old -->' },
      { name: 'a wrong PR number', number: 13 },
      { name: 'a missing merge commit', merge_commit_sha: null },
    ])(
      'stays a generic refusal for $name',
      async ({ name: _name, rules, review, body, number, ...extra }) => {
        const error = await readyDeliveryBinding(
          fixture({
            pr: {
              ...merged,
              ...extra,
              ...(body === undefined ? {} : { body }),
              ...(number === undefined ? {} : { number }),
            },
            review: review ?? noApproval,
            rules,
          }),
          input,
        ).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(UnqualifiedDeliveryError);
      },
    );
  });

  it('keeps unreadable PR evidence and a foreign target generic', async () => {
    const refused = fixture({ pr: { auto_merge: null } });
    const fetchImpl = (async () =>
      new Response(null, { status: 502 })) as typeof fetch;
    for (const attempt of [
      readyDeliveryBinding(
        { ...refused, fetchImpl },
        { run: RUN, task: TASK, repo: 'octo/example', number: 12, now: NOW },
      ),
      readyDeliveryBinding(refused, {
        run: RUN,
        task: TASK,
        repo: 'octo/other',
        number: 12,
        now: NOW,
      }),
    ]) {
      const error = await attempt.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnqualifiedDeliveryError);
    }
  });

  it('requests correction only for actual failed required checks or review feedback', async () => {
    expect(
      await observeGithubDelivery(
        fixture({
          checks: {
            total_count: 1,
            check_runs: [
              {
                name: 'Verify',
                head_sha: HEAD,
                status: 'completed',
                conclusion: 'failure',
              },
            ],
          },
        }),
        BINDING,
      ),
    ).toMatchObject({ kind: 'correction', head: HEAD });
    expect(
      await observeGithubDelivery(
        fixture({
          review: {
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [{ isResolved: false }],
            },
          },
        }),
        BINDING,
      ),
    ).toMatchObject({ kind: 'correction', head: HEAD });
  });

  it.each(['open'] as const)(
    'rebinds a changed %s head against the old fence before reading review or landing evidence',
    async (state) => {
      const deps = fixture({
        pr: {
          head: { sha: MERGE },
          merged: state === 'merged',
          state: state === 'merged' ? 'closed' : 'open',
          merge_commit_sha: state === 'merged' ? MERGE : null,
        },
        review: {
          headRefOid: MERGE,
          reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
        },
      });
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'revision',
        head: HEAD,
        newHead: MERGE,
      });
      expect(BINDING.head).toBe(HEAD);
      expect(deps.fetchImpl).not.toHaveBeenCalledWith(
        expect.stringContaining('/graphql'),
        expect.anything(),
      );
    },
  );

  it('ends monitoring at merge, including a moved head, without review or rule-suite reads', async () => {
    const deps = fixture({
      pr: {
        merged: true,
        state: 'closed',
        merge_commit_sha: MERGE,
        head: { sha: MERGE },
        body: 'edited after merge',
      },
    });
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'merged',
      head: HEAD,
      mergeCommit: MERGE,
    });
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('trusted GitHub intake correction authority', () => {
  it('requires current actor permission, original repository/provider intent, and a fresh exact binding', async () => {
    const task = {
      ...TASK,
      task: RUN.task,
      delivery: BINDING,
      work: {
        ...TASK.work,
        origin: { principal: 'github:collaborator', channel: 'github' },
      },
    } as Task;
    const deps = {
      tokens: { tokenFor: async () => 'test-token' },
      fetchImpl: vi.fn(async () =>
        Response.json({
          permission: 'write',
          role_name: 'write',
          user: { login: 'collaborator' },
        }),
      ) as unknown as typeof fetch,
    };
    const permission = await readGithubIntakePermission(deps, task, {
      ...RUN,
      pipeline: 'claude',
    });
    expect(permission).toBeDefined();
    expect(
      deliveryCorrectionAuthorized(
        task,
        { ...RUN, pipeline: 'claude' },
        permission,
      ),
    ).toBe(true);
    expect(
      deliveryCorrectionAuthorized(
        task,
        { ...RUN, pipeline: 'codex' },
        permission,
      ),
    ).toBe(false);
    expect(
      deliveryCorrectionAuthorized(
        { ...task, delivery: { ...BINDING, head: MERGE } },
        { ...RUN, pipeline: 'claude' },
        permission,
      ),
    ).toBe(false);
    expect(
      deliveryCorrectionAuthorized(
        task,
        { ...RUN, pipeline: 'claude' },
        { ...permission!, observedAt: Date.now() - 31_000 },
      ),
    ).toBe(false);
    const denied = {
      ...deps,
      fetchImpl: vi.fn(async () =>
        Response.json({
          permission: 'read',
          role_name: 'read',
          user: { login: 'collaborator' },
        }),
      ) as unknown as typeof fetch,
    };
    expect(
      await readGithubIntakePermission(denied, task, {
        ...RUN,
        pipeline: 'claude',
      }),
    ).toBeUndefined();
  });
});

describe('delivery correction composes accepted routing and temporary fallback', () => {
  afterEach(() => vi.unstubAllEnvs());
  function routedTask(): Task {
    return {
      ...TASK,
      task: RUN.task,
      delivery: { ...BINDING, runId: 'octo/example#7/r2' },
      work: {
        ...TASK.work,
        origin: { principal: 'github:collaborator', channel: 'github' },
      },
      providerRouting: {
        requestId: 'later-refused',
        requestedAt: NOW,
        actor: 'maintainer',
        requestedPipeline: 'opencode',
        effectivePipeline: 'codex',
        status: 'refused',
        acceptedGeneration: {
          runId: 'octo/example#7/r2',
          requestedAt: NOW,
          pipeline: 'codex',
        },
      },
    } as Task;
  }
  function actorPermission(permission = 'write') {
    return {
      tokens: { tokenFor: async () => 'test-token' },
      fetchImpl: vi.fn(async () =>
        Response.json({
          permission,
          role_name: permission,
          user: { login: 'collaborator' },
        }),
      ) as unknown as typeof fetch,
    };
  }
  it('authorizes current collaborator on accepted Codex intent while immutable Work remains Claude; current revocation refuses', async () => {
    vi.stubEnv('AGENT_LCARS_WORK_GRANTS', '[]');
    const task = routedTask();
    const run = { ...RUN, runId: 'octo/example#7/r2', pipeline: 'codex' };
    const current = await readGithubIntakePermission(
      actorPermission(),
      task,
      run,
    );
    expect(current).toBeDefined();
    expect(deliveryCorrectionAuthorized(task, run, current)).toBe(true);
    const revoked = await readGithubIntakePermission(
      actorPermission('read'),
      task,
      run,
    );
    expect(revoked).toBeUndefined();
    expect(deliveryCorrectionAuthorized(task, run, revoked)).toBe(false);
    expect(
      deliveryCorrectionAuthorized(
        {
          ...task,
          providerRouting: {
            ...task.providerRouting!,
            acceptedGeneration: {
              ...task.providerRouting!.acceptedGeneration!,
              runId: 'octo/example#7/r3',
            },
          },
        },
        run,
        current,
      ),
    ).toBe(false);
    expect(task.work).toEqual(routedTask().work);
  });
  it('allows temporary Claude execution only through its exact current fallback grant, leaving Codex intent unchanged', () => {
    const task = routedTask();
    const run = {
      ...RUN,
      runId: 'octo/example#7/r3',
      pipeline: 'claude',
      providerFallback: {
        principal: 'user:fallback',
        sourceRepository: 'octo/example',
        allowedPipelines: ['claude'],
        attemptedPipelines: ['codex', 'claude'],
        originalRunId: 'octo/example#7/r2',
        fromRunId: 'octo/example#7/r2',
        trigger: {
          reason: 'provider-limit' as const,
          failureRunId: 'octo/example#7/r2',
          limitedPipeline: 'codex',
        },
      },
    };
    const grant = {
      principal: 'user:fallback',
      subjects: ['github:maintainer'],
      pipelines: ['codex', 'claude'],
      scopes: ['work.operator'],
    };
    vi.stubEnv('AGENT_LCARS_WORK_GRANTS', JSON.stringify([grant]));
    expect(deliveryCorrectionAuthorized(task, run)).toBe(true);
    expect(
      deliveryCorrectionAuthorized(task, {
        ...run,
        providerFallback: {
          ...run.providerFallback,
          sourceRepository: 'octo/other',
        },
      }),
    ).toBe(false);
    expect(
      deliveryCorrectionAuthorized(task, {
        ...run,
        providerFallback: undefined,
      }),
    ).toBe(false);
    vi.stubEnv(
      'AGENT_LCARS_WORK_GRANTS',
      JSON.stringify([{ ...grant, scopes: ['work.reader'] }]),
    );
    expect(deliveryCorrectionAuthorized(task, run)).toBe(false);
    vi.stubEnv(
      'AGENT_LCARS_WORK_GRANTS',
      JSON.stringify([{ ...grant, pipelines: ['codex'] }]),
    );
    expect(deliveryCorrectionAuthorized(task, run)).toBe(false);
    expect(task.providerRouting?.acceptedGeneration?.pipeline).toBe('codex');
    expect((task.work.spec as { pipeline: string }).pipeline).toBe('claude');
  });
});

describe('minted delivery permission and current CI boundaries', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  function mintedFixture(dedicated: boolean, merged = false) {
    const base = fixture({
      pr: merged ? { merged: true, merge_commit_sha: MERGE } : {},
    });
    let permissions: Record<string, string> = {};
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith('/installation')) return Response.json({ id: 123 });
        if (path.endsWith('/access_tokens')) {
          permissions = JSON.parse(String(init?.body)).permissions;
          return Response.json(
            {
              token: 'mock-installation-token',
              expires_at: new Date(Date.now() + 3600000).toISOString(),
            },
            { status: 201 },
          );
        }
        if (
          new Headers(init?.headers).get('authorization') !==
          'Bearer mock-installation-token'
        )
          return Response.json({}, { status: 401 });
        // GitHub's real shape: HTTP 200, the review commit nulled, and a
        // FORBIDDEN error naming that field.
        if (path.endsWith('/graphql') && permissions.contents !== 'read') {
          const body = await (await base.fetchImpl(input, init)).json();
          for (const node of body.data.repository.pullRequest.reviews.nodes)
            node.commit = null;
          return Response.json({
            ...body,
            errors: [
              {
                type: 'FORBIDDEN',
                path: [
                  'repository',
                  'pullRequest',
                  'reviews',
                  'nodes',
                  0,
                  'commit',
                ],
                message: 'Resource not accessible by integration',
              },
            ],
          });
        }
        if (
          (path.includes('/check-runs') && permissions.checks !== 'read') ||
          path.includes('/status?')
        )
          return Response.json({}, { status: 403 });
        return base.fetchImpl(input, init);
      },
    );
    const tokens = new AppInstallationTokenProvider({
      clientId: 'Iv1.mock-test',
      privateKeyPem: privateKey,
      ...(dedicated ? { permissions: ORCHESTRATOR_GITHUB_PERMISSIONS } : {}),
      fetchImpl: fetchImpl as typeof fetch,
    });
    return {
      tokens,
      fetchImpl: fetchImpl as typeof fetch,
      permission: () => permissions,
      calls: fetchImpl,
    };
  }
  it('ends monitoring at merge with the narrow default token', async () => {
    expect(
      (await observeGithubDelivery(mintedFixture(false, true), BINDING)).kind,
    ).toBe('merged');
  });
  it('mints existing declared delivery reads while default remains narrow', async () => {
    const merged = false;
    const scoped = mintedFixture(true, merged);
    expect((await observeGithubDelivery(scoped, BINDING)).kind).toBe('waiting');
    expect(scoped.permission()).toEqual({
      actions: 'write',
      issues: 'write',
      pull_requests: 'write',
      checks: 'read',
      contents: 'read',
    });
    expect(
      scoped.calls.mock.calls.some(([url]) => String(url).includes('/status?')),
    ).toBe(false);
    const ordinary = mintedFixture(false, merged);
    await expect(observeGithubDelivery(ordinary, BINDING)).rejects.toThrow(
      'Delivery revision or review evidence changed',
    );
    expect(ordinary.permission()).toEqual({
      actions: 'write',
      issues: 'write',
      pull_requests: 'write',
    });
  });
  it.each(['queued', 'success', 'failure'] as const)(
    'ignores cancelled draft wrappers when current ready CI is %s',
    async (state) => {
      const currentConclusion = state === 'queued' ? null : state;
      const checks = ['Verify', 'E2E'].flatMap((name, i) => [
        {
          id: i + 1,
          check_suite: { id: 1 },
          name,
          head_sha: HEAD,
          status: 'completed',
          conclusion: 'failure',
        },
        {
          id: i + 11,
          check_suite: { id: 2 },
          name,
          head_sha: HEAD,
          status: state === 'queued' ? 'queued' : 'completed',
          conclusion: currentConclusion,
        },
      ]);
      const deps = fixture({
        checks: { total_count: 4, check_runs: checks },
        rules: [
          { type: 'pull_request' },
          {
            type: 'required_status_checks',
            parameters: {
              required_status_checks: [
                { context: 'Verify' },
                { context: 'E2E' },
              ],
            },
          },
        ],
        workflows: {
          total_count: 2,
          workflow_runs: [
            {
              id: 90,
              workflow_id: 10,
              run_number: 1,
              run_attempt: 1,
              head_sha: HEAD,
              check_suite_id: 1,
              event: 'pull_request',
              conclusion: 'cancelled',
            },
            {
              id: 100,
              workflow_id: 10,
              run_number: 2,
              run_attempt: 1,
              head_sha: HEAD,
              check_suite_id: 2,
              event: 'pull_request',
              conclusion: currentConclusion,
            },
          ],
        },
        jobs: {
          total_count: 2,
          jobs: checks
            .filter((check) => check.check_suite.id === 2)
            .map((check) => ({
              run_id: 100,
              run_attempt: 1,
              head_sha: HEAD,
              check_run_url: `https://api.github.com/repos/octo/example/check-runs/${check.id}`,
              status: check.status,
              conclusion: check.conclusion,
            })),
        },
      });
      const observation = await observeGithubDelivery(deps, BINDING);
      expect(observation.kind).toBe(
        state === 'failure' ? 'correction' : 'waiting',
      );
      const store = new MemoryStore();
      const controller = new Orchestrator(store, { now: () => NOW });
      const run = decidedRun(
        await controller.request({
          taskId: { repo: 'octo/example', issue: 7 },
          requestId: 'first',
          work: TASK.work,
          pipeline: 'claude',
          params: { mode: 'implement' },
        }),
      );
      await store.enqueueRun({ runId: run.runId, now: NOW });
      await controller.confirmDispatch(run.runId);
      const claim = 'c'.repeat(64);
      await store.claimQueuedRun({
        pipelines: ['claude'],
        now: NOW,
        claimedBy: 'runner',
        claimedBySubject: 'executor@example.com',
        tokenHash: claim,
      });
      expect(
        isRefusal(
          await controller.report(
            run.runId,
            {
              ok: true,
              summary: 'pull-request',
              ref: 'https://github.com/octo/example/pull/12',
            },
            claim,
            undefined,
            undefined,
            BINDING,
          ),
        ),
      ).toBe(false);
      await controller.observeDelivery(run.runId, observation, () => true);
      await controller.observeDelivery(
        run.runId,
        await observeGithubDelivery(deps, BINDING),
        () => true,
      );
      expect((await store.readTask(run.task))?.task.runCount).toBe(
        state === 'failure' ? 2 : 1,
      );
    },
  );
  it('retains unknown legacy status contexts without blocking current review feedback', async () => {
    const rules = [
      { type: 'pull_request' },
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: 'Verify' },
            { context: 'Legacy' },
          ],
        },
      },
    ];
    const waiting = fixture({ rules });
    expect((await observeGithubDelivery(waiting, BINDING)).kind).toBe(
      'waiting',
    );
    const feedback = fixture({
      rules,
      review: {
        reviewThreads: {
          pageInfo: { hasNextPage: false },
          nodes: [{ isResolved: false, isOutdated: false }],
        },
      },
    });
    expect((await observeGithubDelivery(feedback, BINDING)).kind).toBe(
      'correction',
    );
    expect(
      vi
        .mocked(feedback.fetchImpl)
        .mock.calls.some(([url]) => String(url).includes('/status?')),
    ).toBe(false);
  });
});

describe('maintainer withdrawal of ready delivery', () => {
  it('releases ownership of a PR closed without merging', async () => {
    const deps = fixture({ pr: { state: 'closed' } });
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'withdrawn',
      head: HEAD,
    });
    expect(vi.mocked(deps.fetchImpl).mock.calls).toHaveLength(1);
  });
  it('releases ownership of a PR merged into another branch without delivering it', async () => {
    const deps = fixture({
      pr: {
        state: 'closed',
        merged: true,
        merge_commit_sha: MERGE,
        base: { ref: 'release' },
      },
    });
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'withdrawn',
      head: HEAD,
    });
  });
  it('never treats a merge awaiting its merge commit as withdrawn', async () => {
    const deps = fixture({
      pr: { state: 'closed', merged: true, merge_commit_sha: null },
    });
    expect(await observeGithubDelivery(deps, BINDING)).not.toMatchObject({
      kind: 'withdrawn',
    });
  });
  it.each([
    { draft: true },
    { auto_merge: null },
    { auto_merge: { merge_method: 'merge' } },
  ])('retains ownership without correcting withdrawn PR %j', async (pr) => {
    const deps = fixture({
      pr,
      checks: {
        total_count: 1,
        check_runs: [
          {
            id: 1,
            check_suite: { id: 1 },
            name: 'Verify',
            head_sha: HEAD,
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
    });
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'waiting',
      head: HEAD,
    });
    expect(vi.mocked(deps.fetchImpl).mock.calls).toHaveLength(1);
  });
});

describe('current review and protected landing evidence', () => {
  const merged = { merged: true, state: 'closed', merge_commit_sha: MERGE };
  const approved = {
    state: 'APPROVED',
    author: { login: 'reviewer' },
    commit: { oid: HEAD },
  };
  it.each([
    ['missing', []],
    ['self', [{ ...approved, author: { login: 'author' } }]],
    ['stale', [{ ...approved, commit: { oid: MERGE } }]],
  ] as const)(
    'settles unchanged-head protected landing without a current %s approval',
    async (_cause, nodes) => {
      const deps = fixture({
        pr: merged,
        review: { reviews: { pageInfo: { hasPreviousPage: false }, nodes } },
      });
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'merged',
        head: HEAD,
        mergeCommit: MERGE,
      });
    },
  );

  it.each([
    {
      reviews: {
        pageInfo: { hasPreviousPage: false },
        nodes: [{ ...approved, state: 'CHANGES_REQUESTED' }],
      },
    },
    {
      reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [{ isResolved: false }],
      },
    },
  ])('retains actionable same-head negative feedback: %j', async (review) => {
    expect(await observeGithubDelivery(fixture({ review }), BINDING)).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Review feedback requires correction',
    });
  });
});

describe('complete applicable protected-check policy', () => {
  const rule = (context: string) => ({
    type: 'required_status_checks',
    parameters: { required_status_checks: [{ context }] },
  });
  const checks = {
    total_count: 2,
    check_runs: [
      {
        name: 'Verify',
        head_sha: HEAD,
        status: 'completed',
        conclusion: 'success',
      },
      {
        name: 'Browser',
        head_sha: HEAD,
        status: 'completed',
        conclusion: 'failure',
      },
    ],
  };
  const fullPage = (required: string) => [
    { type: 'pull_request' },
    rule(required),
    ...Array.from({ length: 98 }, () => ({ type: 'required_linear_history' })),
  ];
  it('requests correction for failure from a second applicable required-check rule', async () => {
    expect(
      await observeGithubDelivery(
        fixture({
          rules: [{ type: 'pull_request' }, rule('Verify'), rule('Browser')],
          checks,
        }),
        BINDING,
      ),
    ).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Required checks failed: Browser',
    });
  });
  it('reads later branch-rule pages before requesting the current required-check correction', async () => {
    const deps = fixture({
      rulePages: { 1: fullPage('Verify'), 2: [rule('Browser')] },
      checks,
    });
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Required checks failed: Browser',
    });
    const paths = vi
      .mocked(deps.fetchImpl)
      .mock.calls.map(([input]) => String(input))
      .filter((path) => path.includes('/rules/branches/'));
    expect(paths).toEqual([
      'https://api.github.com/repos/octo/example/rules/branches/main?per_page=100&page=1',
      'https://api.github.com/repos/octo/example/rules/branches/main?per_page=100&page=2',
    ]);
  });
  it('reports one current failure when multiple applicable rules require the same context', async () => {
    expect(
      await observeGithubDelivery(
        fixture({
          rules: [
            { type: 'pull_request' },
            rule('Verify'),
            rule('Browser'),
            rule('Browser'),
          ],
          checks,
        }),
        BINDING,
      ),
    ).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Required checks failed: Browser',
    });
  });
  it('retains unknown when ten full branch-rule pages do not establish exhaustion', async () => {
    const rulePages = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        index + 1,
        fullPage('Browser'),
      ]),
    );
    const deps = fixture({ rulePages, checks });
    await expect(observeGithubDelivery(deps, BINDING)).rejects.toThrow(
      'truncated',
    );
    const paths = vi
      .mocked(deps.fetchImpl)
      .mock.calls.map(([input]) => String(input))
      .filter((path) => path.includes('/rules/branches/'));
    expect(paths).toHaveLength(10);
    expect(paths.at(-1)).toContain('per_page=100&page=10');
  });
  it('retains unknown instead of correcting with malformed later-page policy', async () => {
    const deps = fixture({
      rulePages: { 1: fullPage('Browser'), 2: { invalid: true } },
      checks,
    });
    await expect(observeGithubDelivery(deps, BINDING)).rejects.toThrow();
  });
  it('retains unknown instead of correcting after a later policy read is refused', async () => {
    const deps = fixture({
      rulePages: {
        1: fullPage('Browser'),
        2: new Response('refused', { status: 403 }),
      },
      checks,
    });
    await expect(observeGithubDelivery(deps, BINDING)).rejects.toThrow(
      'Delivery read refused (403)',
    );
  });
  it('retains unknown for a complete policy without required contexts', async () => {
    const deps = fixture({
      rules: [
        { type: 'pull_request' },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [] },
        },
      ],
      checks,
    });
    await expect(observeGithubDelivery(deps, BINDING)).rejects.toThrow();
  });
});

describe('current required blocking check conclusions', () => {
  it.each([
    'failure',
    'timed_out',
    'action_required',
    'cancelled',
    'startup_failure',
    'stale',
  ])(
    'requests correction for a current Actions job ending %s',
    async (conclusion) => {
      const deps = fixture({
        checks: {
          total_count: 1,
          check_runs: [
            {
              id: 1,
              check_suite: { id: 1 },
              name: 'Verify',
              head_sha: HEAD,
              status: 'completed',
              conclusion,
            },
          ],
        },
      });
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'correction',
        head: HEAD,
        reason: 'Required checks failed: Verify',
      });
    },
  );

  it.each(['success', 'skipped', 'neutral', null, 'unknown'])(
    'retains waiting for nonblocking or unknown Actions conclusion %s',
    async (conclusion) => {
      const deps = fixture({
        checks: {
          total_count: 1,
          check_runs: [
            {
              id: 1,
              check_suite: { id: 1 },
              name: 'Verify',
              head_sha: HEAD,
              status: 'completed',
              conclusion,
            },
          ],
        },
      });
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'waiting',
        head: HEAD,
      });
    },
  );

  it('retains waiting when the latest parent workflow was intentionally cancelled', async () => {
    const deps = fixture({
      checks: {
        total_count: 1,
        check_runs: [
          {
            id: 1,
            check_suite: { id: 1 },
            name: 'Verify',
            head_sha: HEAD,
            status: 'completed',
            conclusion: 'cancelled',
          },
        ],
      },
      workflows: {
        total_count: 1,
        workflow_runs: [
          {
            id: 100,
            workflow_id: 10,
            run_number: 2,
            run_attempt: 1,
            head_sha: HEAD,
            check_suite_id: 1,
            event: 'pull_request',
            conclusion: 'cancelled',
          },
        ],
      },
    });
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'waiting',
      head: HEAD,
    });
    expect(
      vi
        .mocked(deps.fetchImpl)
        .mock.calls.some(([input]) => String(input).includes('/attempts/')),
    ).toBe(false);
  });
});

describe('required non-Actions check provenance', () => {
  const APP = { id: 77, slug: 'coverage-app' };
  const CHECK = {
    id: 20,
    check_suite: { id: 7 },
    app: APP,
    name: 'Coverage',
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'failure',
  };
  const SUITE = {
    id: 7,
    app: APP,
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'failure',
  };
  function external(
    over: {
      suite?: unknown;
      latest?: unknown;
      integration?: number | null;
      check?: typeof CHECK;
    } = {},
  ) {
    const base = fixture({
      rules: [
        { type: 'pull_request' },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              {
                context: 'Coverage',
                integration_id:
                  over.integration === undefined ? 77 : over.integration,
              },
            ],
          },
        },
      ],
      checks: { total_count: 1, check_runs: [over.check ?? CHECK] },
      workflows: { total_count: 0, workflow_runs: [] },
    });
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith('/check-suites/7')) {
          const suite = over.suite ?? SUITE;
          return suite instanceof Response ? suite : Response.json(suite);
        }
        if (
          path.includes('/check-runs?') &&
          new URL(path).searchParams.has('app_id')
        ) {
          const latest = over.latest ?? {
            total_count: 1,
            check_runs: [over.check ?? CHECK],
          };
          return latest instanceof Response ? latest : Response.json(latest);
        }
        return base.fetchImpl(input, init);
      },
    );
    return { ...base, fetchImpl: fetchImpl as unknown as typeof fetch };
  }
  it('requests correction for a current required failure from its configured non-Actions App', async () => {
    const deps = external();
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Required checks failed: Coverage',
    });
    expect(
      vi.mocked(deps.fetchImpl).mock.calls.map(([input]) => String(input)),
    ).toContain(
      `https://api.github.com/repos/octo/example/commits/${HEAD}/check-runs?per_page=100&filter=latest&app_id=77&check_name=Coverage`,
    );
    expect(
      vi
        .mocked(deps.fetchImpl)
        .mock.calls.some(([input]) => String(input).includes('/actions/runs')),
    ).toBe(false);
  });
  it.each([
    'failure',
    'timed_out',
    'action_required',
    'cancelled',
    'startup_failure',
    'stale',
  ])(
    'requests correction for a current required external App ending %s',
    async (conclusion) => {
      const deps = external({
        check: { ...CHECK, conclusion },
        suite: { ...SUITE, conclusion },
      });
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'correction',
        head: HEAD,
        reason: 'Required checks failed: Coverage',
      });
    },
  );

  it.each(['success', 'skipped', 'neutral', null, 'unknown'])(
    'retains waiting for nonblocking or unknown external App conclusion %s',
    async (conclusion) => {
      const deps = external({
        latest: { total_count: 1, check_runs: [{ ...CHECK, conclusion }] },
      });
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'waiting',
        head: HEAD,
      });
    },
  );

  it.each(['success', 'skipped', 'neutral', null, 'unknown'])(
    'retains waiting when the external suite has nonblocking or unknown conclusion %s',
    async (conclusion) => {
      const deps = external({ suite: { ...SUITE, conclusion } });
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'waiting',
        head: HEAD,
      });
    },
  );

  it('qualifies an unpinned required context through its exact non-Actions App and suite', async () => {
    expect(
      await observeGithubDelivery(external({ integration: null }), BINDING),
    ).toMatchObject({
      kind: 'correction',
      head: HEAD,
      reason: 'Required checks failed: Coverage',
    });
  });
  it('does not substitute an Actions failure for a context pinned to another App', async () => {
    const deps = fixture({
      rules: [
        { type: 'pull_request' },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [{ context: 'Verify', integration_id: 77 }],
          },
        },
      ],
      checks: {
        total_count: 1,
        check_runs: [
          {
            id: 20,
            check_suite: { id: 1 },
            app: { id: 15368, slug: 'github-actions' },
            name: 'Verify',
            head_sha: HEAD,
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
    });
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'waiting',
      head: HEAD,
    });
  });
  it.each([
    { id: 21, status: 'queued', conclusion: null },
    { id: 21, status: 'completed', conclusion: 'success' },
  ])(
    'retains ownership when the provider current check supersedes the failed candidate: %j',
    async (latest) => {
      expect(
        await observeGithubDelivery(
          external({
            latest: { total_count: 1, check_runs: [{ ...CHECK, ...latest }] },
          }),
          BINDING,
        ),
      ).toEqual({ kind: 'waiting', head: HEAD });
    },
  );
  it.each([
    { id: 8 },
    { head_sha: MERGE },
    { app: { id: 78, slug: 'other-app' } },
    { status: 'in_progress', conclusion: null },
    { conclusion: 'success' },
  ])(
    'retains unknown for stale, wrong-App, pending or successful suite evidence: %j',
    async (suite) => {
      expect(
        await observeGithubDelivery(
          external({ suite: { ...SUITE, ...suite } }),
          BINDING,
        ),
      ).toEqual({ kind: 'waiting', head: HEAD });
    },
  );
  it('retains unknown for competing current check identities', async () => {
    expect(
      await observeGithubDelivery(
        external({
          latest: {
            total_count: 2,
            check_runs: [
              CHECK,
              { ...CHECK, id: 21, status: 'queued', conclusion: null },
            ],
          },
        }),
        BINDING,
      ),
    ).toEqual({ kind: 'waiting', head: HEAD });
  });
  it('retains unknown for a truncated provider current-check read', async () => {
    expect(
      await observeGithubDelivery(
        external({ latest: { total_count: 2, check_runs: [CHECK] } }),
        BINDING,
      ),
    ).toEqual({ kind: 'waiting', head: HEAD });
  });
  it('retains unknown for refused provider evidence without treating the App as Actions', async () => {
    expect(
      await observeGithubDelivery(
        external({ latest: new Response('refused', { status: 403 }) }),
        BINDING,
      ),
    ).toEqual({ kind: 'waiting', head: HEAD });
  });
  it('retains unknown for malformed provider evidence', async () => {
    expect(
      await observeGithubDelivery(
        external({ suite: { invalid: true } }),
        BINDING,
      ),
    ).toEqual({ kind: 'waiting', head: HEAD });
  });
});

describe('complete current check-run discovery', () => {
  const APP = { id: 77, slug: 'coverage-app' };
  const FAILED = {
    id: 20,
    check_suite: { id: 1 },
    name: 'Verify',
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'failure',
  };
  function paged(
    options: {
      external?: boolean;
      count?: number;
      firstFailure?: boolean;
      second?: unknown;
      missingIdentity?: boolean;
    } = {},
  ) {
    const required = {
      ...(options.external
        ? { ...FAILED, name: 'Coverage', app: APP, check_suite: { id: 7 } }
        : FAILED),
      id: options.missingIdentity ? undefined : FAILED.id,
    };
    const count = options.count ?? 101;
    const rows = Array.from(
      { length: count },
      (_, index) =>
        ({
          id: 1000 + index,
          check_suite: { id: 9 },
          name: `Unrelated ${index}`,
          head_sha: HEAD,
          status: 'completed',
          conclusion: 'success',
        }) as Record<string, unknown>,
    );
    rows[options.firstFailure ? 0 : count - 1] = required;
    const base = fixture({
      rules: [
        { type: 'pull_request' },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              {
                context: required.name,
                integration_id: options.external ? 77 : null,
              },
            ],
          },
        },
      ],
      checks: { total_count: count, check_runs: rows },
      jobs: {
        total_count: 1,
        jobs: [
          {
            run_id: 100,
            head_sha: HEAD,
            check_run_url:
              'https://api.github.com/repos/octo/example/check-runs/20',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
    });
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const url = new URL(path);
        if (path.includes('/commits/') && path.includes('/check-runs?')) {
          if (url.searchParams.has('app_id'))
            return Response.json({ total_count: 1, check_runs: [required] });
          const page = Number(url.searchParams.get('page') ?? '1');
          const size = Number(url.searchParams.get('per_page') ?? '30');
          const data =
            page === 2 && options.second !== undefined
              ? options.second
              : {
                  total_count: count,
                  check_runs: rows.slice((page - 1) * size, page * size),
                };
          return data instanceof Response ? data : Response.json(data);
        }
        if (path.endsWith('/check-suites/7'))
          return Response.json({
            id: 7,
            app: APP,
            head_sha: HEAD,
            status: 'completed',
            conclusion: 'failure',
          });
        return base.fetchImpl(input, init);
      },
    );
    return { ...base, fetchImpl: fetchImpl as unknown as typeof fetch, rows };
  }
  it('finds a current required Actions failure after the first 100 unrelated check runs', async () => {
    const deps = paged();
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Required checks failed: Verify',
    });
    expect(deps.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('filter=latest&page=2'),
      expect.anything(),
    );
  });
  it('finds a configured external-App failure after the first 100 unrelated check runs', async () => {
    expect(
      await observeGithubDelivery(paged({ external: true }), BINDING),
    ).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Required checks failed: Coverage',
    });
  });
  it.each([
    { external: false, label: 'Actions' },
    { external: true, label: 'external App' },
  ])(
    'retains legacy waiting for a $label candidate without immutable check identity',
    async ({ external }) => {
      expect(
        await observeGithubDelivery(
          paged({ external, count: 1, missingIdentity: true }),
          BINDING,
        ),
      ).toEqual({ kind: 'waiting', head: HEAD });
    },
  );
  it('completes a full final page against the authoritative total without reading an extra page', async () => {
    const deps = paged({ count: 200 });
    expect(await observeGithubDelivery(deps, BINDING)).toMatchObject({
      kind: 'correction',
    });
    expect(deps.fetchImpl).not.toHaveBeenCalledWith(
      expect.stringContaining('page=3'),
      expect.anything(),
    );
  });
  it('retains unknown at the ten-page cap without classifying an earlier required failure', async () => {
    const deps = paged({ count: 1001, firstFailure: true });
    await expect(observeGithubDelivery(deps, BINDING)).rejects.toThrow();
    expect(deps.fetchImpl).not.toHaveBeenCalledWith(
      expect.stringContaining('page=11'),
      expect.anything(),
    );
    expect(
      vi
        .mocked(deps.fetchImpl)
        .mock.calls.some(([url]) => String(url).includes('/actions/runs')),
    ).toBe(false);
  });
  it('retains unknown when a later page is refused', async () => {
    const deps = paged({
      firstFailure: true,
      second: new Response('refused', { status: 403 }),
    });
    await expect(observeGithubDelivery(deps, BINDING)).rejects.toThrow();
    expect(
      vi
        .mocked(deps.fetchImpl)
        .mock.calls.some(([url]) => String(url).includes('/actions/runs')),
    ).toBe(false);
  });
  it('retains unknown when the total changes between pages', async () => {
    const deps = paged({ second: { total_count: 102, check_runs: [FAILED] } });
    await expect(observeGithubDelivery(deps, BINDING)).rejects.toThrow();
  });
  it('retains unknown when repeated check identities mask a missing page', async () => {
    const deps = paged({ count: 200 });
    const first = deps.rows.slice(0, 100);
    const duplicate = paged({
      count: 200,
      second: { total_count: 200, check_runs: first },
    });
    await expect(observeGithubDelivery(duplicate, BINDING)).rejects.toThrow();
  });
});

describe('complete Actions provenance discovery', () => {
  const CURRENT = {
    id: 100,
    workflow_id: 10,
    run_number: 2,
    run_attempt: 1,
    head_sha: HEAD,
    check_suite_id: 1,
    event: 'pull_request',
    conclusion: null,
  };
  const FAILED_JOB = {
    run_id: 100,
    run_attempt: 1,
    head_sha: HEAD,
    check_run_url: 'https://api.github.com/repos/octo/example/check-runs/20',
    status: 'completed',
    conclusion: 'failure',
  };
  function paged(
    kind: 'workflows' | 'jobs' | 'both',
    options: {
      count?: number;
      second?: unknown;
      firstFailure?: boolean;
    } = {},
  ) {
    const count = options.count ?? 101;
    const workflows = Array.from(
      { length: count },
      (_, index) =>
        ({
          ...CURRENT,
          id: 1000 + index,
          workflow_id: 1000 + index,
          check_suite_id: 1000 + index,
          conclusion: 'success',
        }) as Record<string, unknown>,
    );
    workflows[options.firstFailure ? 0 : count - 1] = CURRENT;
    const jobs = Array.from(
      { length: count },
      (_, index) =>
        ({
          ...FAILED_JOB,
          check_run_url: `https://api.github.com/repos/octo/example/check-runs/${1000 + index}`,
          conclusion: 'success',
        }) as Record<string, unknown>,
    );
    jobs[options.firstFailure ? 0 : count - 1] = FAILED_JOB;
    const base = fixture({
      checks: {
        total_count: 1,
        check_runs: [
          {
            id: 20,
            check_suite: { id: 1 },
            name: 'Verify',
            head_sha: HEAD,
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
    });
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const url = new URL(path);
        const workflow = path.includes('/actions/runs?') && kind !== 'jobs';
        const job = path.includes('/attempts/') && kind !== 'workflows';
        if (workflow || job) {
          const rows = workflow ? workflows : jobs;
          const field = workflow ? 'workflow_runs' : 'jobs';
          const page = Number(url.searchParams.get('page') ?? '1');
          const size = Number(url.searchParams.get('per_page') ?? '30');
          const over = options.second;
          const data =
            page === 2 && over !== undefined
              ? over
              : {
                  total_count: count,
                  [field]: rows.slice((page - 1) * size, page * size),
                };
          return data instanceof Response ? data : Response.json(data);
        }
        return base.fetchImpl(input, init);
      },
    );
    return {
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      workflows,
      jobs,
    };
  }
  it.each(['workflows', 'jobs', 'both'] as const)(
    'qualifies a current failure beyond 100 %s records without losing the attempt fence',
    async (kind) => {
      const deps = paged(kind);
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'correction',
        head: HEAD,
        reason: 'Required checks failed: Verify',
      });
      expect(deps.fetchImpl).toHaveBeenCalledWith(
        expect.stringContaining('page=2'),
        expect.anything(),
      );
    },
  );
  it.each(['workflows', 'jobs'] as const)(
    'retains unknown when the %s read exceeds ten pages',
    async (kind) => {
      const deps = paged(kind, { count: 1001, firstFailure: true });
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'waiting',
        head: HEAD,
      });
      expect(deps.fetchImpl).not.toHaveBeenCalledWith(
        expect.stringContaining('page=11'),
        expect.anything(),
      );
    },
  );
  it.each(['workflows', 'jobs'] as const)(
    'retains unknown when a later %s page is refused',
    async (kind) => {
      expect(
        await observeGithubDelivery(
          paged(kind, { second: new Response('refused', { status: 403 }) }),
          BINDING,
        ),
      ).toEqual({ kind: 'waiting', head: HEAD });
    },
  );
  it.each(['workflows', 'jobs'] as const)(
    'retains unknown when the %s total changes between pages',
    async (kind) => {
      const field = kind === 'workflows' ? 'workflow_runs' : 'jobs';
      const record = kind === 'workflows' ? CURRENT : FAILED_JOB;
      expect(
        await observeGithubDelivery(
          paged(kind, { second: { total_count: 102, [field]: [record] } }),
          BINDING,
        ),
      ).toEqual({ kind: 'waiting', head: HEAD });
    },
  );
  it.each(['workflows', 'jobs'] as const)(
    'retains unknown for repeated %s identities across pages',
    async (kind) => {
      const base = paged(kind, { count: 200 });
      const rows = kind === 'workflows' ? base.workflows : base.jobs;
      const field = kind === 'workflows' ? 'workflow_runs' : 'jobs';
      expect(
        await observeGithubDelivery(
          paged(kind, {
            count: 200,
            second: { total_count: 200, [field]: rows.slice(0, 100) },
          }),
          BINDING,
        ),
      ).toEqual({ kind: 'waiting', head: HEAD });
    },
  );
});

describe('same-head review feedback before unavailable check evidence', () => {
  const cases = ['refused rules', 'refused checks', 'bounded checks'] as const;
  const changesRequested = {
    reviews: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        {
          state: 'CHANGES_REQUESTED',
          author: { login: 'reviewer' },
          commit: { oid: HEAD },
        },
      ],
    },
  };
  const unresolved = {
    reviewThreads: {
      pageInfo: { hasNextPage: false },
      nodes: [{ isResolved: false }],
    },
  };
  function unavailableEvidence(
    cause: (typeof cases)[number],
    review?: object,
    pr?: object,
  ) {
    const base = fixture({ review, pr });
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url);
        if (cause === 'refused rules' && path.includes('/rules/branches/'))
          return new Response('forbidden', { status: 403 });
        if (path.includes('/check-runs')) {
          if (cause === 'refused checks')
            return new Response('forbidden', { status: 403 });
          if (cause === 'bounded checks') {
            const page = Number(new URL(path).searchParams.get('page'));
            return Response.json({
              total_count: 1001,
              check_runs: Array.from({ length: 100 }, (_, i) => ({
                id: (page - 1) * 100 + i + 1,
                name: 'Verify',
                head_sha: HEAD,
                status: 'queued',
                conclusion: null,
              })),
            });
          }
        }
        return base.fetchImpl(url, init);
      },
    );
    return { ...base, fetchImpl: fetchImpl as unknown as typeof fetch };
  }
  it.each(cases)('corrects change requests before %s', async (cause) => {
    const deps = unavailableEvidence(cause, changesRequested);
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Review feedback requires correction',
    });
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each(cases)('corrects unresolved review before %s', async (cause) => {
    const deps = unavailableEvidence(cause, unresolved);
    expect(await observeGithubDelivery(deps, BINDING)).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Review feedback requires correction',
    });
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each(cases)(
    'keeps unavailable %s unknown without review feedback',
    async (cause) => {
      await expect(
        observeGithubDelivery(unavailableEvidence(cause), BINDING),
      ).rejects.toThrow();
    },
  );
  it('rebinds a changed head before reading actionable old-head feedback', async () => {
    expect(
      await observeGithubDelivery(
        unavailableEvidence(
          'refused checks',
          { ...changesRequested, headRefOid: MERGE },
          {
            head: { sha: MERGE },
          },
        ),
        BINDING,
      ),
    ).toEqual({ kind: 'revision', head: HEAD, newHead: MERGE });
  });
  it.each([{ draft: true }, { auto_merge: null }])(
    'retains withdrawn PR waiting before review feedback: %j',
    async (pr) => {
      const deps = unavailableEvidence('refused checks', unresolved, pr);
      expect(await observeGithubDelivery(deps, BINDING)).toEqual({
        kind: 'waiting',
        head: HEAD,
      });
      expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
});

describe('nullable historical review identities', () => {
  const valid = {
    state: 'APPROVED',
    author: { login: 'reviewer' },
    commit: { oid: HEAD },
  };
  const history = [
    { state: 'APPROVED', author: null, commit: { oid: HEAD } },
    { state: 'CHANGES_REQUESTED', author: { login: 'gone' }, commit: null },
    { state: 'DISMISSED', author: null, commit: null },
  ];
  const review = (nodes: object[]) => ({
    reviews: { pageInfo: { hasPreviousPage: false }, nodes },
  });
  it('accepts an exact-head handoff despite nullable historical identities', async () => {
    expect(
      await readyDeliveryBinding(
        fixture({ review: review([...history, valid]) }),
        { run: RUN, task: TASK, repo: 'octo/example', number: 12, now: NOW },
      ),
    ).toMatchObject({ head: HEAD, state: 'waiting' });
  });
  it('qualifies protected landing with valid exact-head review beside nullable history', async () => {
    expect(
      await observeGithubDelivery(
        fixture({
          pr: { merged: true, merge_commit_sha: MERGE },
          review: review([valid, ...history]),
        }),
        BINDING,
      ),
    ).toEqual({ kind: 'merged', head: HEAD, mergeCommit: MERGE });
  });
  it('never treats nullable-only identities as review feedback', async () => {
    expect(
      await readyDeliveryBinding(
        fixture({
          pr: {
            state: 'closed',
            merged: true,
            merge_commit_sha: MERGE,
            auto_merge: null,
          },
          review: review(history),
        }),
        {
          run: RUN,
          task: TASK,
          repo: 'octo/example',
          number: 12,
          now: NOW,
        },
      ),
    ).toEqual({ ...BINDING, mergeCommit: MERGE, state: 'complete' });
    expect(
      await observeGithubDelivery(
        fixture({
          pr: { merged: true, merge_commit_sha: MERGE },
          review: review(history),
        }),
        BINDING,
      ),
    ).toEqual({ kind: 'merged', head: HEAD, mergeCommit: MERGE });
  });
  it('retains valid reviewer change requests beside nullable history', async () => {
    const nodes = [valid, ...history, { ...valid, state: 'CHANGES_REQUESTED' }];
    expect(
      await observeGithubDelivery(fixture({ review: review(nodes) }), BINDING),
    ).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Review feedback requires correction',
    });
  });
  it('keeps unresolved threads actionable beside nullable history', async () => {
    expect(
      await observeGithubDelivery(
        fixture({
          review: {
            ...review([...history, valid]),
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [{ isResolved: false }],
            },
          },
        }),
        BINDING,
      ),
    ).toEqual({
      kind: 'correction',
      head: HEAD,
      reason: 'Review feedback requires correction',
    });
  });
});
