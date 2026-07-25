import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuthProxy } from './auth-proxy';

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/dashboard', { headers });
}

describe('createAuthProxy', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['E2E_TESTING'];
    delete process.env['K_SERVICE'];
    delete process.env['K_REVISION'];
    delete process.env['CLOUD_RUN_JOB'];
    delete process.env['MAINTENANCE_MODE'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows the E2E bypass header when not running on Cloud Run', () => {
    process.env['E2E_TESTING'] = 'true';
    const proxy = createAuthProxy();

    const response = proxy(makeRequest({ 'x-e2e-auth-user': 'admin' }));

    expect(response.status).toBe(200);
  });

  it('never honors the E2E bypass header on a real Cloud Run instance, even if E2E_TESTING leaks into the runtime env', () => {
    process.env['E2E_TESTING'] = 'true';
    process.env['K_SERVICE'] = 'agent-console-frontend';
    const proxy = createAuthProxy();

    const response = proxy(makeRequest({ 'x-e2e-auth-user': 'admin' }));

    // Falls through to the normal unauthenticated path: redirect to /login.
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('redirects an unauthenticated request with no session cookie', () => {
    const proxy = createAuthProxy();

    const response = proxy(makeRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });
});
