import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import { createRunsHandler, type RunsContext } from './runs-router';

const NOW = '2026-08-27T10:00:00.000Z';

const executorPrincipal = {
  principal: 'runner:queue',
  subject: 'google:queue-runner@example.iam.gserviceaccount.com',
  scopes: new Set(['work.executor'] as const),
  pipelines: ['claude'],
  via: 'google' as const,
};

function context(over: Partial<RunsContext> = {}): RunsContext {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => NOW });
  return {
    store,
    orchestrator,
    tokens: { tokenFor: async () => 'ambient-token' },
    checkoutTokens: { tokenFor: async () => 'checkout-token' },
    ...over,
  };
}

async function call(
  ctx: RunsContext,
  method: string,
  path: string,
  body?: unknown,
) {
  const handler = createRunsHandler();
  const { response } = await handler.handle(
    new Request(`https://lcars.test/api/work/v1${path}`, {
      method,
      // Only set a content type when there IS a body: a POST carrying
      // `content-type: application/json` with an empty body is a malformed
      // JSON request, and oRPC (correctly) answers 400 rather than reaching
      // the procedure at all -- see work-router.test.ts's `call` helper,
      // which this mirrors.
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    }),
    { prefix: '/api/work/v1', context: ctx },
  );
  return {
    status: response?.status,
    json: response ? await response.json() : undefined,
  };
}

/** Every run-token-secured route, method + path + a schema-valid body
 *  (where the method takes one). A run id with no `/` in it is enough for
 *  this smoke suite -- whether a real native run id (`work:<ulid>/r<n>`,
 *  which DOES contain a `/`) round-trips through a single `{runId}` path
 *  segment is a routing question for Task 8's full behavior matrix, not
 *  this task's "does each route exist and gate its token" smoke check. */
const RUN_TOKEN_ROUTES = [
  ['GET', '/runs/testrun1/brief'],
  ['POST', '/runs/testrun1/heartbeat'],
  ['POST', '/runs/testrun1/complete', { outcome: 'pull-request' }],
  ['GET', '/runs/testrun1/checkout-token'],
] as const;

describe('runs routes', () => {
  it('claim exists and refuses a request with no principal', async () => {
    const ctx = context({ principal: undefined });
    const r = await call(ctx, 'POST', '/runs/claim', {
      runner: 'runner-1',
      pipelines: ['claude'],
    });
    expect(r.status).toBe(401);
  });

  it('claim refuses a principal missing the work.executor scope', async () => {
    const ctx = context({
      principal: {
        ...executorPrincipal,
        scopes: new Set(['work.operator'] as const),
      },
    });
    const r = await call(ctx, 'POST', '/runs/claim', {
      runner: 'runner-1',
      pipelines: ['claude'],
    });
    expect(r.status).toBe(401);
  });

  it('every run-token route exists and refuses a missing bearer token', async () => {
    const ctx = context();
    for (const [method, path, body] of RUN_TOKEN_ROUTES) {
      const r = await call(ctx, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it('every run-token route refuses a bearer that matches no run', async () => {
    const ctx = context({ bearerToken: 'not-a-real-token' });
    for (const [method, path, body] of RUN_TOKEN_ROUTES) {
      const r = await call(ctx, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });
});
