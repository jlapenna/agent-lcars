import { savedSessionExpiration, sessionStatus } from './saved-session-lib.mjs';

export function savedSessionReadiness(
  storageState,
  minimumValidDays,
  nowSeconds = Date.now() / 1000,
) {
  const expiration = savedSessionExpiration(storageState);
  if (expiration === undefined) return { status: 'unknown' };
  const expiresAt = new Date(expiration * 1000).toISOString();
  const rotateBy = new Date(
    (expiration - minimumValidDays * 86_400) * 1000,
  ).toISOString();
  const status =
    expiration <= nowSeconds
      ? 'expired'
      : expiration < nowSeconds + minimumValidDays * 86_400
        ? 'expiring'
        : 'ready';
  return { status, expiresAt, rotateBy };
}

/** One read-only Auth.js request; no browser launch or saved-state refresh. */
export async function authenticatedSessionReadiness(
  storageState,
  { origin, role, minimumValidDays },
  { requestFactory, nowSeconds = Date.now() / 1000 } = {},
) {
  const lifetime = savedSessionReadiness(
    storageState,
    minimumValidDays,
    nowSeconds,
  );
  if (lifetime.status === 'expired') return lifetime;

  const context = await requestFactory.newContext({ storageState });
  try {
    const response = await context.get(
      new URL('/api/auth/session', origin).toString(),
      {
        timeout: 10_000,
        maxRedirects: 0,
      },
    );
    if (!response.ok()) throw new Error('Auth.js readiness request failed.');
    const status = sessionStatus(await response.json(), role);
    if (status !== 'ok') return { ...lifetime, status };
    return lifetime;
  } finally {
    await context.dispose();
  }
}

export function readinessExitCode(status) {
  return (
    { ready: 0, expired: 2, 'wrong-role': 3, expiring: 4, unknown: 4 }[
      status
    ] ?? 1
  );
}

export function readinessMessage(readiness) {
  const marker =
    {
      ready: 'SESSION_READY',
      expired: 'SESSION_EXPIRED',
      'wrong-role': 'ROLE_MISMATCH',
      expiring: 'SESSION_EXPIRING',
      unknown: 'SESSION_EXPIRY_UNKNOWN',
    }[readiness.status] ?? 'SESSION_READINESS_UNAVAILABLE';
  const deadline = readiness.expiresAt
    ? ` expiresAt=${readiness.expiresAt} rotateBy=${readiness.rotateBy}`
    : ' No persistent Auth.js expiry; rotation cannot be scheduled safely.';
  const recovery = ['expired', 'expiring', 'unknown'].includes(readiness.status)
    ? ' Ask the operator to rotate with the documented mint-session or capture-session procedure.'
    : readiness.status === 'wrong-role'
      ? ' Use a saved session with the requested role.'
      : '';
  return `${marker}:${deadline}${recovery}`;
}
