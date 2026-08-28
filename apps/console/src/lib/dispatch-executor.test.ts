import { describe, expect, it } from 'vitest';

import { dispatchExecutor } from './dispatch-executor';

describe('dispatchExecutor', () => {
  it('uses one staged deployment switch, never a provider route list', () => {
    expect(dispatchExecutor({})).toBeUndefined();
    expect(dispatchExecutor({ AGENT_LCARS_UNIFIED_QUEUE_ENABLED: '' })).toBe(
      undefined,
    );
    expect(
      dispatchExecutor({ AGENT_LCARS_UNIFIED_QUEUE_ENABLED: 'false' }),
    ).toBeUndefined();
    expect(
      dispatchExecutor({ AGENT_LCARS_UNIFIED_QUEUE_ENABLED: 'true' }),
    ).toBe('queue');
  });

  it('fails closed on a malformed deployment setting', () => {
    expect(() =>
      dispatchExecutor({ AGENT_LCARS_UNIFIED_QUEUE_ENABLED: 'claude' }),
    ).toThrow('AGENT_LCARS_UNIFIED_QUEUE_ENABLED must be true or false');
  });
});
