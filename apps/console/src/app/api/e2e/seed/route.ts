import {
  type CliSessionDoc,
  type IssueAgentSessionDoc,
  SESSION_RETENTION_DAYS,
} from '@agent-lcars/telemetry';
import {
  getAgentTelemetryWriterFirestore,
  SESSIONS_COLLECTION,
  upsertSession,
} from '@agent-lcars/telemetry/server';
import { isE2eTesting } from '@agent-lcars/util-server';
import { revalidateTag } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';

import { GITHUB_DATA_TAG } from '../../../../lib/cache-tags';
import { E2E_FIXTURE_BRANCH } from '../../../../lib/e2e-fixtures';
import {
  E2E_FIXTURE_REPO,
  E2E_ITEM_NUMBERS,
  E2E_RUN_IDS,
  resetQuickTaskFixtures,
  setPopulatedFixtures,
} from '../../../../lib/e2e-github-fixtures';

export const E2E_CLI_SESSION_IDS = {
  live: 'e2e-cli-session-live',
  idle: 'e2e-cli-session-idle',
  ended: 'e2e-cli-session-ended',
  stale: 'e2e-cli-session-stale',
} as const;

/** Populated mode only (#40). An `issue-agent` doc had never been seeded at
 * all, so the session detail page's stat grid and the `agent` source badge
 * had only ever been exercised by unit tests. */
export const E2E_ISSUE_AGENT_SESSION_ID = 'e2e-issue-agent-session';

// Timestamps are relative to seeding time, not frozen: the console applies a
// lastActivityAt recency window both to which sessions it lists at all and to
// the liveness it displays (see cli-sessions.ts / displayLiveness), so frozen
// fixture dates would age out of the window and change their rendered state.
const minutesAgo = (minutes: number) =>
  // The console's e2e specs don't pin ?e2eNow=; page clock and seed share
  // real now, so this can't drift (and the liveness windows here are
  // real-now-relative by design).

  new Date(Date.now() - minutes * 60 * 1000).toISOString();

const expireAtFor = (lastActivityAt: string) => {
  const expireAt = new Date(lastActivityAt);
  expireAt.setUTCDate(expireAt.getUTCDate() + SESSION_RETENTION_DAYS);
  return expireAt.toISOString();
};

function fixtureSessions(): CliSessionDoc[] {
  const liveLastActivityAt = minutesAgo(1);
  const idleLastActivityAt = minutesAgo(20);
  const endedLastActivityAt = minutesAgo(235);
  const staleLastActivityAt = minutesAgo(350);

  return [
    {
      sessionId: E2E_CLI_SESSION_IDS.live,
      source: 'cli',
      liveness: 'live',
      startedAt: minutesAgo(15),
      lastActivityAt: liveLastActivityAt,
      expireAt: expireAtFor(liveLastActivityAt),
      turns: 12,
      toolCallCounts: { Read: 5, Edit: 3, Bash: 4 },
      tokens: {
        inputTokens: 8000,
        outputTokens: 4200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      host: 'e2e-fixture-host-1',
      branch: E2E_FIXTURE_BRANCH,
      worktree: 'agent-lcars-e2e-fixture',
      model: 'claude-sonnet-5',
      title: 'E2E fixture: live CLI session',
      deliverables: { prNumbers: [], commitShas: [] },
    },
    {
      sessionId: E2E_CLI_SESSION_IDS.idle,
      source: 'cli',
      liveness: 'idle',
      startedAt: minutesAgo(120),
      lastActivityAt: idleLastActivityAt,
      expireAt: expireAtFor(idleLastActivityAt),
      turns: 3,
      toolCallCounts: { Read: 2 },
      tokens: {
        inputTokens: 900,
        outputTokens: 300,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      host: 'e2e-fixture-host-2',
      branch: 'e2e-idle-fixture-branch',
      model: 'claude-opus-4-8',
      title: 'E2E fixture: idle CLI session',
      deliverables: { prNumbers: [], commitShas: [] },
    },
    {
      sessionId: E2E_CLI_SESSION_IDS.ended,
      source: 'cli',
      liveness: 'ended',
      startedAt: minutesAgo(240),
      lastActivityAt: endedLastActivityAt,
      expireAt: expireAtFor(endedLastActivityAt),
      turns: 1,
      toolCallCounts: {},
      tokens: {
        inputTokens: 150,
        outputTokens: 60,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      host: 'e2e-fixture-host-3',
      title: 'E2E fixture: ended CLI session',
      deliverables: { prNumbers: [], commitShas: [] },
    },
    {
      sessionId: E2E_CLI_SESSION_IDS.stale,
      source: 'cli',
      liveness: 'stale',
      startedAt: minutesAgo(360),
      lastActivityAt: staleLastActivityAt,
      expireAt: expireAtFor(staleLastActivityAt),
      turns: 2,
      toolCallCounts: {},
      tokens: {
        inputTokens: 400,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      host: 'e2e-fixture-host-4',
      title: 'E2E fixture: stale CLI session',
      deliverables: { prNumbers: [], commitShas: [] },
    },
  ];
}

/**
 * The `issue-agent` half of the populated fixture set. Joined to
 * `E2E_RUN_IDS.silentError` (a run GitHub reported as `success`) with zero
 * turns and zero cost, which is exactly the signature
 * `deriveSilentErrorDiagnoses` looks for — so seeding this is what makes
 * the dashboard's `silent-error` action type render at all.
 */
function fixtureIssueAgentSession(): IssueAgentSessionDoc {
  const lastActivityAt = minutesAgo(52);
  return {
    sessionId: E2E_ISSUE_AGENT_SESSION_ID,
    source: 'issue-agent',
    liveness: 'ended',
    repo: { owner: E2E_FIXTURE_REPO.owner, name: E2E_FIXTURE_REPO.name },
    runId: String(E2E_RUN_IDS.silentError),
    issueNumber: E2E_ITEM_NUMBERS.silentError,
    startedAt: minutesAgo(56),
    lastActivityAt,
    expireAt: expireAtFor(lastActivityAt),
    turns: 0,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    model: 'claude-opus-5',
    permissionMode: 'acceptEdits',
    title: 'E2E fixture: issue-agent session that did no work',
    totalCostUsd: 0,
    result: { subtype: 'success', isError: false },
    deliverables: { prNumbers: [], commitShas: [] },
  };
}

interface SeedRequest {
  /** `seed` is the original CLI-session-only fixture set; `seed-populated`
   * adds the issue-agent session and switches the GitHub fixture route into
   * populated mode (#40). `reset` clears both. */
  action?: 'seed' | 'seed-populated' | 'reset';
}

/**
 * Seeds/clears fixture `source: 'cli'` session docs directly into the
 * `agent-telemetry` Firestore database, guarded by `isE2eTesting()` like
 * every other `/api/e2e/*` fixture route in this repo. Only the app server
 * itself writes here (never the Playwright test process, whose writes
 * wouldn't reach the store the running app server reads).
 */
/**
 * Seeding changes what the fixture GitHub API will answer, so it has to drop
 * the dashboard's cached read of it (lib/dashboard-data.ts) - otherwise a
 * spec that loaded any page before seeding would keep rendering the pre-seed
 * response, and whether it passed would depend on how fast the spec ran.
 *
 * `revalidateTag` with an explicit profile, not `updateTag`: this is a Route
 * Handler, and `updateTag` is Server-Action-only.
 *
 * `{ expire: 0 }`, not the `'max'` profile: named profiles carry
 * stale-while-revalidate semantics, so the first request after a fixture
 * switch could still render the PREVIOUS fixture while refreshing behind
 * it - reintroducing exactly the run-order dependence this exists to
 * prevent. Zero expiry drops the entry outright.
 */
function revalidateDashboardCache() {
  revalidateTag(GITHUB_DATA_TAG, { expire: 0 });
}

export async function POST(req: NextRequest) {
  if (!isE2eTesting()) {
    return NextResponse.json(
      { success: false, error: 'Forbidden' },
      { status: 403 },
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as SeedRequest;

    if (body.action === 'reset') {
      setPopulatedFixtures(false);
      resetQuickTaskFixtures();
      revalidateDashboardCache();
      const firestore = getAgentTelemetryWriterFirestore();
      const snapshot = await firestore.collection(SESSIONS_COLLECTION).get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
      return NextResponse.json({ success: true });
    }

    const populated = body.action === 'seed-populated';
    setPopulatedFixtures(populated);
    revalidateDashboardCache();
    const docs = populated
      ? [...fixtureSessions(), fixtureIssueAgentSession()]
      : fixtureSessions();
    await Promise.all(docs.map((doc) => upsertSession(doc)));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('agent-lcars: error in E2E seed API:', error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
