import {
  type CliSessionDoc,
  SESSION_RETENTION_DAYS,
} from '@agent-lcars/telemetry';
import {
  getAgentTelemetryWriterFirestore,
  SESSIONS_COLLECTION,
  upsertSession,
} from '@agent-lcars/telemetry/server';
import { isE2eTesting } from '@repo/util-server';
import { NextRequest, NextResponse } from 'next/server';

import { E2E_FIXTURE_BRANCH } from '../../../../lib/e2e-fixtures';

export const E2E_CLI_SESSION_IDS = {
  live: 'e2e-cli-session-live',
  idle: 'e2e-cli-session-idle',
  ended: 'e2e-cli-session-ended',
  stale: 'e2e-cli-session-stale',
} as const;

// Timestamps are relative to seeding time, not frozen: the console applies a
// lastActivityAt recency window both to which sessions it lists at all and to
// the liveness it displays (see cli-sessions.ts / displayLiveness), so frozen
// fixture dates would age out of the window and change their rendered state.
const minutesAgo = (minutes: number) =>
  // The console's e2e specs don't pin ?e2eNow=; page clock and seed share
  // real now, so this can't drift (and the liveness windows here are
  // real-now-relative by design).
  // eslint-disable-next-line no-restricted-syntax
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
      worktree: 'agent-console-e2e-fixture',
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

interface SeedRequest {
  action?: 'seed' | 'reset';
}

/**
 * Seeds/clears fixture `source: 'cli'` session docs directly into the
 * `agent-telemetry` Firestore database, guarded by `isE2eTesting()` like
 * every other `/api/e2e/*` fixture route in this repo. Only the app server
 * itself writes here (never the Playwright test process — see
 * `apps/members/e2e/frontend/src/seed.ts`'s note on why direct-from-test
 * writes don't reach the store the app server reads).
 */
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
      const firestore = getAgentTelemetryWriterFirestore();
      const snapshot = await firestore.collection(SESSIONS_COLLECTION).get();
      await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
      return NextResponse.json({ success: true });
    }

    await Promise.all(fixtureSessions().map((doc) => upsertSession(doc)));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('agent-console: error in E2E seed API:', error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
