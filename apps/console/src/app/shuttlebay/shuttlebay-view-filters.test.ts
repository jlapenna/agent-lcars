import { describe, expect, it } from 'vitest';

import {
  executorMatches,
  laneMatches,
  laneServesRepo,
  parseShuttlebayFilters,
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
