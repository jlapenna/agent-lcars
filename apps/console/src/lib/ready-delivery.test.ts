import type { DeliveryBinding, Run, Task } from '@agent-lcars/orchestrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
      return Response.json([
        { type: 'pull_request' },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'Verify' }] },
        },
      ]);
    if (path.includes('/check-runs'))
      return Response.json(
        overrides.checks ?? {
          total_count: 1,
          check_runs: [
            {
              name: 'Verify',
              head_sha: HEAD,
              status: 'queued',
              conclusion: null,
            },
          ],
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
