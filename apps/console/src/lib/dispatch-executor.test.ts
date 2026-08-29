import { describe, expect, it } from 'vitest';

import { dispatchExecutor } from './dispatch-executor';

describe('dispatchExecutor', () => {
  it('routes every provider through the one unified queue', () => {
    const unified = dispatchExecutor({
      AGENT_LCARS_UNIFIED_QUEUE_ENABLED: 'true',
    });
    expect(unified('claude')).toBe('queue');
    expect(unified('codex')).toBe('queue');
    expect(unified('opencode')).toBe('queue');
  });

  it.each([undefined, '', 'false', 'claude'])(
    'fails closed unless the unified queue is explicitly enabled (%s)',
    (value) => {
      expect(() =>
        dispatchExecutor({ AGENT_LCARS_UNIFIED_QUEUE_ENABLED: value }),
      ).toThrow('AGENT_LCARS_UNIFIED_QUEUE_ENABLED must be true');
    },
  );
});
