import { readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  '/api/control-plane/reconcile',
  '/api/control-plane/request',
  '/api/control-plane/webhook',
  '/api/control-plane/webhook/process',
];

// Every control-plane route authenticates itself (OIDC claims or raw-body
// HMAC) and is called by machines that never carry a session cookie, so
// each one MUST be reachable through publicRoutes/publicPrefixes. Deriving
// the set from the route files on disk is what neither hand-maintained
// list could do: #1232's request route shipped absent from both lists and
// 401ed every caller (exactly as recovery-observation did before #885),
// while webhook/probe outlived its deleted route in both lists.
function controlPlaneRoutesOnDisk(): string[] {
  const base = join(__dirname, 'app', 'api', 'control-plane');
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'route.ts')
    .map((entry) => {
      const dir = join(entry.parentPath ?? entry.path, '.');
      const relative = dir.slice(base.length).replace(/\\/g, '/');
      return `/api/control-plane${relative}`;
    })
    .sort();
}

describe('console proxy public control-plane routes', () => {
  it('keeps the real allowlist in exact sync with the routes that must be public', () => {
    // Catches drift in both directions: an entry dropped from publicRoutes
    // (leaves callers 401ing, as recovery-observation did) or a route added
    // to publicRoutes without a conscious update here.
    expect([...publicRoutes].sort()).toEqual(
      [...EXPECTED_PUBLIC_ROUTES].sort(),
    );
  });

  it('lets every control-plane route that exists on disk through unauthenticated', () => {
    const routes = controlPlaneRoutesOnDisk();
    // If this list is ever empty the test is vacuously green — fail loud.
    expect(routes.length).toBeGreaterThan(0);
    for (const path of routes) {
      const request = new NextRequest(`https://lcars.jlapenna.net${path}`, {
        method: 'POST',
      });

      expect(
        proxy(request).status,
        `${path} must bypass the session check`,
      ).toBe(200);
    }
  });

  it('allowlists no control-plane route that no longer exists on disk', () => {
    const routes = controlPlaneRoutesOnDisk();
    for (const entry of publicRoutes) {
      if (!entry.startsWith('/api/control-plane/')) continue;
      expect(routes, `${entry} is allowlisted but has no route file`).toContain(
        entry,
      );
    }
  });

  it('lets every route that must be public through unauthenticated', () => {
    for (const path of EXPECTED_PUBLIC_ROUTES) {
      const request = new NextRequest(`https://lcars.jlapenna.net${path}`, {
        method: 'POST',
      });

      expect(proxy(request).status).toBe(200);
    }
  });

  it('exposes only the exact evidence route prefix without a session', () => {
    const evidence = new NextRequest(
      'https://lcars.jlapenna.net/api/quick-task-evidence/v1/0d6a4b56-31d0-4d39-b0b2-5a2520cc4882',
    );
    const adjacent = new NextRequest(
      'https://lcars.jlapenna.net/api/quick-task-evidence/admin',
    );

    expect(proxy(evidence).status).toBe(200);
    expect(proxy(adjacent).status).toBe(401);
  });
});
