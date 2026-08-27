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
  verifyScheduleTickOidcToken,
  sessionsForRuns,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  authenticateWorkRequest: vi.fn(),
  controlPlaneRepository: vi.fn(() => 'jlapenna/agent-lcars'),
  verifyScheduleTickOidcToken: vi.fn(),
  sessionsForRuns: vi.fn(async () => []),
}));

vi.mock('@/auth', () => ({ auth }));
vi.mock('@/lib/deployment', () => ({ controlPlaneRepository }));
vi.mock('@/lib/github-actions-oidc', () => ({ verifyScheduleTickOidcToken }));
vi.mock('@/lib/work-auth', () => ({
  authenticateWorkRequest,
  googleIdTokenVerifier: () => async () => ({
    email: '',
    emailVerified: false,
  }),
  rawBearerToken: () => undefined,
}));
vi.mock('@/lib/work-sessions', () => ({ sessionsForRuns }));

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
    settleTerminal: async () => ({}),
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
  });
});
