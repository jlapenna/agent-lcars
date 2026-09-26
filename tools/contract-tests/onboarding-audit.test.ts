import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  assertVariables,
  auditRepository,
  createApi,
  runAudit,
  runnerRegistrations,
  watchedRepositories,
} from '../verify-onboarding.mjs';

const repo = 'example/project';
const labels = {
  labels: { 'type:bug': { color: 'abcdef', description: 'Bug' } },
  repositories: { [repo]: { labels: ['type:bug'] } },
};
const profiles = { example: { repositories: [repo] } };
function fixture(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    [`/repos/${repo}/collaborators/fleet/permission`]: { permission: 'write' },
    [`/repos/${repo}/assignees/fleet`]: null,
    [`/repos/${repo}/labels?per_page=100&page=1`]: [
      { name: 'type:bug', color: 'ABCDEF', description: 'Bug' },
    ],
    [`/repos/${repo}/actions/variables?per_page=100&page=1`]: {
      variables: [{ name: 'AGENT_FLEET_LOGIN', value: 'fleet' }],
    },
    [`/repos/${repo}`]: { default_branch: 'main' },
    [`/repos/${repo}/rules/branches/main?per_page=100&page=1`]: [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context: 'Verify', integration_id: 1 }],
        },
      },
    ],
    [`/repos/${repo}/commits/main`]: { sha: 'abc123' },
    [`/repos/${repo}/commits/abc123/check-runs?filter=all&per_page=100&page=1`]:
      { check_runs: [{ name: 'Verify', app: { id: 1 } }] },
    [`/repos/${repo}/commits/abc123/statuses?per_page=100&page=1`]: [],
    ...overrides,
  };
  const requests: string[] = [];
  const api = async (path: string) => {
    requests.push(path);
    if (!(path in responses)) throw new Error(`Unexpected path: ${path}`);
    const response = responses[path];
    if (response instanceof Error) throw response;
    return response;
  };
  return { api, requests };
}
const audit = (api: unknown) =>
  auditRepository({
    repo,
    token: 'temporary',
    api,
    labels,
    profiles,
    fleetLogin: 'fleet',
    checkVariables: (_profile: string, variables: Record<string, string>) =>
      assertVariables('fleet-member', variables),
  });

describe('read-only onboarding audit', () => {
  it('keeps App authorization checks separate from optional administrative reads', async () => {
    const base = fixture();
    const calls: { path: string; token: string }[] = [];
    await auditRepository({
      repo,
      token: 'fleet-token',
      auditReadToken: 'audit-token',
      labels,
      profiles,
      fleetLogin: 'fleet',
      checkVariables: (_profile: string, variables: Record<string, string>) =>
        assertVariables('fleet-member', variables),
      api: async (path: string, token: string) => {
        calls.push({ path, token });
        return base.api(path);
      },
    });
    expect(
      calls
        .filter(({ path }) => /collaborators|assignees|labels/.test(path))
        .every(({ token }) => token === 'fleet-token'),
    ).toBe(true);
    expect(
      calls
        .filter(({ path }) => /variables|rules|commits/.test(path))
        .every(({ token }) => token === 'audit-token'),
    ).toBe(true);
  });

  it('does not call unfinished default-branch CI a configuration mismatch', async () => {
    const { api } = fixture({
      [`/repos/${repo}/commits/abc123/check-runs?filter=all&per_page=100&page=1`]:
        { check_runs: [] },
      [`/repos/${repo}/actions/runs?head_sha=abc123&per_page=100`]: {
        workflow_runs: [{ status: 'queued' }],
      },
    });
    expect((await audit(api))[3]).toMatchObject({
      status: 'UNVERIFIED',
      detail: expect.stringContaining('CI completes'),
    });
  });

  it('verifies separate facts and accepts labels independent of color case', async () => {
    const { api } = fixture();
    const result = await audit(api);
    expect(result.map((fact: { status: string }) => fact.status)).toEqual([
      'PASS',
      'PASS',
      'PASS',
      'PASS',
    ]);
  });

  it('continues after permission and label failures without leaking variable values', async () => {
    const { api } = fixture({
      [`/repos/${repo}/collaborators/fleet/permission`]: new Error(
        'GitHub HTTP 403',
      ),
      [`/repos/${repo}/labels?per_page=100&page=1`]: [],
      [`/repos/${repo}/actions/variables?per_page=100&page=1`]: {
        variables: [{ name: 'OTHER', value: 'must-not-appear' }],
      },
    });
    const result = await audit(api);
    expect(result.map((fact: { status: string }) => fact.status)).toEqual([
      'FAIL',
      'FAIL',
      'FAIL',
      'PASS',
    ]);
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
    expect(result[2].detail).toContain('AGENT_FLEET_LOGIN');
  });

  it('requires the ruleset App identity, not just a same-named check or status', async () => {
    const { api } = fixture({
      [`/repos/${repo}/commits/abc123/check-runs?filter=all&per_page=100&page=1`]:
        { check_runs: [{ name: 'Verify', app: { id: 2 } }] },
      [`/repos/${repo}/commits/abc123/statuses?per_page=100&page=1`]: [
        { context: 'Verify' },
      ],
    });
    expect((await audit(api))[3]).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('Verify'),
    });
  });

  it('follows pagination instead of falsely reporting a missing label', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      name: `extra-${index}`,
      color: '000000',
    }));
    const { api, requests } = fixture({
      [`/repos/${repo}/labels?per_page=100&page=1`]: firstPage,
      [`/repos/${repo}/labels?per_page=100&page=2`]: [
        { name: 'type:bug', color: 'abcdef', description: 'Bug' },
      ],
    });
    expect((await audit(api))[1].status).toBe('PASS');
    expect(requests).toContain(`/repos/${repo}/labels?per_page=100&page=2`);
  });

  it('reports HTTP status without echoing sensitive GitHub response bodies', async () => {
    const api = createApi(
      async () => new Response('private-response', { status: 403 }),
    );
    await expect(api('/test', 'private-token')).rejects.toThrow(
      /^GitHub HTTP 403$/,
    );
  });

  it('audits matching registration credentials and leaves another App unverified', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const calls: { path: string; method: string; body: unknown }[] = [];
    const api = async (
      path: string,
      _token: string,
      method = 'GET',
      body?: unknown,
    ) => {
      calls.push({ path, method, body });
      if (path.endsWith('/installation'))
        return { id: 7, permissions: { administration: 'write' } };
      if (path.endsWith('/access_tokens'))
        return { token: 'private-read-token' };
      if (path.endsWith('/actions/runners?per_page=1'))
        return { runners: [], total_count: 0 };
      if (method === 'DELETE') return null;
      throw new Error('Unexpected API request');
    };
    const result = await runAudit({
      clientId: 'matching-app',
      privateKey,
      repos: [],
      labels,
      profiles,
      fleetLogin: 'fleet',
      api,
      registrationConfig: {
        github: { url: 'https://github.com/example/legacy' },
        registrations: [
          {
            name: 'match',
            github: { url: 'https://github.com/example/project' },
            app: { client_id: 'matching-app', installation_id: 7 },
          },
          {
            name: 'disabled',
            disabled: true,
            github: { url: 'https://github.com/example/disabled' },
          },
        ],
      },
    });
    expect(result.map((fact: { status: string }) => fact.status)).toEqual([
      'UNVERIFIED',
      'PASS',
    ]);
    expect(calls.filter((call) => call.method === 'POST')).toEqual([
      {
        path: '/app/installations/7/access_tokens',
        method: 'POST',
        body: { permissions: { administration: 'read' } },
      },
    ]);
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-read-token');
  });

  it('extracts organization and repository registration scopes without reading credential files', () => {
    expect(
      runnerRegistrations({
        registrations: [
          {
            name: 'org',
            github: { url: 'https://github.com/example' },
            app: { private_key_file: '/must/not/be/read' },
          },
        ],
      })[0].endpoint,
    ).toBe('/orgs/example/actions/runners');
    expect(() =>
      runnerRegistrations({
        github: { url: 'https://wrong.example/example/project' },
      }),
    ).toThrow('Invalid runner registration URL');
  });

  it('covers every watched repository and every local workflow variable in the manifest', () => {
    const manifest = JSON.parse(
      readFileSync('config/github-variables.json', 'utf8'),
    );
    const watched = watchedRepositories(
      parse(readFileSync('apps/console/apphosting.yaml', 'utf8')),
    );
    const declared = Object.values(manifest.profiles).flatMap(
      (profile: any) => profile.repositories,
    );
    expect(watched.filter((repo: string) => !declared.includes(repo))).toEqual(
      [],
    );
    const referenced = readdirSync('.github/workflows')
      .filter((name) => name.endsWith('.yml'))
      .flatMap((name) =>
        [
          ...readFileSync(`.github/workflows/${name}`, 'utf8').matchAll(
            /vars\.([A-Z][A-Z0-9_]*)/g,
          ),
        ].map((match) => match[1]),
      );
    expect(
      [...new Set(referenced)].filter(
        (name) => !manifest.profiles['agent-lcars'].variables[name],
      ),
    ).toEqual([]);
  });
});
