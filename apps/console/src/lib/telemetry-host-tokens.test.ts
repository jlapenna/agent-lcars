import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  parseTelemetryHostTokens,
  resolveTelemetryHostToken,
} from './telemetry-host-tokens';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('telemetry host tokens', () => {
  const tokens = parseTelemetryHostTokens(
    JSON.stringify([
      { host: 'laforge', tokenSha256: sha('tok-laforge') },
      { host: 'janeway', tokenSha256: sha('tok-janeway') },
    ]),
  );

  it('resolves a bearer to its bound host', () => {
    expect(resolveTelemetryHostToken('tok-laforge', tokens)).toBe('laforge');
    expect(resolveTelemetryHostToken('tok-janeway', tokens)).toBe('janeway');
    expect(resolveTelemetryHostToken('tok-pike', tokens)).toBeUndefined();
    expect(resolveTelemetryHostToken('', [])).toBeUndefined();
  });

  it('treats an empty variable as no tokens and rejects malformed entries', () => {
    expect(parseTelemetryHostTokens(undefined)).toEqual([]);
    expect(parseTelemetryHostTokens('  ')).toEqual([]);
    expect(() =>
      parseTelemetryHostTokens(
        JSON.stringify([{ host: 'x', tokenSha256: 'short' }]),
      ),
    ).toThrow();
    expect(() =>
      parseTelemetryHostTokens(
        JSON.stringify([{ host: 'bad host', tokenSha256: sha('a') }]),
      ),
    ).toThrow();
  });
});
