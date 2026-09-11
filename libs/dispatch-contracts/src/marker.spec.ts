import { describe, expect, it } from 'vitest';

import {
  formatAttemptId,
  formatClaimMarker,
  parseRunGeneration,
} from './marker';

describe('the attempt ID', () => {
  it('renders an orchestrator run ID (owner/repo#issue/rN), not just the legacy charset', () => {
    const attempt = { generation: 1, intentId: 'jlapenna/agent-lcars#1178/r1' };
    expect(formatAttemptId(attempt)).toBe('g1:jlapenna/agent-lcars#1178/r1');
  });
});

describe('formatClaimMarker', () => {
  it('renders a hidden HTML-comment marker carrying the attempt ID', () => {
    expect(formatClaimMarker('g1:intent-a')).toBe(
      '<!-- attempt-claim:g1:intent-a -->',
    );
  });
});

// Both namespaces use the same generation suffix. Keep parsing independent
// of server-only orchestrator/store imports so browser callers can share it.
describe.each(['octo/example#42', 'work:01J5Z3K9QX8F0N2B4V6C8D1E4H'])(
  'parseRunGeneration(%s)',
  (anchor) => {
    it.each([
      ['1', 1],
      ['12', 12],
      ['0', 0],
      ['001', 1],
      ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ])('preserves the numeric generation /r%s', (digits, generation) => {
      expect(parseRunGeneration(`${anchor}/r${digits}`)).toBe(generation);
    });

    it.each([
      '',
      '/r',
      '/r-1',
      '/r1.5',
      '/r1e3',
      '/rNaN',
      '/rInfinity',
      '/r1/trailing',
      '/r9007199254740992',
      '/r9007199254740993',
      `/r${'9'.repeat(400)}`,
    ])('leaves an invalid or unsafe suffix unknown: %s', (suffix) => {
      expect(parseRunGeneration(`${anchor}${suffix}`)).toBeUndefined();
    });
  },
);
