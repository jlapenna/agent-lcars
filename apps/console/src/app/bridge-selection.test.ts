import { describe, expect, it } from 'vitest';

import type { ActionItem } from '../lib/action-items';
import type { AgentRun } from '../lib/agent-activity';
import type { CliSession } from '../lib/cli-sessions';
import {
  bridgeSelectionHref,
  itemKey,
  parseBridgeSelection,
  runKey,
  sessionKey,
} from './bridge-selection';

const repo = { owner: 'jlapenna', name: 'agent-lcars' };

function run(id: string): AgentRun {
  return { id } as AgentRun;
}

function session(sessionId: string): CliSession {
  return { sessionId } as CliSession;
}

function item(number: number): ActionItem {
  return { repo, number, kind: 'issue' } as ActionItem;
}

describe('bridge selection keys', () => {
  it('namespaces each row kind so ids from different kinds cannot collide', () => {
    expect(runKey(run('r1'))).toBe('run:r1');
    expect(sessionKey(session('s1'))).toBe('session:s1');
    expect(itemKey(item(42))).toBe('item:jlapenna/agent-lcars#42');
    expect(runKey(run('s1'))).not.toBe(sessionKey(session('s1')));
  });
});

describe('bridgeSelectionHref', () => {
  it('builds a bare selection link when no repo scope is active', () => {
    expect(bridgeSelectionHref('run:r1')).toBe('/?sel=run%3Ar1');
  });

  it('preserves the active repo scope alongside the selection', () => {
    expect(bridgeSelectionHref('run:r1', 'jlapenna/other')).toBe(
      '/?repo=jlapenna%2Fother&sel=run%3Ar1',
    );
  });

  it('clears the selection back to the scoped page when key is undefined', () => {
    expect(bridgeSelectionHref(undefined)).toBe('/');
    expect(bridgeSelectionHref(undefined, 'jlapenna/other')).toBe(
      '/?repo=jlapenna%2Fother',
    );
  });
});

describe('parseBridgeSelection', () => {
  it('treats a missing or empty param as no selection', () => {
    expect(parseBridgeSelection(undefined)).toBeUndefined();
    expect(parseBridgeSelection('')).toBeUndefined();
  });

  it('round-trips a real key', () => {
    expect(parseBridgeSelection('item:jlapenna/agent-lcars#42')).toBe(
      'item:jlapenna/agent-lcars#42',
    );
  });
});
