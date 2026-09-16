import type { Run as OrchestratorRun } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';

import type { ActionItem } from './action-items';
import {
  claimedIdleReason,
  deriveClaimedIdle,
  mostRecentSessionForItem,
  sessionReferencesItemNumber,
} from './claimed-idle';
import type { CliSession } from './cli-sessions';

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    number: 42,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/sprinkles/issues/42',
    updatedAt: '2026-07-18T00:00:00Z',
    actionTypes: [],
    labels: [],
    assigneeLogins: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<CliSession> = {}): CliSession {
  return {
    sessionId: 'session-1',
    liveness: 'live',
    agent: 'claude-code',
    repo: { owner: 'supersprinklesracing', name: 'sprinkles' },
    turns: 1,
    totalTokens: 100,
    startedAt: '2026-07-18T00:00:00Z',
    lastActivityAt: '2026-07-18T00:00:00Z',
    ...overrides,
  };
}

describe('sessionReferencesItemNumber', () => {
  it("matches on the session's joined PR number", () => {
    const session = makeSession({ pr: { number: 42, url: 'u' } });
    expect(sessionReferencesItemNumber(session, makeItem({ number: 42 }))).toBe(
      true,
    );
    expect(sessionReferencesItemNumber(session, makeItem({ number: 43 }))).toBe(
      false,
    );
  });

  it('matches when the item number appears in the branch, bounded by non-digits', () => {
    const session = makeSession({
      branch: 'agent-lcars-agents-page-3024',
    });
    expect(
      sessionReferencesItemNumber(session, makeItem({ number: 3024 })),
    ).toBe(true);
  });

  it('does not false-match a shorter number embedded in a longer one', () => {
    const session = makeSession({ branch: 'fix-primes-backend-oom-2819' });
    expect(
      sessionReferencesItemNumber(session, makeItem({ number: 281 })),
    ).toBe(false);
    expect(
      sessionReferencesItemNumber(session, makeItem({ number: 819 })),
    ).toBe(false);
    expect(
      sessionReferencesItemNumber(session, makeItem({ number: 2819 })),
    ).toBe(true);
  });

  it('returns false with neither a PR nor a branch', () => {
    expect(
      sessionReferencesItemNumber(makeSession(), makeItem({ number: 42 })),
    ).toBe(false);
  });

  // Regression for the same collision class Codex caught in the board's
  // React keys and the ledger's issue rows: item numbers only disambiguate
  // within one repo.
  it('does not match a same-numbered item in a different repo', () => {
    const repoA = { owner: 'org-a', name: 'repo-a' };
    const repoB = { owner: 'org-b', name: 'repo-b' };
    const session = makeSession({
      repo: repoA,
      pr: { number: 42, url: 'u' },
    });
    expect(
      sessionReferencesItemNumber(
        session,
        makeItem({ number: 42, repo: repoB }),
      ),
    ).toBe(false);
    expect(
      sessionReferencesItemNumber(
        session,
        makeItem({ number: 42, repo: repoA }),
      ),
    ).toBe(true);
  });

  it('does not match a repo-less CLI session to a GitHub item', () => {
    const session = makeSession({
      repo: undefined,
      pr: { number: 42, url: 'u' },
    });
    expect(
      sessionReferencesItemNumber(
        session,
        makeItem({ number: 42, repo: { owner: 'org-a', name: 'repo-a' } }),
      ),
    ).toBe(false);
  });
});

describe('mostRecentSessionForItem', () => {
  it('finds an ended/stale session, unlike deriveClaimedIdle', () => {
    const item = makeItem({ number: 1 });
    const session = makeSession({
      liveness: 'ended',
      pr: { number: 1, url: 'u' },
    });
    expect(mostRecentSessionForItem(item, [session])).toBe(session);
  });

  it('returns the first match, trusting callers to pass newest-first sessions', () => {
    const item = makeItem({ number: 1 });
    const older = makeSession({
      sessionId: 'older',
      pr: { number: 1, url: 'u' },
      lastActivityAt: '2026-07-01T00:00:00Z',
    });
    const newer = makeSession({
      sessionId: 'newer',
      pr: { number: 1, url: 'u' },
      lastActivityAt: '2026-07-20T00:00:00Z',
    });
    expect(mostRecentSessionForItem(item, [newer, older])?.sessionId).toBe(
      'newer',
    );
  });

  it('returns undefined when no session references the item', () => {
    const item = makeItem({ number: 1 });
    const session = makeSession({ pr: { number: 999, url: 'u' } });
    expect(mostRecentSessionForItem(item, [session])).toBeUndefined();
  });
});

describe('deriveClaimedIdle', () => {
  const noLiveRun = () => false;
  const allLiveRun = () => true;

  it('includes an open agent-lcars-bot claim with no live run and no active session', () => {
    const items = [
      makeItem({ number: 1, assigneeLogins: ['agent-lcars-bot'] }),
    ];
    expect(deriveClaimedIdle(items, noLiveRun, [])).toEqual(items);
  });

  it('excludes items not assigned to agent-lcars-bot', () => {
    const items = [makeItem({ number: 1, assigneeLogins: ['jlapenna'] })];
    expect(deriveClaimedIdle(items, noLiveRun, [])).toEqual([]);
  });

  it('excludes items with a live run', () => {
    const items = [
      makeItem({ number: 1, assigneeLogins: ['agent-lcars-bot'] }),
    ];
    expect(deriveClaimedIdle(items, allLiveRun, [])).toEqual([]);
  });

  it('excludes items an active CLI session is working', () => {
    const items = [
      makeItem({ number: 1, assigneeLogins: ['agent-lcars-bot'] }),
    ];
    const sessions = [makeSession({ pr: { number: 1, url: 'u' } })];
    expect(deriveClaimedIdle(items, noLiveRun, sessions)).toEqual([]);
  });

  it('does not let an unrelated active session mask a genuinely stale claim', () => {
    const items = [
      makeItem({ number: 1, assigneeLogins: ['agent-lcars-bot'] }),
    ];
    const sessions = [makeSession({ pr: { number: 999, url: 'u' } })];
    expect(deriveClaimedIdle(items, noLiveRun, sessions)).toEqual(items);
  });

  it('does not let a same-numbered session in a different repo mask a genuinely stale claim', () => {
    const repoA = { owner: 'org-a', name: 'repo-a' };
    const repoB = { owner: 'org-b', name: 'repo-b' };
    const items = [
      makeItem({ number: 1, repo: repoA, assigneeLogins: ['agent-lcars-bot'] }),
    ];
    const sessions = [
      makeSession({ repo: repoB, pr: { number: 1, url: 'u' } }),
    ];
    expect(deriveClaimedIdle(items, noLiveRun, sessions)).toEqual(items);
  });
});

describe('deriveClaimedIdle deliberate-idle exclusions', () => {
  const claimed = (overrides: Partial<ActionItem> = {}) =>
    makeItem({ assigneeLogins: ['agent-lcars-bot'], ...overrides });

  it('lists a fleet-claimed item with no live run and no active session', () => {
    expect(deriveClaimedIdle([claimed()], () => false, [])).toHaveLength(1);
  });

  it('excludes items with a live run or an active session on them', () => {
    expect(deriveClaimedIdle([claimed()], () => true, [])).toEqual([]);
    expect(
      deriveClaimedIdle([claimed({ number: 7 })], () => false, [
        makeSession({ branch: 'fix-7' }),
      ]),
    ).toEqual([]);
  });

  it('excludes an item a human is assigned to - the human owns it', () => {
    expect(
      deriveClaimedIdle(
        [claimed({ assigneeLogins: ['jlapenna', 'agent-lcars-bot'] })],
        () => false,
        [],
      ),
    ).toEqual([]);
  });

  it('does not count another agent bot login as a human owner', () => {
    expect(
      deriveClaimedIdle(
        [claimed({ assigneeLogins: ['agent-lcars-bot', 'agent-lcars[bot]'] })],
        () => false,
        [],
      ),
    ).toHaveLength(1);
  });

  it('excludes a handed-back item - needs-human is the Inbox, not a stale claim', () => {
    expect(
      deriveClaimedIdle(
        [claimed({ actionTypes: ['needs-human'] })],
        () => false,
        [],
      ),
    ).toEqual([]);
  });

  it('excludes a durable ledger kept open on purpose (status:ledger)', () => {
    expect(
      deriveClaimedIdle(
        [claimed({ labels: ['status:ledger'] })],
        () => false,
        [],
      ),
    ).toEqual([]);
  });

  it('excludes an item that is deliberately blocked - it is parked, not stale', () => {
    expect(
      deriveClaimedIdle(
        [claimed({ actionTypes: ['blocked'] })],
        () => false,
        [],
      ),
    ).toEqual([]);
  });

  it('excludes a standing Renovate dashboard - its claim is routing, not work', () => {
    expect(
      deriveClaimedIdle(
        [claimed({ title: 'Dependency Dashboard', labels: ['bot:renovate'] })],
        () => false,
        [],
      ),
    ).toEqual([]);
  });
});

describe('claimedIdleReason', () => {
  const run = (
    state: OrchestratorRun['state'],
    result?: OrchestratorRun['result'],
    createdAt = '2026-07-18T00:00:00Z',
  ) =>
    ({
      runId: `${state}-${createdAt}`,
      state,
      createdAt,
      updatedAt: createdAt,
      ...(result === undefined ? {} : { result }),
    }) as unknown as OrchestratorRun;

  it('is undefined without authoritative state', () => {
    expect(claimedIdleReason(undefined)).toBeUndefined();
  });

  it('reads "never dispatched" off an absent task document', () => {
    expect(claimedIdleReason('absent')?.kind).toBe('never-dispatched');
  });

  it('reads "never dispatched" off an empty run history', () => {
    expect(claimedIdleReason({ runs: [] })).toEqual({
      kind: 'never-dispatched',
      label: 'Never dispatched',
    });
  });

  it('reads the newest run, not the first', () => {
    expect(
      claimedIdleReason({
        runs: [
          run('finished', { ok: false }, '2026-07-18T00:00:00Z'),
          run('finished', { ok: true }, '2026-07-19T00:00:00Z'),
        ],
      }),
    ).toEqual({ kind: 'finished', label: 'Finished, not closed' });
  });

  it('distinguishes park, failure, loss, and cancellation', () => {
    expect(
      claimedIdleReason({
        runs: [run('finished', { ok: true, summary: 'park' })],
      })?.kind,
    ).toBe('parked');
    expect(
      claimedIdleReason({ runs: [run('finished', { ok: false })] })?.kind,
    ).toBe('failed');
    expect(claimedIdleReason({ runs: [run('lost')] })?.kind).toBe('lost');
    expect(claimedIdleReason({ runs: [run('canceled')] })?.kind).toBe(
      'canceled',
    );
  });

  it('defers to the lock badge while the orchestrator still has a live run', () => {
    expect(
      claimedIdleReason({ activeRunId: 'r', runs: [run('pending')] }),
    ).toBeUndefined();
  });
});
