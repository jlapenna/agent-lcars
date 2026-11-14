import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

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
    scopes: ['work.operator'],
  },
  {
    principal: 'svc:lcars-admin',
    subjects: ['lcars-admin@agent-lcars.iam.gserviceaccount.com'],
    pipelines: ['claude'],
    scopes: ['work.operator'],
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
  it('rejects missing scopes rather than granting work.operator implicitly', () => {
    expect(() =>
      parseWorkGrants(
        JSON.stringify([
          {
            principal: 'user:jlapenna',
            subjects: ['github:jlapenna'],
            pipelines: ['claude'],
          },
        ]),
      ),
    ).toThrow();
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

  it('accepts work.reader as its own scope, implying nothing else', () => {
    const grants = parseWorkGrants(
      JSON.stringify([
        {
          principal: 'svc:work-reader',
          subjects: ['work-reader@agent-lcars.iam.gserviceaccount.com'],
          pipelines: ['claude', 'codex', 'opencode'],
          scopes: ['work.reader'],
        },
      ]),
    );
    expect(grants[0]?.scopes).toEqual(['work.reader']);
  });

  it('rejects an unknown scope rather than ignoring it', () => {
    expect(() =>
      parseWorkGrants(
        JSON.stringify([
          {
            principal: 'svc:work-reader',
            subjects: ['work-reader@agent-lcars.iam.gserviceaccount.com'],
            pipelines: ['claude'],
            scopes: ['work.read'],
          },
        ]),
      ),
    ).toThrow();
  });

  it('commits only issue-owner and cost-assessment read scopes for work-reader', () => {
    const config = parseYaml(
      readFileSync(
        path.join(import.meta.dirname, '../../apphosting.yaml'),
        'utf8',
      ),
    ) as { env: { variable: string; value?: string }[] };
    const grants = parseWorkGrants(
      config.env.find((entry) => entry.variable === 'AGENT_LCARS_WORK_GRANTS')
        ?.value,
    );
    const subject = 'work-reader@agent-lcars.iam.gserviceaccount.com';
    expect(resolvePrincipal(subject, grants)).toMatchObject({
      principal: 'svc:work-reader',
      subjects: [subject],
      scopes: ['work.reader', 'costs.reader'],
    });
    // No other grant names the reader, and no other grant uses its scope.
    expect(
      grants.filter((grant) =>
        grant.subjects.some((s) => s.toLowerCase() === subject),
      ),
    ).toHaveLength(1);
    expect(
      grants
        .filter((grant) => grant.scopes.includes('work.reader'))
        .map((grant) => grant.principal),
    ).toEqual(['svc:work-reader']);
  });

  it('commits work.cron only to the never-runner-mounted scheduler identity (#3217)', () => {
    const config = parseYaml(
      readFileSync(
        path.join(import.meta.dirname, '../../apphosting.yaml'),
        'utf8',
      ),
    ) as { env: { variable: string; value?: string }[] };
    const grants = parseWorkGrants(
      config.env.find((entry) => entry.variable === 'AGENT_LCARS_WORK_GRANTS')
        ?.value,
    );
    // jobAutomationPrincipal disables automatic activation (and schedule
    // admission under the automation principal) unless exactly one grant
    // holds work.cron for goose.
    expect(
      grants
        .filter(
          (grant) =>
            grant.scopes.includes('work.cron') &&
            grant.pipelines.includes('goose'),
        )
        .map((grant) => grant.principal),
    ).toEqual(['svc:job-scheduler']);
    // The runner-mounted executor key never carries scheduler authority.
    expect(
      grants
        .filter((grant) => grant.scopes.includes('work.cron'))
        .map((grant) => grant.principal),
    ).toEqual(['svc:job-scheduler']);
    // The scheduler key is never runner-mounted; it must not gain claim or
    // operator authority.
    expect(
      resolvePrincipal(
        'job-scheduler@agent-lcars.iam.gserviceaccount.com',
        grants,
      ),
    ).toMatchObject({ principal: 'svc:job-scheduler', scopes: ['work.cron'] });
  });

  it('rejects an explicit empty scopes list as a config error', () => {
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
            scopes: ['work.operator'],
          },
        ]),
      ),
    ).toThrow();
  });
});

describe('grant channel', () => {
  it("accepts a grant declaring channel: slack, drawn from workOriginSchema's set", () => {
    const grants = parseWorkGrants(
      JSON.stringify([
        {
          principal: 'svc:sprinkles-lcars-bot',
          subjects: ['sprinkles-lcars-bot@example.iam.gserviceaccount.com'],
          pipelines: ['claude'],
          scopes: ['work.operator'],
          channel: 'slack',
        },
      ]),
    );
    expect(grants[0]?.channel).toBe('slack');
  });

  it('leaves channel undefined when a grant does not declare one', () => {
    const grants = parseWorkGrants(raw);
    expect(grants[0]?.channel).toBeUndefined();
  });

  it("rejects a channel outside workOriginSchema's set as a startup config error", () => {
    expect(() =>
      parseWorkGrants(
        JSON.stringify([
          {
            principal: 'svc:sprinkles-lcars-bot',
            subjects: ['sprinkles-lcars-bot@example.iam.gserviceaccount.com'],
            pipelines: ['claude'],
            scopes: ['work.operator'],
            // A typo -- never matches a real workOriginSchema channel, so a
            // grant naming it would otherwise sit silently inert.
            channel: 'slak',
          },
        ]),
      ),
    ).toThrow();
  });
});

describe('claw-investigator grants', () => {
  function committedGrants() {
    const config = parseYaml(
      readFileSync(
        path.join(import.meta.dirname, '../../apphosting.yaml'),
        'utf8',
      ),
    ) as { env: { variable: string; value?: string }[] };
    return parseWorkGrants(
      config.env.find((entry) => entry.variable === 'AGENT_LCARS_WORK_GRANTS')
        ?.value,
    );
  }

  it('accepts the zone executor and admitter grant rows', () => {
    const grants = parseWorkGrants(
      JSON.stringify([
        {
          principal: 'svc:claw-homelab-ops',
          subjects: ['claw-homelab-ops@agent-lcars.iam.gserviceaccount.com'],
          pipelines: ['claw-investigator'],
          scopes: ['work.executor'],
        },
        {
          principal: 'user:jlapenna',
          subjects: ['github:jlapenna'],
          pipelines: ['claude', 'claw-investigator'],
          scopes: ['work.operator', 'work.claw.admit'],
        },
      ]),
    );
    expect(grants.map((grant) => grant.pipelines)).toEqual([
      ['claw-investigator'],
      ['claude', 'claw-investigator'],
    ]);
  });

  it('never lets the shared executor grant claim claw work', async () => {
    const shared = committedGrants().find(
      (grant) => grant.principal === 'svc:telemetry-writer',
    );
    expect(shared?.scopes).toContain('work.executor');
    expect(shared?.pipelines).not.toContain('claw-investigator');

    const store = new MemoryStore();
    const now = '2026-11-14T10:00:00.000Z';
    const orchestrator = new Orchestrator(store, { now: () => now });
    const outcome = await orchestrator.request({
      taskId: { workId: '01J5Z3K9QX8F0N2B4V6C8D1E3G' },
      requestId: 'claw',
      pipeline: 'claw-investigator',
      work: { spec: { title: 'claw' } },
    });
    if ('refused' in outcome) throw new Error(outcome.reason);
    await store.enqueueRun({ runId: outcome.run!.runId, now });
    const claim = (pipelines: readonly string[]) =>
      store.claimQueuedRun({
        pipelines,
        now,
        claimedBy: 'runner',
        claimedBySubject: 'executor@example.com',
        tokenHash: 'a'.repeat(64),
      });
    expect(await claim(shared!.pipelines)).toBeUndefined();
    expect((await claim(['claw-investigator']))?.runId).toBe(
      outcome.run!.runId,
    );
  });
});
