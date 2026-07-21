import { describe, expect, it } from 'vitest';

import type { ActionItem } from './action-items';
import {
  deriveClaimedIdle,
  findItemForSession,
  sessionReferencesItemNumber,
} from './claimed-idle';
import type { CliSession } from './cli-sessions';

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    kind: 'issue',
    number: 42,
    title: 'Fix the thing',
    url: 'https://github.com/supersprinklesracing/members/issues/42',
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
    expect(sessionReferencesItemNumber(session, 42)).toBe(true);
    expect(sessionReferencesItemNumber(session, 43)).toBe(false);
  });

  it('matches when the item number appears in the branch, bounded by non-digits', () => {
    const session = makeSession({
      branch: 'agent-lcars-agents-page-3024',
    });
    expect(sessionReferencesItemNumber(session, 3024)).toBe(true);
  });

  it('does not false-match a shorter number embedded in a longer one', () => {
    const session = makeSession({ branch: 'fix-primes-backend-oom-2819' });
    expect(sessionReferencesItemNumber(session, 281)).toBe(false);
    expect(sessionReferencesItemNumber(session, 819)).toBe(false);
    expect(sessionReferencesItemNumber(session, 2819)).toBe(true);
  });

  it('returns false with neither a PR nor a branch', () => {
    expect(sessionReferencesItemNumber(makeSession(), 42)).toBe(false);
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

describe('deriveClaimedIdle', () => {
  const noLiveRun = () => false;
  const allLiveRun = () => true;

  it('includes an open jclaw-bot claim with no live run and no active session', () => {
    const items = [makeItem({ number: 1, assigneeLogins: ['jclaw-bot'] })];
    expect(deriveClaimedIdle(items, noLiveRun, [])).toEqual(items);
  });

  it('excludes items not assigned to jclaw-bot', () => {
    const items = [makeItem({ number: 1, assigneeLogins: ['jlapenna'] })];
    expect(deriveClaimedIdle(items, noLiveRun, [])).toEqual([]);
  });

  it('excludes items with a live run', () => {
    const items = [makeItem({ number: 1, assigneeLogins: ['jclaw-bot'] })];
    expect(deriveClaimedIdle(items, allLiveRun, [])).toEqual([]);
  });

  it('excludes items an active CLI session is working', () => {
    const items = [makeItem({ number: 1, assigneeLogins: ['jclaw-bot'] })];
    const sessions = [makeSession({ pr: { number: 1, url: 'u' } })];
    expect(deriveClaimedIdle(items, noLiveRun, sessions)).toEqual([]);
  });

  it('does not let an unrelated active session mask a genuinely stale claim', () => {
    const items = [makeItem({ number: 1, assigneeLogins: ['jclaw-bot'] })];
    const sessions = [makeSession({ pr: { number: 999, url: 'u' } })];
    expect(deriveClaimedIdle(items, noLiveRun, sessions)).toEqual(items);
  });
});
