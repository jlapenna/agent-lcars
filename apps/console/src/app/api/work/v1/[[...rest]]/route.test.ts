import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  auth,
  authenticateWorkRequest,
  controlPlaneRepository,
  verifySessionExpiryOidcToken,
  sessionsForRuns,
  sessionForResume,
  sessionDocsForRuns,
  getCliSessions,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  authenticateWorkRequest: vi.fn(),
  controlPlaneRepository: vi.fn(() => 'jlapenna/agent-lcars'),
  verifySessionExpiryOidcToken: vi.fn(),
  sessionsForRuns: vi.fn(async () => []),
  sessionForResume: vi.fn(async () => undefined),
  sessionDocsForRuns: vi.fn(async () => []),
  getCliSessions: vi.fn(
    async (_options?: { repo?: { owner: string; name: string } }) => ({
      sessions: [],
      warnings: [],
    }),
  ),
}));

vi.mock('@/auth', () => ({ auth }));
vi.mock('@/lib/deployment', () => ({
  controlPlaneRepository,
  controlPlaneRepositories: () => ['jlapenna/agent-lcars'],
  isControlPlaneRepository: (repo: string) => repo === 'jlapenna/agent-lcars',
}));
vi.mock('@/lib/github-actions-oidc', () => ({ verifySessionExpiryOidcToken }));
vi.mock('@/lib/work-auth', () => ({
  authenticateWorkRequest,
  googleIdTokenVerifier: () => async () => ({
    email: '',
    emailVerified: false,
  }),
  rawBearerToken: () => undefined,
}));
vi.mock('@/lib/cli-sessions', () => ({ getCliSessions }));
vi.mock('@/lib/work-sessions', () => ({
  sessionsForRuns,
  sessionForResume,
  sessionDocsForRuns,
}));

// Plain top-level bindings, not `vi.hoisted` -- `vi.hoisted`'s callback runs
// before this file's own static imports resolve, so `MemoryStore` et al.
// would not exist yet inside it. These only need to exist by the time the
// `@/lib/orchestrator-runtime` mock factory below is actually CALLED (on
// the first import of that module, deferred until `import { GET } from
// './route'` at the bottom of this file triggers it) -- ordinary
// top-to-bottom module evaluation already guarantees that.
const orchestratorStore = new MemoryStore();
const orchestrator = new Orchestrator(orchestratorStore, {
  now: () => new Date().toISOString(),
});

/**
 * `@/lib/github-app-tokens` is deliberately NOT mocked: this file's entire
 * point is to prove the real `createDispatchTokenProvider` path is never
 * reached for an `/items` request. Mocking it would hide the exact
 * regression this guards.
 */
vi.mock('@/lib/orchestrator-runtime', () => ({
  createOrchestratorRuntime: () => ({
    store: orchestratorStore,
    orchestrator,
    drain: async () => ({ dispatched: [], failed: [] }),
  }),
  createScheduleStore: () => new MemoryScheduleStore(),
}));

import { GET } from './route';

const operatorPrincipal = {
  principal: 'user:jlapenna',
  subject: 'github:jlapenna',
  scopes: new Set(['work.operator'] as const),
  pipelines: ['claude'],
  via: 'session' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticateWorkRequest.mockResolvedValue(operatorPrincipal);
  // The regression this guards: `AGENT_LCARS_APP_CLIENT_ID`/
  // `AGENT_LCARS_APP_PRIVATE_KEY` (the GitHub App credential
  // `createDispatchTokenProvider` -- `github-app-tokens.ts` -- requires)
  // are unset, exactly as they are for a console deployment that has never
  // configured them, or a request racing a rotation. `/items` traffic
  // never needs a GitHub token at all.
  delete process.env['AGENT_LCARS_APP_CLIENT_ID'];
  delete process.env['AGENT_LCARS_APP_PRIVATE_KEY'];
});

describe('GET /api/work/v1/items', () => {
  it('succeeds with AGENT_LCARS_APP_CLIENT_ID/AGENT_LCARS_APP_PRIVATE_KEY unset', async () => {
    const response = await GET(
      new Request('https://lcars.test/api/work/v1/items'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    // Matches every `api/control-plane/*` route's own header: per-caller
    // data, never safe for a shared cache to reuse across callers.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/work/v1/anchors/github/owner', () => {
  it("answers from the anchor repository's CLI session telemetry, uncached", async () => {
    const response = await GET(
      new Request(
        'https://lcars.test/api/work/v1/anchors/github/owner?repo=jlapenna/agent-lcars&issue=2502',
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      anchor: { repo: 'jlapenna/agent-lcars', issue: 2502 },
      verdict: 'none',
      complete: true,
      cliSessions: [],
    });
    expect(getCliSessions).toHaveBeenCalledWith({
      repo: { owner: 'jlapenna', name: 'agent-lcars' },
    });
  });
});

describe('GET /api/work/v1/runs/{runId}/brief', () => {
  it('answers Cache-Control: no-store even on the runs router branch', async () => {
    // No run-token bearer (`rawBearerToken` is mocked to always return
    // `undefined`), so `requireRunToken` refuses this before it ever reads
    // a run -- proving the header is set on every response this route
    // answers with, not just the items/schedules branch's 200s. The slash
    // in the run id is percent-encoded (encodeURIComponent), matching
    // runs-router.test.ts's own `runPath` helper -- the OpenAPI router's
    // single `{runId}` path segment does not accept a literal one.
    const runId = 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1';
    const response = await GET(
      new Request(
        `https://lcars.test/api/work/v1/runs/${encodeURIComponent(runId)}/brief`,
      ),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/work/v1/runs/capacity/metrics', () => {
  it('serves authenticated Prometheus text through the production HTTP owner', async () => {
    authenticateWorkRequest.mockResolvedValue({
      ...operatorPrincipal,
      capacityPool: 'pool-a',
      scopes: new Set(['work.capacity.recover']),
    });
    const response = await GET(
      new Request('https://lcars.test/api/work/v1/runs/capacity/metrics'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toMatch(/^# HELP lcars_capacity_slots/u);
  });
  it('keeps an unauthorized scrape as an ordinary uncached authorization error', async () => {
    const response = await GET(
      new Request('https://lcars.test/api/work/v1/runs/capacity/metrics'),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('a work.reader-only principal (#2502)', () => {
  const readerPrincipal = {
    principal: 'svc:work-reader',
    subject: 'work-reader@agent-lcars.iam.gserviceaccount.com',
    scopes: new Set(['work.reader'] as const),
    pipelines: ['claude', 'codex', 'opencode'],
    via: 'google' as const,
  };
  /** The owner query is the one operation `work.reader` exists for. */
  const readerOperations = new Set(['getGithubAnchorOwner']);
  /** Well-formed bodies for the operations that validate input before they
   *  authorize, so the refusal below is authorization, not a 400. */
  const validBodies: Record<string, unknown> = {
    changeCapacity: { action: 'register', producerId: 'producer-1' },
    activateWorker: {
      fence: {
        poolId: 'pool-a',
        slot: 0,
        revision: 1,
        runId: 'work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1',
        nonce: '0123456789abcdef',
      },
      jobUid: 'job-1',
    },
    completeRun: { outcome: { ok: true, summary: 'done' } },
    persistRunCodexAuth: {
      generation: '1',
      restoredSha256: '0'.repeat(64),
      authBase64: 'e30=',
    },
  };
  const operations = Object.entries(
    (
      JSON.parse(
        readFileSync(
          path.join(
            import.meta.dirname,
            '../../../../../../../../docs/api/work-v1.openapi.json',
          ),
          'utf8',
        ),
      ) as {
        paths: Record<string, Record<string, { operationId: string }>>;
      }
    ).paths,
  ).flatMap(([template, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      method: method.toUpperCase(),
      operationId: operation.operationId,
      path: template
        .replace('{id}', '01J5Z3K9QX8F0N2B4V6C8D1E3G')
        .replace(
          '{runId}',
          encodeURIComponent('work:01J5Z3K9QX8F0N2B4V6C8D1E3G/r1'),
        ),
    })),
  );

  it('enumerates every published Work operation, including the owner query', () => {
    expect(operations.length).toBeGreaterThan(30);
    expect(operations.map((op) => op.operationId)).toEqual(
      expect.arrayContaining([...readerOperations]),
    );
  });

  it('answers the owner query', async () => {
    authenticateWorkRequest.mockResolvedValue(readerPrincipal);
    const response = await GET(
      new Request(
        'https://lcars.test/api/work/v1/anchors/github/owner?repo=jlapenna/agent-lcars&issue=2502',
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verdict: 'none' });
  });

  it.each(operations.filter((op) => !readerOperations.has(op.operationId)))(
    'is refused by $operationId ($method $path) before anything is read or written',
    async ({ method, operationId, path: operationPath }) => {
      authenticateWorkRequest.mockResolvedValue(readerPrincipal);
      const read = vi.spyOn(orchestratorStore, 'readTask');
      const request = vi.spyOn(orchestrator, 'request');
      const response = await GET(
        new Request(`https://lcars.test/api/work/v1${operationPath}`, {
          method,
          ...(method === 'GET' || method === 'DELETE'
            ? {}
            : {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(validBodies[operationId] ?? {}),
              }),
        }),
      );
      expect([401, 403]).toContain(response.status);
      expect(read).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      read.mockRestore();
      request.mockRestore();
    },
  );
});

describe('shared Work HTTP origin policy', () => {
  it.each(['/items', '/jobs/invoke', '/schedules', '/future-platform'])(
    'rejects cookie writes to %s before routing',
    async (path) => {
      const response = await GET(
        new Request(`https://lcars.test/api/work/v1${path}`, {
          method: 'POST',
          headers: { origin: 'https://foreign.example' },
          body: 'invalid json',
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'Same-origin request required',
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it.each(['session', 'google', 'oidc'] as const)(
    'routes permitted %s requests normally',
    async (via) => {
      authenticateWorkRequest.mockResolvedValue({ ...operatorPrincipal, via });
      const response = await GET(
        new Request('https://lcars.test/api/work/v1/future-platform', {
          method: 'POST',
          headers: via === 'session' ? { origin: 'https://lcars.test' } : {},
        }),
      );
      expect(response.status).toBe(404);
    },
  );
});

it('fails closed for a new operation with a repository-bound identity', async () => {
  authenticateWorkRequest.mockResolvedValue({
    ...operatorPrincipal,
    via: 'oidc',
    sourceRepository: 'jlapenna/agent-lcars',
  });
  for (const path of [
    '/future-platform',
    '/jobs/future-operation',
    '/maintenance/tick',
  ]) {
    const response = await GET(
      new Request(`https://lcars.test/api/work/v1${path}`, { method: 'POST' }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Operation does not declare repository-bound access',
    });
  }
  const response = await GET(
    new Request('https://lcars.test/api/work/v1/items'),
  );
  expect(response.status).toBe(200);
});

it.each(['/items/export', '/schedules/history', '/delivery/export/evidence'])(
  'does not pre-authorize a future static operation at %s',
  async (path) => {
    authenticateWorkRequest.mockResolvedValue({
      ...operatorPrincipal,
      via: 'oidc',
      sourceRepository: 'jlapenna/agent-lcars',
    });
    const response = await GET(
      new Request(`https://lcars.test/api/work/v1${path}`, {
        method: path.startsWith('/delivery') ? 'POST' : 'GET',
      }),
    );
    expect(response.status).toBe(403);
  },
);
