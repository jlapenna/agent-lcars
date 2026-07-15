import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { createAuthProxy } from './create-auth-proxy';

vi.mock('@repo/util-server', () => ({
  isE2eTesting: vi.fn().mockReturnValue(false),
  isImpersonate: vi.fn().mockReturnValue(false),
  isImpersonateAutomaticLogin: vi.fn().mockReturnValue(false),
  isMockAuthEnabled: vi.fn().mockReturnValue(false),
  isTrue: vi.fn().mockReturnValue(false),
}));

import {
  isE2eTesting,
  isImpersonate,
  isImpersonateAutomaticLogin,
  isMockAuthEnabled,
  isTrue,
} from '@repo/util-server';

const mockIsE2eTesting = isE2eTesting as Mock;
const mockIsImpersonate = isImpersonate as Mock;
const mockIsImpersonateAutomaticLogin = isImpersonateAutomaticLogin as Mock;
const mockIsMockAuthEnabled = isMockAuthEnabled as Mock;
const mockIsTrue = isTrue as Mock;

function request(
  path: string,
  init?: { cookie?: string; headers?: Record<string, string> },
) {
  const headers: Record<string, string> = { ...init?.headers };
  if (init?.cookie) {
    headers.cookie = init.cookie;
  }
  return new NextRequest(`http://localhost:4200${path}`, { headers });
}

const SESSION_COOKIE = 'authjs.session-token=abc';

beforeEach(() => {
  mockIsE2eTesting.mockReturnValue(false);
  mockIsImpersonate.mockReturnValue(false);
  mockIsImpersonateAutomaticLogin.mockReturnValue(false);
  mockIsMockAuthEnabled.mockReturnValue(false);
  mockIsTrue.mockReturnValue(false);
});

describe('createAuthProxy (public-allowlist mode)', () => {
  const proxy = createAuthProxy({
    publicRoutes: ['/', '/login', '/api/e2e/seed'],
    publicPrefixes: ['/invite/'],
  });

  it('lets public routes through without a session', () => {
    expect(proxy(request('/')).status).toBe(200);
    expect(proxy(request('/login')).status).toBe(200);
    expect(proxy(request('/api/e2e/seed')).status).toBe(200);
  });

  it('lets public prefixes through without a session', () => {
    expect(proxy(request('/invite/abc123')).status).toBe(200);
  });

  it('redirects unauthenticated page requests to /login', () => {
    const response = proxy(request('/dashboard'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:4200/login',
    );
  });

  it('returns 401 JSON for unauthenticated API requests', () => {
    const response = proxy(request('/api/private'));
    expect(response.status).toBe(401);
  });

  it('lets authenticated requests through (authjs cookie)', () => {
    expect(
      proxy(request('/dashboard', { cookie: SESSION_COOKIE })).status,
    ).toBe(200);
  });

  it('lets authenticated requests through (__Secure- cookie)', () => {
    const response = proxy(
      request('/dashboard', { cookie: '__Secure-authjs.session-token=abc' }),
    );
    expect(response.status).toBe(200);
  });

  it('treats impersonation as authenticated', () => {
    mockIsMockAuthEnabled.mockReturnValue(true);
    mockIsImpersonateAutomaticLogin.mockReturnValue(true);
    expect(proxy(request('/dashboard')).status).toBe(200);
  });

  it('returns 503 for all routes in maintenance mode', () => {
    mockIsTrue.mockImplementation((key: string) => key === 'MAINTENANCE_MODE');
    expect(proxy(request('/', { cookie: SESSION_COOKIE })).status).toBe(503);
    expect(proxy(request('/api/private')).status).toBe(503);
  });
});

describe('createAuthProxy (protected-allowlist mode)', () => {
  const proxy = createAuthProxy({
    protectedPatterns: [/^\/admin(\/.*)?$/, /^\/account(\/.*)?$/],
    loggedOutOnlyRoutes: ['/login', '/register'],
    loginRedirectParam: true,
  });

  it('lets unmatched routes through without a session', () => {
    expect(proxy(request('/view/race/123')).status).toBe(200);
  });

  it('redirects unauthenticated users off protected routes with ?redirect=', () => {
    const response = proxy(request('/admin/feeds'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:4200/login?redirect=%2Fadmin%2Ffeeds',
    );
  });

  it('lets authenticated users onto protected routes', () => {
    const response = proxy(request('/admin/feeds', { cookie: SESSION_COOKIE }));
    expect(response.status).toBe(200);
  });

  it('accepts legacy next-auth session cookies', () => {
    const response = proxy(
      request('/admin/feeds', { cookie: 'next-auth.session-token=abc' }),
    );
    expect(response.status).toBe(200);
  });

  it('bounces authenticated users off logged-out-only routes', () => {
    const response = proxy(request('/login', { cookie: SESSION_COOKIE }));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:4200/');
  });

  it('lets unauthenticated users onto logged-out-only routes', () => {
    expect(proxy(request('/login')).status).toBe(200);
  });
});

describe('createAuthProxy (e2e header forwarding)', () => {
  const proxy = createAuthProxy({
    protectedPatterns: [/^\/admin(\/.*)?$/],
  });

  it('forwards X-e2e-auth-user and skips gating during e2e runs', () => {
    mockIsE2eTesting.mockReturnValue(true);
    const response = proxy(
      request('/admin/feeds', {
        headers: { 'X-e2e-auth-user': '{"uid":"some-user"}' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-request-x-e2e-auth-user')).toBe(
      '{"uid":"some-user"}',
    );
  });

  it('ignores the header outside e2e runs', () => {
    const response = proxy(
      request('/admin/feeds', {
        headers: { 'X-e2e-auth-user': '{"uid":"some-user"}' },
      }),
    );
    expect(response.status).toBe(307);
  });
});
