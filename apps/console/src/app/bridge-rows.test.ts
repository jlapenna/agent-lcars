import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { AgentRun } from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import type { BoardCard } from './board-card';
import { resolveBridgeDetail } from './bridge-rows';

const repo = { owner: 'jlapenna', name: 'agent-lcars' };

function run(id: string, issueNumber?: number): AgentRun {
  return { id, repo, issueNumber } as unknown as AgentRun;
}
function session(sessionId: string): CliSession {
  return { sessionId } as CliSession;
}
function card(number: number): BoardCard {
  return {
    item: { repo, number, kind: 'issue', title: `#${number}` } as ActionItem,
  };
}

const base = {
  liveRuns: [run('live1', 10)],
  recentRuns: [run('recent1', 20)],
  cliSessions: [session('sess1')],
  waitingOnDeploy: [card(30)],
  blocked: [card(40)],
};

describe('resolveBridgeDetail', () => {
  it('resolves nothing without a selection', () => {
    expect(resolveBridgeDetail({ ...base, selectedKey: undefined }).kind).toBe(
      'none',
    );
  });

  it('resolves a live run with its joined item and session', () => {
    const detail = resolveBridgeDetail({
      ...base,
      selectedKey: 'run:live1',
      itemsByRunId: { live1: { number: 10, title: 'Ten', url: 'u' } },
      sessionsByRunId: { live1: { sessionId: 'x' } },
    });
    expect(detail).toMatchObject({
      kind: 'liveRun',
      run: { id: 'live1' },
      item: { number: 10 },
      session: { sessionId: 'x' },
    });
  });

  it('resolves a recent run', () => {
    const detail = resolveBridgeDetail({
      ...base,
      selectedKey: 'run:recent1',
    });
    expect(detail).toMatchObject({ kind: 'recentRun', run: { id: 'recent1' } });
  });

  it('prefers the live run when the same run id is both live and recent', () => {
    const dup = { ...base, liveRuns: [run('both')], recentRuns: [run('both')] };
    expect(resolveBridgeDetail({ ...dup, selectedKey: 'run:both' }).kind).toBe(
      'liveRun',
    );
  });

  it('resolves a CLI session', () => {
    expect(
      resolveBridgeDetail({ ...base, selectedKey: 'session:sess1' }).kind,
    ).toBe('session');
  });

  it('resolves a deploy-wait item and carries the repo multiplicity', () => {
    const detail = resolveBridgeDetail({
      ...base,
      selectedKey: 'item:jlapenna/agent-lcars#30',
      multiRepo: true,
    });
    expect(detail).toMatchObject({
      kind: 'item',
      multiRepo: true,
      card: { item: { number: 30 } },
    });
  });

  it('resolves a blocked item the same way as a deploy-wait item', () => {
    const detail = resolveBridgeDetail({
      ...base,
      selectedKey: 'item:jlapenna/agent-lcars#40',
    });
    expect(detail).toMatchObject({
      kind: 'item',
      card: { item: { number: 40 } },
    });
  });

  it('falls back to none for a stale or filtered-out selection', () => {
    expect(resolveBridgeDetail({ ...base, selectedKey: 'run:gone' }).kind).toBe(
      'none',
    );
  });

  it('resolves a parked work item', () => {
    const parkedWork = [{ id: 'work:ulid1' }] as never;
    const detail = resolveBridgeDetail({
      ...base,
      parkedWork,
      selectedKey: 'parked:work:ulid1',
    });
    expect(detail).toMatchObject({
      kind: 'parkedWork',
      item: { id: 'work:ulid1' },
    });
  });
});
