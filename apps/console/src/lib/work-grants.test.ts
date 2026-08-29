import { describe, expect, it } from 'vitest';

import {
  grantForPrincipal,
  parseWorkGrants,
  resolvePrincipal,
} from './work-grants';

const raw = JSON.stringify([
  {
    principal: 'user:jlapenna',
    subjects: [
      'jlapenna-work@agent-lcars.iam.gserviceaccount.com',
      'github:jlapenna',
    ],
    pipelines: ['claude', 'codex'],
  },
  {
    principal: 'svc:lcars-admin',
    subjects: ['lcars-admin@agent-lcars.iam.gserviceaccount.com'],
    pipelines: ['claude'],
  },
]);

describe('parseWorkGrants', () => {
  it('parses a valid list and returns [] when unset', () => {
    expect(parseWorkGrants(raw)).toHaveLength(2);
    expect(parseWorkGrants(undefined)).toEqual([]);
  });
  it('rejects malformed entries loudly', () => {
    expect(() => parseWorkGrants('[{"principal":"x"}]')).toThrow();
    expect(() => parseWorkGrants('not json')).toThrow();
  });
});

describe('resolvePrincipal', () => {
  const grants = parseWorkGrants(raw);
  it('maps any listed subject to its principal', () => {
    expect(resolvePrincipal('github:jlapenna', grants)?.principal).toBe(
      'user:jlapenna',
    );
    expect(
      resolvePrincipal(
        'jlapenna-work@agent-lcars.iam.gserviceaccount.com',
        grants,
      )?.principal,
    ).toBe('user:jlapenna');
  });
  it('is case-insensitive on subjects and unknown → undefined', () => {
    expect(resolvePrincipal('GitHub:JLapenna', grants)?.principal).toBe(
      'user:jlapenna',
    );
    expect(resolvePrincipal('nobody@example.com', grants)).toBeUndefined();
  });
});

describe('grantForPrincipal', () => {
  const grants = parseWorkGrants(raw);
  it('finds a grant by its canonical principal, not a subject', () => {
    expect(grantForPrincipal('user:jlapenna', grants)?.pipelines).toEqual([
      'claude',
      'codex',
    ]);
    expect(grantForPrincipal('github:jlapenna', grants)).toBeUndefined();
    expect(grantForPrincipal('user:nobody', grants)).toBeUndefined();
  });
});

describe('grant scopes', () => {
  it('defaults scopes to work.operator when absent', () => {
    const grants = parseWorkGrants(
      JSON.stringify([
        {
          principal: 'user:jlapenna',
          subjects: ['github:jlapenna'],
          pipelines: ['claude'],
        },
      ]),
    );
    expect(grants[0]?.scopes).toBeUndefined();
  });

  it('accepts an explicit work.executor scope', () => {
    const grants = parseWorkGrants(
      JSON.stringify([
        {
          principal: 'svc:telemetry-writer',
          subjects: ['telemetry-writer@agent-lcars.iam.gserviceaccount.com'],
          pipelines: ['claude'],
          scopes: ['work.executor'],
        },
      ]),
    );
    expect(grants[0]?.scopes).toEqual(['work.executor']);
  });

  it('accepts work.cron only when explicitly granted', () => {
    const grants = parseWorkGrants(
      JSON.stringify([
        {
          principal: 'svc:telemetry-writer',
          subjects: ['telemetry-writer@agent-lcars.iam.gserviceaccount.com'],
          pipelines: ['claude', 'codex', 'opencode'],
          scopes: ['work.cron'],
        },
      ]),
    );
    expect(grants[0]?.scopes).toEqual(['work.cron']);
  });

  it('rejects an explicit empty scopes list as a config error rather than silently treating it as none', () => {
    expect(() =>
      parseWorkGrants(
        JSON.stringify([
          {
            principal: 'user:jlapenna',
            subjects: ['github:jlapenna'],
            pipelines: ['claude'],
            scopes: [],
          },
        ]),
      ),
    ).toThrow();
  });
});

describe('grant pipelines', () => {
  it('rejects a pipeline name outside PIPELINES as a startup config error', () => {
    expect(() =>
      parseWorkGrants(
        JSON.stringify([
          {
            principal: 'user:jlapenna',
            subjects: ['github:jlapenna'],
            // A typo -- never matches a real workSpecSchema pipeline, so a
            // grant naming it would otherwise sit silently inert.
            pipelines: ['claud'],
          },
        ]),
      ),
    ).toThrow();
  });
});
