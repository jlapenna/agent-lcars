import { WORK_ID_RE } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  dispatchesContract,
  GITHUB_DISPATCH_DESCRIPTION_MAX,
  itemsContract,
  runBriefSchema,
  runsContract,
  schedulesContract,
  WORK_ID_PATTERN,
  workIdSchema,
} from './contract';
import { generateWorkOpenApi } from './openapi';

describe('WORK_ID_PATTERN', () => {
  it('is the same ULID pattern the orchestrator uses (CLI-bundle safety: no import of it here)', () => {
    expect(String(WORK_ID_PATTERN)).toBe(String(WORK_ID_RE));
    expect(workIdSchema.safeParse('01J5Z3K9QX8F0N2B4V6C8D1E3G').success).toBe(
      true,
    );
    expect(workIdSchema.safeParse('not-a-ulid').success).toBe(false);
  });
});

describe('itemsContract', () => {
  it('declares the six item procedures', () => {
    expect(Object.keys(itemsContract).sort()).toEqual([
      'cancel',
      'create',
      'get',
      'list',
      'redispatch',
      'reply',
    ]);
  });
});

describe('dispatchesContract.github', () => {
  it('requires an explicit GitHub anchor, spec, mode, and request id while accepting every valid GitHub body', () => {
    expect(Object.keys(dispatchesContract)).toEqual(['github']);
    const [rawShape] = dispatchesContract.github['~orpc'].inputSchemas ?? [];
    const shape = rawShape as z.ZodTypeAny | undefined;
    const input = {
      anchor: { repo: 'jlapenna/agent-lcars', issue: 1633 },
      spec: {
        title: 'Dispatch an anchor',
        description: 'Through Work API.',
        pipeline: 'claude',
        target: { repo: 'jlapenna/agent-lcars' },
      },
      mode: 'implement',
      requestId: 'workflow-run:123:dispatch:1633',
    };
    expect(shape?.parse(input)).toEqual(input);
    expect(() => {
      const { requestId: _requestId, ...withoutIdempotency } = input;
      shape?.parse(withoutIdempotency);
    }).toThrow();
    expect(() => shape?.parse({ ...input, mode: 'reply' })).toThrow();
    expect(
      shape?.parse({
        ...input,
        spec: {
          ...input.spec,
          description: 'x'.repeat(GITHUB_DISPATCH_DESCRIPTION_MAX),
        },
      }),
    ).toMatchObject({
      spec: { description: 'x'.repeat(GITHUB_DISPATCH_DESCRIPTION_MAX) },
    });
    expect(
      shape?.parse({ ...input, spec: { ...input.spec, description: '' } }),
    ).toMatchObject({ spec: { description: '' } });
    expect(() =>
      shape?.parse({
        ...input,
        spec: {
          ...input.spec,
          description: 'x'.repeat(GITHUB_DISPATCH_DESCRIPTION_MAX + 1),
        },
      }),
    ).toThrow();
  });
});

describe('itemsContract.redispatch', () => {
  it('accepts an optional resumeSessionId and declares BAD_REQUEST', () => {
    // oRPC beta.31 exposes the zod input schema as the first element of
    // `~orpc.inputSchemas` (plural, an array) -- not a singular
    // `inputSchema` field. Statically typed as the erased `AnySchema`
    // (StandardSchemaV1), so cast back to the concrete zod type this
    // contract actually builds to call `.parse` from a test.
    const [rawShape] = itemsContract.redispatch['~orpc'].inputSchemas ?? [];
    const shape = rawShape as z.ZodTypeAny | undefined;
    expect(shape).toBeDefined();
    const parsed = shape?.parse({
      id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      resumeSessionId: 'sess_123',
    });
    expect(parsed).toMatchObject({ resumeSessionId: 'sess_123' });
    expect(
      shape?.parse({
        id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      }),
    ).toEqual({ id: '01J5Z3K9QX8F0N2B4V6C8D1E3G' });
  });
});

describe('schedulesContract', () => {
  it('declares the six schedule procedures', () => {
    expect(Object.keys(schedulesContract).sort()).toEqual([
      'create',
      'disable',
      'enable',
      'get',
      'list',
      'tick',
    ]);
  });
});

describe('runsContract', () => {
  it('declares the seven run routes with bearer security', () => {
    const paths = Object.keys(runsContract);
    expect(paths.sort()).toEqual(
      [
        'claim',
        'brief',
        'heartbeat',
        'complete',
        'checkoutToken',
        'codexAuth',
        'persistCodexAuth',
      ].sort(),
    );
  });

  it('accepts only the executor identity for claim capability', () => {
    const [rawShape] = runsContract.claim['~orpc'].inputSchemas ?? [];
    const shape = rawShape as z.ZodTypeAny | undefined;

    expect(shape?.parse({ runner: 'autoscaler-1' })).toEqual({
      runner: 'autoscaler-1',
    });
    expect(
      shape?.safeParse({ runner: 'autoscaler-1', pipelines: ['claude'] })
        .success,
    ).toBe(false);
    expect(
      shape?.safeParse({ runner: 'autoscaler-1', unknown: true }).success,
    ).toBe(false);
  });

  it('accepts the longest legal GitHub run ID on every token-authenticated route', () => {
    const runId =
      `${'o'.repeat(39)}/${'r'.repeat(100)}` +
      `#${Number.MAX_SAFE_INTEGER}/r${Number.MAX_SAFE_INTEGER + 1}`;
    expect(runId).toHaveLength(175);

    const routes = [
      [runsContract.brief, { runId }],
      [runsContract.heartbeat, { runId }],
      [runsContract.complete, { runId, outcome: 'done' }],
      [runsContract.checkoutToken, { runId }],
      [runsContract.codexAuth, { runId }],
      [
        runsContract.persistCodexAuth,
        {
          runId,
          generation: '1',
          restoredSha256: 'a'.repeat(64),
          authBase64: 'YXV0aA==',
        },
      ],
    ] as const;

    for (const [route, input] of routes) {
      const [rawShape] = route['~orpc'].inputSchemas ?? [];
      const shape = rawShape as z.ZodTypeAny | undefined;
      expect(shape?.safeParse(input).success).toBe(true);
    }

    const [briefShape] = runsContract.brief['~orpc'].inputSchemas ?? [];
    expect(
      (briefShape as z.ZodTypeAny | undefined)?.safeParse({
        runId: `${runId}x`,
      }).success,
    ).toBe(false);
  });
});

describe('runsContract.brief resume field', () => {
  it('runBriefSchema accepts an optional resume object', () => {
    const withResume = runBriefSchema.parse({
      id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
      spec: {
        title: 't',
        description: 'd',
        pipeline: 'claude',
        target: { repo: 'octo/example' },
      },
      anchor: {
        type: 'work',
        id: '01J5Z3K9QX8F0N2B4V6C8D1E3G',
        title: 't',
        body: 'd',
        target_repo: 'octo/example',
        html_url: 'https://lcars.test/work/01J5Z3K9QX8F0N2B4V6C8D1E3G',
      },
      pipeline: 'claude',
      mode: 'implement',
      reply: '',
      replyChannel: '',
      replyPrincipal: '',
      runbook: '',
      context: '',
      attemptId: 'g1:work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      generation: 1,
      intentId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
      resume: {
        sessionId: 'sess_123',
        transcriptGcsUri:
          'gs://agent-lcars-session-transcripts/runs/x/claude-code/sess_123.jsonl',
      },
    });
    expect(withResume.resume?.sessionId).toBe('sess_123');
  });

  it('accepts a GitHub issue or pull-request anchor with dispatch metadata', () => {
    const github = runBriefSchema.parse({
      anchor: {
        type: 'github',
        repo: 'octo/example',
        issue: 42,
        html_url: 'https://github.com/octo/example/issues/42',
      },
      work: {
        spec: {
          title: 'GitHub work',
          description: 'Dispatch via Work API.',
          pipeline: 'claude',
          target: { repo: 'octo/example' },
        },
      },
      pipeline: 'opencode',
      mode: 'review',
      reply: '/opencode review this',
      replyChannel: '',
      replyPrincipal: '',
      runbook: 'pr-heal',
      context: 'nightly',
      attemptId: 'g1:octo/example#42/r1',
      generation: 1,
      intentId: 'octo/example#42/r1',
    });
    expect(github.anchor.type).toBe('github');
  });
});

describe('generateWorkOpenApi', () => {
  it('emits the items, dispatches, schedules, and runs REST routes with bearer and run-token security', async () => {
    const doc = (await generateWorkOpenApi()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes?: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/dispatches/github',
        '/items',
        '/items/{id}',
        '/items/{id}/cancel',
        '/items/{id}/redispatch',
        '/items/{id}/reply',
        '/schedules',
        '/schedules/tick',
        '/schedules/{id}',
        '/schedules/{id}/disable',
        '/schedules/{id}/enable',
        '/runs/claim',
        '/runs/{runId}/brief',
        '/runs/{runId}/heartbeat',
        '/runs/{runId}/complete',
        '/runs/{runId}/checkout-token',
        '/runs/{runId}/codex-auth',
      ].sort(),
    );
    expect(Object.keys(doc.paths['/items/{id}'] ?? {}).sort()).toEqual([
      'get',
      'put',
    ]);
    expect(doc.components.securitySchemes).toHaveProperty('bearerAuth');
    expect(doc.components.securitySchemes).toHaveProperty('runToken');
  });

  it('gives tick a distinct presentation: the cron tag and bearer security', async () => {
    // `tick` is a service operation guarded by the server-owned work.cron
    // scope. Its credential is therefore the same Google bearer format as
    // other Work API callers, not a GitHub workflow identity.
    const doc = (await generateWorkOpenApi()) as {
      paths: Record<
        string,
        Record<
          string,
          { tags?: string[]; security?: Record<string, unknown>[] }
        >
      >;
      components: { securitySchemes?: Record<string, unknown> };
    };
    const tick = doc.paths['/schedules/tick']?.post;
    expect(tick?.tags).toEqual(['schedules', 'cron']);
    expect(tick?.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes).not.toHaveProperty('githubOidc');
  });

  it('documents every status each route can actually answer with', async () => {
    // The failure this guards is a handler throwing a status the contract
    // never declared: it maps correctly at runtime (oRPC's
    // COMMON_ERROR_STATUS_MAP) while the published document quietly omits
    // it, so a client generated from this file has no branch for it.
    // `redispatch` shipped exactly that way -- it re-checks the pipeline
    // grant and the target repo's control-plane membership, both 403,
    // with no FORBIDDEN in its errors map.
    const doc = (await generateWorkOpenApi()) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };
    const statuses = Object.fromEntries(
      Object.entries(doc.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => [
          `${method.toUpperCase()} ${path}`,
          Object.keys(operation.responses).sort(),
        ]),
      ),
    );

    expect(statuses).toEqual({
      // 201 always, replay included -- see the create meta's
      // successDescription.
      'PUT /items/{id}': ['201', '403', '409', '429'],
      'GET /items/{id}': ['200', '404'],
      'GET /items': ['200'],
      'POST /items/{id}/cancel': ['200', '404', '409'],
      'POST /items/{id}/redispatch': ['200', '400', '403', '404', '409', '429'],
      'POST /items/{id}/reply': ['200', '403', '404', '409', '429'],
      'POST /dispatches/github': ['200', '400', '403', '409'],
      'PUT /schedules/{id}': ['201', '400', '403', '409'],
      'GET /schedules/{id}': ['200', '404'],
      'GET /schedules': ['200'],
      'POST /schedules/{id}/enable': ['200', '404'],
      'POST /schedules/{id}/disable': ['200', '404'],
      'POST /schedules/tick': ['200'],
      'POST /runs/claim': ['200', '401'],
      'GET /runs/{runId}/brief': ['200', '401'],
      'POST /runs/{runId}/heartbeat': ['200', '401'],
      'POST /runs/{runId}/complete': ['200', '401'],
      'GET /runs/{runId}/checkout-token': ['200', '401'],
      'GET /runs/{runId}/codex-auth': ['200', '401', '404', '409', '500'],
      'PUT /runs/{runId}/codex-auth': ['200', '400', '401', '409', '500'],
    });
  });
});

describe('generateWorkOpenApi resume additions', () => {
  it('documents 400 for redispatch', async () => {
    const doc = (await generateWorkOpenApi()) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, unknown> }>
      >;
    };
    expect(
      Object.keys(
        doc.paths['/items/{id}/redispatch']?.['post']?.responses ?? {},
      ).sort(),
    ).toEqual(['200', '400', '403', '404', '409', '429']);
  });
});
