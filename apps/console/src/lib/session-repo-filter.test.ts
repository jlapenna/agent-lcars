import { describe, expect, it } from 'vitest';

import { filterSessionsForRepo } from './session-repo-filter';
import type { WatchedRepo } from './watched-repo';

interface Session {
  id: string;
  repo?: WatchedRepo;
}

const sprinkles: WatchedRepo = {
  owner: 'supersprinklesracing',
  name: 'sprinkles',
};

const homelab: WatchedRepo = {
  owner: 'jlapenna',
  name: 'homelab',
};

const sessions: Session[] = [
  { id: 'host-scoped-cli' },
  { id: 'sprinkles-session', repo: sprinkles },
  { id: 'homelab-session', repo: homelab },
];

describe('filterSessionsForRepo', () => {
  it('keeps valid repo-less host-scoped sessions without a repository filter', () => {
    expect(filterSessionsForRepo(sessions, undefined)).toEqual(sessions);
  });

  it('excludes repo-less sessions when a repository filter is selected', () => {
    expect(filterSessionsForRepo(sessions, sprinkles)).toEqual([
      { id: 'sprinkles-session', repo: sprinkles },
    ]);
  });
});
