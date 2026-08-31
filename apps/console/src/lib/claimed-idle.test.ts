import { describe, expect, it } from 'vitest';

import type { ActionItem } from './action-items';
import {
  deriveClaimedIdle,
  findItemForSession,
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

describe('findItemForSession', () => {
  it('returns the item whose number the session references', () => {
    const items = [makeItem({ number: 10 }), makeItem({ number: 20 })];
    const session = makeSession({ pr: { number: 20, url: 'u' } });
    expect(findItemForSession(session, items)?.number).toBe(20);
  });

  it('returns undefined when no item matches', () => {
    const items = [makeItem({ number: 10 })];
    const session = makeSession({ branch: 'unrelated-branch' });
    expect(findItemForSession(session, items)).toBeUndefined();
  });
});

describe('mostRecentSessionForItem', () => {
  it('finds an ended/stale session, unlike findItemForSession/deriveClaimedIdle', () => {
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
