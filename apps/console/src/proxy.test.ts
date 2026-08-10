import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import proxy, { publicRoutes } from './proxy';

// Kept independent of proxy.ts's publicRoutes export on purpose (Codex
// review on #894): asserting against a copy of THIS list, rather than
// iterating publicRoutes directly, is what lets the exact-equality check
// below catch a route silently disappearing from the real allowlist - the
// actual #885 failure mode (recovery-observation shipped without ever
// being added to publicRoutes). Iterating the real array instead would
// have made the loop just as blind to that omission as production was.
const EXPECTED_PUBLIC_ROUTES = [
  '/login',
  '/api/logs/error',
  '/api/control-plane/completion',
  '/api/control-plane/completion/reconcile',
  '/api/control-plane/reconcile',
  '/api/control-plane/recovery-observation',
  '/api/control-plane/webhook',
  '/api/control-plane/webhook/process',
  '/api/control-plane/webhook/probe',
];

describe('console proxy public control-plane routes', () => {
  it('keeps the real allowlist in exact sync with the routes that must be public', () => {
    // Catches drift in both directions: an entry dropped from publicRoutes
    // (leaves callers 401ing, as recovery-observation did) or a route added
    // to publicRoutes without a conscious update here.
    expect([...publicRoutes].sort()).toEqual(
      [...EXPECTED_PUBLIC_ROUTES].sort(),
    );
  });

  it('lets every route that must be public through unauthenticated', () => {
    for (const path of EXPECTED_PUBLIC_ROUTES) {
      const request = new NextRequest(`https://lcars.jlapenna.net${path}`, {
        method: 'POST',
      });

      expect(proxy(request).status).toBe(200);
    }
  });

  it('lets non-browser callers read the public authoritative task-state projection', () => {
    const request = new NextRequest(
      'https://lcars.jlapenna.net/api/control-plane/task-state/jlapenna/agent-lcars/779?repositoryId=1307149765',
    );

    expect(proxy(request).status).toBe(200);
  });
});
