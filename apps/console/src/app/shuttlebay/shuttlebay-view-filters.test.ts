import { describe, expect, it } from 'vitest';

import {
  executorMatches,
  laneMatches,
  laneServesRepo,
  parseShuttlebayFilters,
  runnerMatches,
} from './shuttlebay-view-filters';

describe('parseShuttlebayFilters', () => {
  it('keeps known values and ignores the rest', () => {
    expect(
      parseShuttlebayFilters({
        repo: 'jlapenna/homelab',
        agent: 'codex',
        q: ' ci ',
      }),
    ).toEqual({ repo: 'jlapenna/homelab', agent: 'codex', q: 'ci' });
    expect(
      parseShuttlebayFilters({ repo: 'not a repo', agent: ['robot'], q: '' }),
    ).toEqual({ repo: undefined, agent: undefined, q: undefined });
  });
});

describe('laneServesRepo', () => {
  it('matches a repository lane and an organization lane', () => {
    expect(
      laneServesRepo(
        'https://github.com/jlapenna/agent-lcars',
        'jlapenna/agent-lcars',
      ),
    ).toBe(true);
    expect(
      laneServesRepo(
        'https://github.com/supersprinklesracing',
        'SuperSprinklesRacing/sprinkles',
      ),
    ).toBe(true);
    expect(
      laneServesRepo(
        'https://github.com/jlapenna/homelab',
        'jlapenna/agent-lcars',
      ),
    ).toBe(false);
    expect(laneServesRepo('not a url', 'jlapenna/homelab')).toBe(false);
  });
});

describe('laneMatches / executorMatches', () => {
  const lane = {
    lane: 'lcars-ci',
    registrationUrl: 'https://github.com/jlapenna/agent-lcars',
  };
  it('narrows lanes by repository and find', () => {
    expect(laneMatches(lane, {})).toBe(true);
    expect(laneMatches(lane, { q: 'CI' })).toBe(true);
    expect(laneMatches(lane, { q: 'e2e' })).toBe(false);
    expect(laneMatches(lane, { repo: 'jlapenna/homelab' })).toBe(false);
  });
  it('keeps the executor unless find excludes it', () => {
    expect(executorMatches({ repo: 'jlapenna/homelab' })).toBe(true);
    expect(executorMatches({ q: 'executor' })).toBe(true);
    expect(executorMatches({ q: 'lcars-ci' })).toBe(false);
  });
});

describe('runnerMatches', () => {
  const lanes = [
    {
      lane: 'lcars-ci',
      registrationUrl: 'https://github.com/jlapenna/agent-lcars',
    },
  ];
  const idle = { name: 'lcars-ci-x1', kind: 'arc' as const, lane: 'lcars-ci' };
  const busy = {
    ...idle,
    name: 'lcars-ci-x2',
    jobRepository: 'jlapenna/homelab',
    jobName: 'lint',
  };
  const direct = {
    name: 'lcars-run-1',
    kind: 'direct' as const,
    lane: 'direct',
    work: {
      label: 'sprinkles#6041',
      href: '/task/jlapenna/sprinkles/6041',
      repo: 'jlapenna/sprinkles',
      pipeline: 'codex',
    },
  };
  const unresolved = {
    name: 'lcars-run-2',
    kind: 'direct' as const,
    lane: 'direct',
  };

  it('matches the repository a runner works for, else its lane', () => {
    const repo = { repo: 'jlapenna/agent-lcars' };
    expect(runnerMatches(idle, lanes, repo)).toBe(true);
    expect(runnerMatches(busy, lanes, repo)).toBe(false);
    expect(runnerMatches(busy, lanes, { repo: 'jlapenna/homelab' })).toBe(true);
    expect(runnerMatches(direct, lanes, repo)).toBe(false);
    expect(runnerMatches(unresolved, lanes, repo)).toBe(true);
    expect(runnerMatches({ ...idle, lane: 'gone' }, lanes, repo)).toBe(false);
  });

  it('narrows only direct runners by agent', () => {
    expect(runnerMatches(direct, lanes, { agent: 'claude' })).toBe(false);
    expect(runnerMatches(direct, lanes, { agent: 'codex' })).toBe(true);
    expect(runnerMatches(idle, lanes, { agent: 'claude' })).toBe(true);
    expect(runnerMatches(unresolved, lanes, { agent: 'claude' })).toBe(true);
  });

  it('finds a runner by name, lane, or job', () => {
    expect(runnerMatches(busy, lanes, { q: 'LINT' })).toBe(true);
    expect(runnerMatches(direct, lanes, { q: '6041' })).toBe(true);
    expect(runnerMatches(idle, lanes, { q: 'nomatch' })).toBe(false);
  });
});
