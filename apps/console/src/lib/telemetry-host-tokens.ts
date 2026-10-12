import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/**
 * Per-host bearer tokens for the hook telemetry ingest route
 * (docs/hooks-telemetry-design.md §4.4). A workstation gets one random
 * token; only its SHA-256 lives in the console's environment, bound to the
 * `host` label the client must put on every event. Rotation is a new hash
 * here plus the homegit secret bump; nothing on the workstation needs a
 * Google credential.
 */
const hostTokenSchema = z.strictObject({
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  /** Lowercase hex SHA-256 of the raw bearer token. */
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
const hostTokensSchema = z.array(hostTokenSchema);

export type TelemetryHostToken = z.infer<typeof hostTokenSchema>;

export function parseTelemetryHostTokens(
  raw: string | undefined,
): TelemetryHostToken[] {
  if (raw === undefined || raw.trim() === '') return [];
  return hostTokensSchema.parse(JSON.parse(raw));
}

let cached:
  { raw: string | undefined; tokens: TelemetryHostToken[] } | undefined;
export function telemetryHostTokens(): TelemetryHostToken[] {
  const raw = process.env['AGENT_LCARS_TELEMETRY_HOST_TOKENS'];
  if (cached === undefined || cached.raw !== raw) {
    cached = { raw, tokens: parseTelemetryHostTokens(raw) };
  }
  return cached.tokens;
}

/** The host a raw bearer token is bound to, or `undefined`. Compares every
 * configured hash in constant time so a mismatch leaks nothing about which
 * host a guessed token was close to. */
export function resolveTelemetryHostToken(
  bearer: string,
  tokens: readonly TelemetryHostToken[] = telemetryHostTokens(),
): string | undefined {
  const digest = createHash('sha256').update(bearer).digest();
  let matched: string | undefined;
  for (const token of tokens) {
    const candidate = Buffer.from(token.tokenSha256, 'hex');
    if (
      candidate.length === digest.length &&
      timingSafeEqual(candidate, digest)
    ) {
      matched ??= token.host;
    }
  }
  return matched;
}
