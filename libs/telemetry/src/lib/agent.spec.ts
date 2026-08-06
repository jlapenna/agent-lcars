import { describe, expect, it } from 'vitest';

import { HasSessionAgent, isSessionRenderable, sessionAgent } from './agent';

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

describe('isSessionRenderable', () => {
  it('returns the explicit renderable value when present, regardless of agent', () => {
    expect(isSessionRenderable({ agent: 'codex', renderable: true })).toBe(
      true,
    );
    expect(
      isSessionRenderable({ agent: 'claude-code', renderable: false }),
    ).toBe(false);
  });

  // A doc/summary stored before #645 added this field carries no
  // `renderable` key at all - falling back to the pre-#645 gate keeps every
  // already-shipped Claude Code session's timeline rendering exactly as it
  // did before this change, rather than blanking out on a field those docs
  // never had a chance to set.
  it('falls back to the pre-#645 claude-code gate when renderable is absent', () => {
    expect(isSessionRenderable({ agent: 'claude-code' })).toBe(true);
    expect(isSessionRenderable({ agent: 'codex' })).toBe(false);
    expect(isSessionRenderable({})).toBe(true);
  });
});
