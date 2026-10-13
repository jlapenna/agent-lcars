// @vitest-environment node

import { generateKeyPairSync } from 'node:crypto';

import {
  MemoryStore,
  Orchestrator,
  decidedRun,
  isRefusal,
  type DeliveryBinding,
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
  readGithubIntakePermission,
  observeGithubDelivery,
  readyDeliveryBinding,
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
      deliveryRuntime: 'none',
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
  runtimeGate: 'none',
  observedAt: NOW,
};

function fixture(
  overrides: {
    pr?: object;
    checks?: object;
    workflows?: object;
    jobs?: object;
    rules?: unknown;
    review?: object;
    suites?: unknown;
    suite?: unknown;
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
    if (path.includes('/rules/branches/'))
      return Response.json(
        overrides.rules ?? [
          { type: 'pull_request' },
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'Verify' }] },
          },
        ],
      );
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
    if (path.includes('/rule-suites/5'))
      return Response.json(
        overrides.suite ?? {
          result: 'pass',
          after_sha: MERGE,
          rule_evaluations: [
            { rule_type: 'required_status_checks', result: 'pass' },
            { rule_type: 'pull_request', result: 'pass' },
          ],
        },
      );
    if (path.includes('/rule-suites?'))
      return Response.json(
        overrides.suites ?? [
          { id: 5, after_sha: MERGE, ref: 'refs/heads/main', result: 'pass' },
        ],
      );
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

  it.each([
    { draft: true },
    { auto_merge: null },
    { body: '<!-- attempt-claim:old -->' },
  ])('refuses unready, unarmed or wrong-attempt evidence: %j', async (pr) => {
    await expect(
      readyDeliveryBinding(fixture({ pr }), {
        run: RUN,
        task: TASK,
        repo: 'octo/example',
        number: 12,
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it('rejects incomplete review reads and author-only approval', async () => {
    for (const review of [
      { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] } },
      {
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            {
              state: 'APPROVED',
              author: { login: 'author' },
              commit: { oid: HEAD },
            },
          ],
        },
      },
    ])
      await expect(
        readyDeliveryBinding(fixture({ review }), {
          run: RUN,
          task: TASK,
          repo: 'octo/example',
          number: 12,
          now: NOW,
        }),
      ).rejects.toThrow();
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

  it('reports a newer revision against the old fence before checking its landing', async () => {
    expect(
      await observeGithubDelivery(
        fixture({ pr: { head: { sha: MERGE } } }),
        BINDING,
      ),
    ).toEqual({ kind: 'revision', head: HEAD, newHead: MERGE });
  });

  it('requires passing exact-merge protected evaluations; merged flags and bypasses do not complete work', async () => {
    const pr = { merged: true, state: 'closed', merge_commit_sha: MERGE };
    await expect(
      observeGithubDelivery(
        fixture({
          pr,
          suites: [
            {
              id: 5,
              after_sha: MERGE,
              ref: 'refs/heads/main',
              result: 'bypass',
            },
          ],
        }),
        BINDING,
      ),
    ).rejects.toThrow();
    await expect(
      observeGithubDelivery(
        fixture({
          pr,
          suite: {
            result: 'pass',
            after_sha: MERGE,
            rule_evaluations: [
              { rule_type: 'required_status_checks', result: 'fail' },
            ],
          },
        }),
        BINDING,
      ),
    ).rejects.toThrow();
    expect(await observeGithubDelivery(fixture({ pr }), BINDING)).toEqual({
      kind: 'protected-merge',
      head: HEAD,
      mergeCommit: MERGE,
    });
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
        if (
          (path.includes('/check-runs') && permissions.checks !== 'read') ||
          (path.includes('/rule-suites') &&
            permissions.administration !== 'read') ||
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
  it.each([false, true])(
    'mints existing declared delivery reads for merged=%s while default remains narrow',
    async (merged) => {
      const scoped = mintedFixture(true, merged);
      expect((await observeGithubDelivery(scoped, BINDING)).kind).toBe(
        merged ? 'protected-merge' : 'waiting',
      );
      expect(scoped.permission()).toEqual({
        actions: 'write',
        issues: 'write',
        pull_requests: 'write',
        administration: 'read',
        checks: 'read',
      });
      expect(
        scoped.calls.mock.calls.some(([url]) =>
          String(url).includes('/status?'),
        ),
      ).toBe(false);
      const ordinary = mintedFixture(false, merged);
      await expect(observeGithubDelivery(ordinary, BINDING)).rejects.toThrow(
        '403',
      );
      expect(ordinary.permission()).toEqual({
        actions: 'write',
        issues: 'write',
        pull_requests: 'write',
      });
    },
  );
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
  it.each([
    { draft: true },
    { state: 'closed' },
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
