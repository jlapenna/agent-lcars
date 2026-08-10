import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import proxy, { publicRoutes } from './proxy';

describe('console proxy public control-plane routes', () => {
  it('lets every route on the real public allowlist through unauthenticated', () => {
    // Iterates the actual exported publicRoutes array (not a hand-copied
    // subset) so a route added to production without a matching entry
    // here would need to be missing from THAT array too to escape this
    // test - the failure mode that left recovery-observation 401ing 100%
    // of its callers (#885) can't hide behind a stale copy.
    for (const path of publicRoutes) {
      const request = new NextRequest(
        `https://agent-console.supersprinkles.racing${path}`,
        { method: 'POST' },
      );

      expect(proxy(request).status).toBe(200);
    }
  });

  it('lets non-browser callers read the public authoritative task-state projection', () => {
    const request = new NextRequest(
      'https://agent-console.supersprinkles.racing/api/control-plane/task-state/jlapenna/agent-lcars/779?repositoryId=1307149765',
    );

    expect(proxy(request).status).toBe(200);
  });
});
