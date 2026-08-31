import type { WatchedRepo } from '../lib/watched-repo';

export const TEST_HOME_REPOSITORY: WatchedRepo = {
  owner: 'jlapenna',
  name: 'agent-lcars',
};

export const TEST_SPRINKLES_REPOSITORY: WatchedRepo = {
  owner: 'supersprinklesracing',
  name: 'sprinkles',
  alias: 'sprinkles',
};

/** Supplies an explicit, internally consistent deployment config for tests
 * that exercise a repository other than the minimal global test default. */
export function configureTestWatchedRepos(
  repositories: readonly WatchedRepo[],
): void {
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORY'] =
    TEST_HOME_REPOSITORY.owner + '/' + TEST_HOME_REPOSITORY.name;
  process.env['AGENT_LCARS_CONTROL_PLANE_REPOSITORIES'] = repositories
    .map((repository) => `${repository.owner}/${repository.name}`)
    .join(',');
  process.env['AGENT_LCARS_WATCHED_REPOS'] = JSON.stringify(repositories);
}
