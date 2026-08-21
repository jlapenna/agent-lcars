import { describe, expect, it } from 'vitest';

import { orchestratorGithubRuntimeDeps } from './orchestrator-runtime';

describe('orchestratorGithubRuntimeDeps', () => {
  it('uses the local fixture without GitHub App credentials when its API root is configured', async () => {
    const deps = orchestratorGithubRuntimeDeps({
      AGENT_CONSOLE_GITHUB_API_BASE_URL: 'http://127.0.0.1:4200/api/e2e/github',
    });

    expect(deps.githubApiBaseUrl).toBe('http://127.0.0.1:4200/api/e2e/github');
    await expect(deps.tokens.tokenFor('octo/example')).resolves.toBe(
      'e2e-fixture-token',
    );
  });

  it('keeps production fail-fast credential validation without the fixture root', () => {
    expect(() => orchestratorGithubRuntimeDeps({})).toThrow(
      'process.env.AGENT_LCARS_APP_CLIENT_ID not defined',
    );
  });
});
