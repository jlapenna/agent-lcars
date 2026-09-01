import { describe, expect, it } from 'vitest';

import { formatAttemptId, formatClaimMarker } from './marker';

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
