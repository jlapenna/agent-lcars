import { describe, expect, it } from 'vitest';

import { dispatchExecutor } from './dispatch-executor';

describe('dispatchExecutor', () => {
  it('preserves the legacy selector until the global cutover', () => {
    const staged = dispatchExecutor({
      AGENT_LCARS_UNIFIED_QUEUE_ENABLED: 'false',
      AGENT_LCARS_QUEUE_PIPELINES: '["claude"]',
    });
    expect(staged('claude')).toBe('queue');
    expect(staged('codex')).toBeUndefined();
    expect(staged('opencode')).toBeUndefined();
  });

  it('makes every provider queue-routed at the global cutover', () => {
    const unified = dispatchExecutor({
      AGENT_LCARS_UNIFIED_QUEUE_ENABLED: 'true',
      AGENT_LCARS_QUEUE_PIPELINES: '["claude"]',
    });
    expect(unified('claude')).toBe('queue');
    expect(unified('codex')).toBe('queue');
    expect(unified('opencode')).toBe('queue');
  });

  it('fails closed on a malformed deployment setting', () => {
    expect(() =>
      dispatchExecutor({ AGENT_LCARS_UNIFIED_QUEUE_ENABLED: 'claude' }),
    ).toThrow('AGENT_LCARS_UNIFIED_QUEUE_ENABLED must be true or false');
  });
});
