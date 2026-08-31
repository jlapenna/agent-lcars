import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import proxy, { publicPrefixes, publicRoutes } from './proxy';

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
  '/api/control-plane/reconcile',
  '/api/control-plane/projections/reconcile',
  '/api/control-plane/webhook',
  '/api/control-plane/webhook/process',
];

// Same reasoning as EXPECTED_PUBLIC_ROUTES above, for the prefix list: a
// copy here is what makes an entry silently disappearing from the real
// publicPrefixes fail loudly instead of just widening the session gate.
const EXPECTED_PUBLIC_PREFIXES = [
  '/api/e2e/',
  '/api/quick-task-evidence/v1/',
  '/api/work/v1/',
];

// Every control-plane route authenticates itself (OIDC claims or raw-body
// HMAC) and is called by machines that never carry a session cookie, so
// each one MUST be reachable through publicRoutes/publicPrefixes. Deriving
// the set from the route files on disk avoids stale exceptions when a route
// is deleted or a new machine endpoint is added.
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

// The work API authenticates itself too (a Google-signed bearer, or an
// Auth.js session read by the route itself), and its 401 is the router's
// own middleware -- not the proxy's cookie check, which would answer a
// bearer-only caller with a bare {"error":"Unauthorized"} before oRPC ever
// saw the request. Derived from disk for the same reason the control-plane
// scan is: a route file added under app/api/work without a matching
// publicPrefixes entry is exactly #1232's failure mode.
function workRoutePrefixesOnDisk(): string[] {
  const base = join(__dirname, 'app', 'api', 'work');
  return readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'route.ts')
    .map((entry) => {
      const dir = join(entry.parentPath ?? entry.path, '.');
      const relative = dir.slice(base.length).replace(/\\/g, '/');
      // Only the static head of a route can appear in publicPrefixes:
      // stop at the first Next dynamic/catch-all segment (`[id]`,
      // `[[...rest]]`), which matches arbitrary path text at runtime.
      const staticSegments: string[] = [];
      for (const segment of relative.split('/').filter(Boolean)) {
        if (segment.startsWith('[')) break;
        staticSegments.push(segment);
      }
      // Trailing slash so the coverage check below is segment-terminated:
      // '/api/work/v1beta/' must NOT be considered covered by a
      // '/api/work/v1/' entry. Without it, `startsWith` would call a
      // v1beta sibling covered and this whole test would pass wrongly for
      // a route nobody had allow-listed.
      return `${['/api/work', ...staticSegments].join('/')}/`;
    })
    .sort();
}

describe('console proxy public work API prefixes', () => {
  it('keeps the real prefix allowlist in exact sync with what must be public', () => {
    expect([...publicPrefixes].sort()).toEqual(
      [...EXPECTED_PUBLIC_PREFIXES].sort(),
    );
  });

  it('covers every work API route on disk with a publicPrefixes entry', () => {
    const routes = workRoutePrefixesOnDisk();
    // If this list is ever empty the test is vacuously green — fail loud.
    expect(routes.length).toBeGreaterThan(0);
    for (const path of routes) {
      expect(
        publicPrefixes.some((prefix) => path.startsWith(prefix)),
        `${path} must be covered by a publicPrefixes entry`,
      ).toBe(true);

      const request = new NextRequest(
        `https://lcars.jlapenna.net${path}items`,
        { method: 'GET' },
      );
      expect(
        proxy(request).status,
        `${path} must bypass the session check`,
      ).toBe(200);
    }
  });

  it('does not treat a sibling version segment as covered by the v1 prefix', () => {
    // The exact drift the trailing slash exists to prevent: a future
    // app/api/work/v1beta route must fail the coverage check above and be
    // gated by the proxy, not inherit v1's allow-list entry.
    expect(
      publicPrefixes.some((prefix) => '/api/work/v1beta/'.startsWith(prefix)),
    ).toBe(false);
    expect(
      proxy(new NextRequest('https://lcars.jlapenna.net/api/work/v1beta/items'))
        .status,
    ).toBe(401);
  });

  it('leaves a sibling work path outside the versioned prefix behind the session gate', () => {
    const adjacent = new NextRequest(
      'https://lcars.jlapenna.net/api/work/admin',
    );

    expect(proxy(adjacent).status).toBe(401);
  });
});

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
