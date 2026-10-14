import { describe, expect, it } from 'vitest';

import type { SessionRow } from './session-archive';
import { matchesSessionFind } from './session-find';

const row = {
  sessionId: 'ses_123',
  title: 'Timely heartbeat',
  issueNumber: 2420,
  repo: { owner: 'jlapenna', name: 'agent-lcars' },
  prUrls: [{ number: 2483 }],
} as unknown as SessionRow;

describe('matchesSessionFind', () => {
  it('matches what a session row shows, case-insensitively', () => {
    expect(matchesSessionFind(row, undefined)).toBe(true);
    expect(matchesSessionFind(row, 'HEARTBEAT')).toBe(true);
    expect(matchesSessionFind(row, '#2420')).toBe(true);
    expect(matchesSessionFind(row, 'agent-lcars')).toBe(true);
    expect(matchesSessionFind(row, '#2483')).toBe(true);
    expect(matchesSessionFind(row, 'ses_123')).toBe(true);
    expect(matchesSessionFind(row, 'nothing')).toBe(false);
  });
});
