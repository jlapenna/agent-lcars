import { describe, expect, it } from 'vitest';

import { isNewerHookWrite } from './store';

const observer = {
  kind: 'hook' as const,
  runtime: 'claude-code' as const,
  host: 'laforge',
  seq: 5,
  eventId: 'e5',
  occurredAt: '2026-10-11T00:00:00.000Z',
};

describe('isNewerHookWrite', () => {
  it('refuses an equal or older seq from the same host', () => {
    expect(isNewerHookWrite({ ...observer, seq: 5 }, observer)).toBe(false);
    expect(isNewerHookWrite({ ...observer, seq: 9 }, observer)).toBe(false);
  });

  it('applies a newer seq, another host, a non-hook writer, or no stored observer', () => {
    expect(isNewerHookWrite({ ...observer, seq: 4 }, observer)).toBe(true);
    expect(
      isNewerHookWrite({ ...observer, host: 'janeway', seq: 99 }, observer),
    ).toBe(true);
    expect(
      isNewerHookWrite({ kind: 'daemon', host: 'laforge', seq: 99 }, observer),
    ).toBe(true);
    expect(isNewerHookWrite(undefined, observer)).toBe(true);
    expect(isNewerHookWrite({ ...observer, seq: 9 }, undefined)).toBe(true);
  });
});
