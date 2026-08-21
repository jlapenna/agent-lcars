import 'server-only';

import {
  type Clock,
  FirestoreStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { required } from '@agent-lcars/util-server';

import {
  createDispatchTokenProvider,
  type DispatchTokenProvider,
} from '@/lib/github-app-tokens';
import { drainOutbox } from '@/lib/orchestrator-dispatch';
import type { OrchestratorRouteDeps } from '@/lib/orchestrator-routes';
import { settleTerminalRuns } from '@/lib/orchestrator-terminal-runs';

/**
 * Builds the orchestrator's real runtime dependencies -- a Firestore-backed
 * store, the orchestrator itself wired to a real clock, and the outbox
 * drain bound to a per-repo dispatch token provider. Memoized at module
 * scope so every route handler invoked within one running server instance
 * shares the same store connection rather than opening a new one per
 * request.
 *
 * `PROJECT_ID` and `DISPATCH_FIRESTORE_DATABASE_ID` are already deployed in
 * apphosting.yaml (see hosted-webhook-queue.ts for the same `PROJECT_ID`
 * read pattern). The token provider is rebuilt from `process.env` on every
 * drain (see `createDispatchTokenProvider` in `github-app-tokens.ts`)
 * rather than captured once, so a rotated `AGENT_LCARS_APP_PRIVATE_KEY`
 * secret still takes effect without a restart, at the cost of re-parsing
 * that key and reconstructing the (still per-repo-caching)
 * `AppInstallationTokenProvider` each call instead of reusing one across
 * drains.
 */

const utcClock: Clock = { now: () => new Date().toISOString() };

let cached: OrchestratorRouteDeps | undefined;

interface OrchestratorGithubRuntimeDeps {
  tokens: DispatchTokenProvider;
  githubApiBaseUrl?: string;
}

/**
 * Keeps the orchestrator on the same local GitHub fixture boundary as the
 * console's Octokit client. Production still constructs and validates the
 * GitHub App provider eagerly; only the explicitly configured E2E fixture
 * URL selects the inert placeholder token.
 */
export function orchestratorGithubRuntimeDeps(
  env: Record<string, string | undefined>,
): OrchestratorGithubRuntimeDeps {
  const fixtureBaseUrl = env['AGENT_CONSOLE_GITHUB_API_BASE_URL']?.trim();
  return fixtureBaseUrl
    ? {
        tokens: { tokenFor: async () => 'e2e-fixture-token' },
        githubApiBaseUrl: fixtureBaseUrl,
      }
    : { tokens: createDispatchTokenProvider(env) };
}

export function createOrchestratorRuntime(): OrchestratorRouteDeps {
  if (cached !== undefined) return cached;

  const store = new FirestoreStore({
    projectId: required('PROJECT_ID'),
    databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
  });
  const orchestrator = new Orchestrator(store, utcClock);

  cached = {
    store,
    orchestrator,
    drain: () => {
      const github = orchestratorGithubRuntimeDeps(process.env);
      return drainOutbox({
        store,
        orchestrator,
        ...github,
      });
    },
    settleTerminal: () => {
      const github = orchestratorGithubRuntimeDeps(process.env);
      return settleTerminalRuns({
        store,
        orchestrator,
        ...github,
      });
    },
  };
  return cached;
}
