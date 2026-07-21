import { describe, expect, it } from 'vitest';

import { HasSessionAgent, sessionAgent } from './agent';

describe('sessionAgent', () => {
  it('returns the explicit agent when present', () => {
    expect(sessionAgent({ agent: 'opencode' })).toBe('opencode');
  });

  it('defaults to claude-code when agent is absent', () => {
    expect(sessionAgent({})).toBe('claude-code');
  });

  it('defaults to claude-code for a legacy doc/summary shape with no agent field at all', () => {
    // Simulates a pre-#3123 stored Firestore doc or reducer output, neither
    // of which ever wrote an `agent` key - the intersection type (rather
    // than a bare object literal) is what it takes for TS to accept this as
    // a HasSessionAgent at all, since a literal with zero properties in
    // common with an all-optional interface trips the "weak type" check.
    const legacy: HasSessionAgent & { sessionId: string; source: 'cli' } = {
      sessionId: 'session-1',
      source: 'cli',
    };
    expect(sessionAgent(legacy)).toBe('claude-code');
  });
});
