import { Octokit } from '@octokit/rest';
import { getAgentConsoleGithubToken } from '@repo/util-server';

export const REPO_OWNER = 'supersprinklesracing';
export const REPO_NAME = 'members';

let client: Octokit | undefined;

export function getGithubClient(): Octokit {
  if (!client) {
    client = new Octokit({ auth: getAgentConsoleGithubToken() });
  }
  return client;
}
