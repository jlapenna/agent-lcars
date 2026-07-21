import { Octokit } from '@octokit/rest';
import { optional, required } from '@repo/util-server';

export const REPO_OWNER = 'supersprinklesracing';
export const REPO_NAME = 'members';

let client: Octokit | undefined;

export function getGithubClient(): Octokit {
  if (!client) {
    client = new Octokit({
      auth: required('AGENT_LCARS_GITHUB_TOKEN'),
      // Only ever set by the agent-lcars e2e suite, which has no real
      // GitHub credentials and instead points this at its own fixture route
      // (apps/console/src/app/api/e2e/github) so PR-join
      // assertions don't depend on the real GitHub API. Never set in prod
      // (absent from apphosting.yaml).
      ...(optional('AGENT_CONSOLE_GITHUB_API_BASE_URL') && {
        baseUrl: optional('AGENT_CONSOLE_GITHUB_API_BASE_URL'),
      }),
    });
  }
  return client;
}
