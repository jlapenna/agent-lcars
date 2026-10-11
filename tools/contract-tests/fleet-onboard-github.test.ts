import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  checkInstallation,
  hasFailure,
  installationSettingsUrl,
  main,
  parseCli,
  planSecret,
  planVariable,
  resolveDesiredVariables,
  resolvePrivateKey,
  runOnboarding,
  SECRET_NAME,
  ToolError,
  VARIABLE_NAMES,
} from '../fleet-onboard-github.mjs';

const repo = 'example/project';
const source = 'example/member';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SECRET_VALUES = {
  AGENT_BOT_LOGINS: '["bot-a","bot-b"]',
  AGENT_FLEET_LOGIN: 'fleet-login-value',
  AGENT_LCARS_CLIENT_ID: 'Iv1-client-id-value',
};
const labelManifest = {
  labels: {},
  repositories: { [repo]: { labels: [] } },
};

type GhCall = { args: string[]; input?: string };

// A gh double keyed by the joined argument list, mirroring the path-keyed
// fixture in onboarding-audit.test.ts. Unknown commands throw so a test
// cannot silently pass on an unplanned call.
function fakeGh(
  responses: Record<string, string | Error>,
  options: {
    targetVariables?: Record<string, string>;
    secrets?: string[];
  } = {},
) {
  const calls: GhCall[] = [];
  const target = { ...(options.targetVariables ?? {}) };
  const secrets = new Set(options.secrets ?? []);
  const gh = (args: string[], { input }: { input?: string } = {}) => {
    calls.push({ args, input });
    const key = args.join(' ');
    if (key in responses) {
      const response = responses[key];
      if (response instanceof Error) throw response;
      return response;
    }
    if (key === `variable list -R ${repo} --json name,value`)
      return JSON.stringify(
        Object.entries(target).map(([name, value]) => ({ name, value })),
      );
    if (key === `secret list -R ${repo} --json name`)
      return JSON.stringify([...secrets].map((name) => ({ name })));
    if (args[0] === 'variable' && args[1] === 'set') {
      target[args[2]] = input ?? '';
      return '';
    }
    if (args[0] === 'secret' && args[1] === 'set') {
      secrets.add(args[2]);
      return '';
    }
    throw new Error(`Unexpected gh call: ${key}`);
  };
  return { gh, calls, target, secrets };
}

const sourceResponses = Object.fromEntries(
  VARIABLE_NAMES.map((name) => [
    `variable get ${name} -R ${source}`,
    `${SECRET_VALUES[name as keyof typeof SECRET_VALUES]}\n`,
  ]),
);

type ApiCall = { path: string; token: string; method: string; body: unknown };

function fakeApi({
  included = true,
  installations = [
    { id: 11, account: { login: 'example', type: 'User' } },
    { id: 12, account: { login: 'other-org', type: 'Organization' } },
  ],
  pages = 1,
}: {
  included?: boolean;
  installations?: unknown[];
  pages?: number;
} = {}) {
  const calls: ApiCall[] = [];
  const api = async (
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
  ) => {
    calls.push({ path, token, method, body });
    if (path.startsWith('/app/installations?')) return installations;
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(path))
      return { token: `installation-token-${path.split('/')[3]}` };
    if (path.startsWith('/installation/repositories?')) {
      expect(token).toMatch(/^installation-token-/);
      const page = Number(new URL(`https://x${path}`).searchParams.get('page'));
      if (page < pages)
        return {
          repositories: Array.from({ length: 100 }, (_, index) => ({
            full_name: `example/filler-${page}-${index}`,
          })),
        };
      return {
        repositories: included
          ? [{ full_name: 'Example/Project' }]
          : [{ full_name: 'example/elsewhere' }],
      };
    }
    if (path === '/installation/token' && method === 'DELETE') return null;
    throw new Error(`Unexpected API request: ${method} ${path}`);
  };
  return { api, calls };
}

function run(overrides: Record<string, unknown> = {}) {
  return runOnboarding({
    repo,
    env: {},
    gh: fakeGh({}).gh,
    api: fakeApi().api,
    runCommand: () => {
      throw new Error('no key command expected');
    },
    labelSync: () => ({ status: 0, changes: 0 }),
    labelManifest,
    ...overrides,
  });
}

const byFact = (facts: { fact: string }[]) =>
  Object.fromEntries(facts.map((fact) => [fact.fact, fact]));

describe('fleet-onboard-github CLI contract', () => {
  it('requires --repo and rejects value-bearing or unknown flags', () => {
    expect(() => parseCli([])).toThrow(ToolError);
    expect(() => parseCli(['--repo', 'not-a-repo'])).toThrow('--repo');
    expect(() => parseCli(['--repo', repo, '--value', 'x'])).toThrow(ToolError);
    expect(() => parseCli(['--repo', repo, 'extra'])).toThrow(ToolError);
    expect(parseCli(['--repo', repo, '--verify', '--dry-run'])).toMatchObject({
      mode: 'verify',
    });
    expect(parseCli(['--repo', repo, '--dry-run']).mode).toBe('dry-run');
    expect(parseCli(['--repo', repo]).mode).toBe('apply');
    expect(parseCli(['--help'])).toEqual({ help: true });
  });

  it('refuses to copy a repository from itself', async () => {
    await expect(run({ copyFrom: repo })).rejects.toThrow('different');
  });
});

describe('value sources', () => {
  it('prefers the environment, then gh variable get on --copy-from, never a flag', () => {
    const { gh, calls } = fakeGh(sourceResponses);
    const desired = resolveDesiredVariables({
      env: { AGENT_FLEET_LOGIN: ' env-login ' },
      copyFrom: source,
      gh,
    });
    expect(desired).toEqual({
      AGENT_BOT_LOGINS: {
        value: SECRET_VALUES.AGENT_BOT_LOGINS,
        source: `copy-from ${source}`,
      },
      AGENT_FLEET_LOGIN: { value: 'env-login', source: 'env' },
      AGENT_LCARS_CLIENT_ID: {
        value: SECRET_VALUES.AGENT_LCARS_CLIENT_ID,
        source: `copy-from ${source}`,
      },
    });
    expect(calls.map((call) => call.args)).toEqual([
      ['variable', 'get', 'AGENT_BOT_LOGINS', '-R', source],
      ['variable', 'get', 'AGENT_LCARS_CLIENT_ID', '-R', source],
    ]);
  });

  it('accepts APP_CLIENT_ID for the fleet App client id and reports an unreadable source', () => {
    const { gh } = fakeGh({
      [`variable get AGENT_BOT_LOGINS -R ${source}`]: new Error('exit 1'),
      [`variable get AGENT_FLEET_LOGIN -R ${source}`]: 'fleet\n',
    });
    const desired = resolveDesiredVariables({
      env: { APP_CLIENT_ID: 'client-from-app-env' },
      copyFrom: source,
      gh,
    });
    expect(desired.AGENT_LCARS_CLIENT_ID).toEqual({
      value: 'client-from-app-env',
      source: 'env',
    });
    expect(desired.AGENT_BOT_LOGINS).toEqual({
      error: `unavailable from ${source}`,
    });
    expect(desired.AGENT_FLEET_LOGIN.value).toBe('fleet');
  });

  it('reads the private key from env or a command and never from a repository', () => {
    expect(
      resolvePrivateKey({
        env: { GITHUB_APP_PRIVATE_KEY: 'k2' },
        runCommand: () => 'never',
      }),
    ).toEqual({ key: 'k2', source: 'GITHUB_APP_PRIVATE_KEY' });
    expect(
      resolvePrivateKey({
        env: { APP_PRIVATE_KEY: 'k1', GITHUB_APP_PRIVATE_KEY: 'k2' },
        runCommand: () => 'never',
      }),
    ).toEqual({ key: 'k1', source: 'APP_PRIVATE_KEY' });
    const commands: string[] = [];
    expect(
      resolvePrivateKey({
        env: {},
        command: 'read-key',
        runCommand: (command: string) => {
          commands.push(command);
          return 'from-command';
        },
      }),
    ).toEqual({ key: 'from-command', source: '--private-key-command' });
    expect(commands).toEqual(['read-key']);
    expect(() =>
      resolvePrivateKey({ env: {}, command: 'empty', runCommand: () => '' }),
    ).toThrow('no output');
    expect(resolvePrivateKey({ env: {}, runCommand: () => 'x' })).toBe(
      undefined,
    );
  });
});

describe('idempotent planning', () => {
  it('plans variables without ever putting a value in the detail', () => {
    const desired = { value: 'v', source: 'env' };
    expect(
      planVariable({ name: 'X', desired, current: 'v', mode: 'apply' }),
    ).toMatchObject({
      status: 'PASS',
      detail: expect.stringContaining('unchanged'),
    });
    expect(
      planVariable({ name: 'X', desired, current: undefined, mode: 'apply' }),
    ).toEqual({ status: 'PASS', detail: 'created from env', write: 'v' });
    expect(
      planVariable({ name: 'X', desired, current: 'old', mode: 'dry-run' }),
    ).toEqual({ status: 'PLAN', detail: 'would update from env' });
    expect(
      planVariable({ name: 'X', desired, current: 'old', mode: 'verify' }),
    ).toEqual({ status: 'FAIL', detail: 'differs from env' });
    expect(
      planVariable({
        name: 'X',
        desired: undefined,
        current: 'x',
        mode: 'verify',
      }),
    ).toMatchObject({
      status: 'PASS',
      detail: expect.stringContaining('not compared'),
    });
    expect(
      planVariable({
        name: 'X',
        desired: undefined,
        current: 'x',
        mode: 'apply',
      }),
    ).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('--copy-from'),
    });
    expect(
      planVariable({
        name: 'X',
        desired: { error: 'boom' },
        current: 'x',
        mode: 'apply',
      }),
    ).toEqual({ status: 'FAIL', detail: 'boom' });
  });

  it('skips a present secret unless rotating, and never compares its value', () => {
    expect(
      planSecret({
        present: true,
        keySource: 'env',
        mode: 'apply',
        rotate: false,
      }),
    ).toMatchObject({ status: 'SKIP' });
    expect(
      planSecret({
        present: true,
        keySource: 'APP_PRIVATE_KEY',
        mode: 'apply',
        rotate: true,
      }),
    ).toEqual({
      status: 'PASS',
      detail: 'set from APP_PRIVATE_KEY',
      write: true,
    });
    expect(
      planSecret({
        present: false,
        keySource: 'APP_PRIVATE_KEY',
        mode: 'dry-run',
        rotate: false,
      }),
    ).toEqual({ status: 'PLAN', detail: 'would set from APP_PRIVATE_KEY' });
    expect(
      planSecret({
        present: false,
        keySource: undefined,
        mode: 'apply',
        rotate: false,
      }),
    ).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('private key source'),
    });
    expect(planSecret({ present: true, mode: 'verify' })).toMatchObject({
      status: 'PASS',
    });
    expect(planSecret({ present: false, mode: 'verify' })).toEqual({
      status: 'FAIL',
      detail: 'absent',
    });
  });
});

describe('apply mode', () => {
  it('writes only what differs, through stdin, and skips a present secret', async () => {
    const fixture = fakeGh(sourceResponses, {
      targetVariables: {
        AGENT_FLEET_LOGIN: SECRET_VALUES.AGENT_FLEET_LOGIN,
        AGENT_LCARS_CLIENT_ID: 'stale-client-id',
      },
      secrets: [SECRET_NAME],
    });
    const facts = await run({
      copyFrom: source,
      gh: fixture.gh,
      skipInstallations: true,
    });
    expect(byFact(facts)).toMatchObject({
      'variable:AGENT_BOT_LOGINS': {
        status: 'PASS',
        detail: `created from copy-from ${source}`,
      },
      'variable:AGENT_FLEET_LOGIN': {
        status: 'PASS',
        detail: expect.stringContaining('unchanged'),
      },
      'variable:AGENT_LCARS_CLIENT_ID': {
        status: 'PASS',
        detail: `updated from copy-from ${source}`,
      },
      [`secret:${SECRET_NAME}`]: { status: 'SKIP' },
      'installation:fleet': { status: 'SKIP' },
      'installation:autoscaler': { status: 'SKIP' },
      labels: { status: 'PASS' },
    });
    const writes = fixture.calls.filter((call) => call.args[1] === 'set');
    expect(writes.map((call) => call.args)).toEqual([
      ['variable', 'set', 'AGENT_BOT_LOGINS', '-R', repo],
      ['variable', 'set', 'AGENT_LCARS_CLIENT_ID', '-R', repo],
    ]);
    expect(writes.map((call) => call.input)).toEqual([
      SECRET_VALUES.AGENT_BOT_LOGINS,
      SECRET_VALUES.AGENT_LCARS_CLIENT_ID,
    ]);
    expect(fixture.target).toEqual(SECRET_VALUES);
    // Re-running is a no-op.
    const again = fakeGh(sourceResponses, {
      targetVariables: fixture.target,
      secrets: [...fixture.secrets],
    });
    await run({ copyFrom: source, gh: again.gh, skipInstallations: true });
    expect(again.calls.some((call) => call.args[1] === 'set')).toBe(false);
    expect(hasFailure(facts)).toBe(false);
  });

  it('sets an absent secret from the key command via stdin and never prints the key', async () => {
    const fixture = fakeGh(sourceResponses, {
      targetVariables: SECRET_VALUES,
    });
    const commands: string[] = [];
    const facts = await run({
      copyFrom: source,
      gh: fixture.gh,
      privateKeyCommand: 'secrets-get key',
      runCommand: (command: string) => {
        commands.push(command);
        return PEM;
      },
      skipInstallations: true,
      labelSync: () => ({ status: 0, changes: 3 }),
    });
    expect(commands).toEqual(['secrets-get key']);
    const secretWrite = fixture.calls.find(
      (call) => call.args[0] === 'secret' && call.args[1] === 'set',
    );
    expect(secretWrite).toEqual({
      args: ['secret', 'set', SECRET_NAME, '-R', repo],
      input: PEM,
    });
    expect(byFact(facts)).toMatchObject({
      [`secret:${SECRET_NAME}`]: {
        status: 'PASS',
        detail: 'set from --private-key-command',
      },
      labels: { status: 'PASS', detail: '3 label(s) created or updated' },
    });
    const output = JSON.stringify(facts);
    expect(output).not.toContain('PRIVATE KEY');
    for (const value of Object.values(SECRET_VALUES))
      expect(output).not.toContain(value);
  });

  it('rotates a present secret only on request and fails without a key source', async () => {
    const withKey = fakeGh(
      {},
      { targetVariables: SECRET_VALUES, secrets: [SECRET_NAME] },
    );
    await run({
      env: { ...SECRET_VALUES, APP_PRIVATE_KEY: PEM },
      gh: withKey.gh,
      rotateSecret: true,
      skipInstallations: true,
    });
    expect(
      withKey.calls.filter(
        (call) => call.args[0] === 'secret' && call.args[1] === 'set',
      ),
    ).toHaveLength(1);

    const noKey = fakeGh({}, { targetVariables: SECRET_VALUES });
    const facts = await run({
      env: SECRET_VALUES,
      gh: noKey.gh,
      skipInstallations: true,
    });
    expect(byFact(facts)[`secret:${SECRET_NAME}`]).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('--private-key-command'),
    });
    expect(
      noKey.calls.some(
        (call) => call.args[0] === 'secret' && call.args[1] === 'set',
      ),
    ).toBe(false);
    expect(hasFailure(facts)).toBe(true);
  });

  it('fails every variable fact, without values, when the target cannot be read', async () => {
    const { gh } = fakeGh({
      [`variable list -R ${repo} --json name,value`]: new ToolError(
        'gh variable list failed (exit 1)',
      ),
      [`secret list -R ${repo} --json name`]: '[]',
    });
    const facts = await run({
      env: SECRET_VALUES,
      gh,
      skipInstallations: true,
      skipLabels: true,
    });
    expect(
      facts.filter((fact) => fact.fact.startsWith('variable:')),
    ).toHaveLength(3);
    expect(
      facts
        .filter((fact) => fact.fact.startsWith('variable:'))
        .every((fact) => fact.status === 'FAIL'),
    ).toBe(true);
    expect(JSON.stringify(facts)).not.toContain('fleet-login-value');
  });
});

describe('dry-run and verify modes', () => {
  it('dry-run reports PLAN for every write and performs none', async () => {
    const fixture = fakeGh(sourceResponses, {
      targetVariables: { AGENT_FLEET_LOGIN: SECRET_VALUES.AGENT_FLEET_LOGIN },
    });
    const labelCalls: unknown[] = [];
    const facts = await run({
      mode: 'dry-run',
      copyFrom: source,
      env: { APP_PRIVATE_KEY: PEM },
      gh: fixture.gh,
      skipInstallations: true,
      labelSync: (options: unknown) => {
        labelCalls.push(options);
        return { status: 1, changes: 4 };
      },
    });
    expect(byFact(facts)).toMatchObject({
      'variable:AGENT_BOT_LOGINS': {
        status: 'PLAN',
        detail: `would create from copy-from ${source}`,
      },
      'variable:AGENT_FLEET_LOGIN': { status: 'PASS' },
      'variable:AGENT_LCARS_CLIENT_ID': { status: 'PLAN' },
      [`secret:${SECRET_NAME}`]: {
        status: 'PLAN',
        detail: 'would set from APP_PRIVATE_KEY',
      },
      labels: {
        status: 'PLAN',
        detail: '4 label(s) would be created or updated',
      },
    });
    expect(fixture.calls.some((call) => call.args[1] === 'set')).toBe(false);
    expect(labelCalls).toEqual([{ repo, apply: false }]);
    expect(hasFailure(facts)).toBe(false);
  });

  it('verify is read-only, compares when a source exists, and reports presence otherwise', async () => {
    const fixture = fakeGh(sourceResponses, {
      targetVariables: {
        AGENT_BOT_LOGINS: SECRET_VALUES.AGENT_BOT_LOGINS,
        AGENT_FLEET_LOGIN: 'drifted',
      },
      secrets: [SECRET_NAME],
    });
    const facts = await run({
      mode: 'verify',
      copyFrom: source,
      gh: fixture.gh,
      labelSync: () => ({ status: 1, changes: 2 }),
    });
    expect(byFact(facts)).toMatchObject({
      'variable:AGENT_BOT_LOGINS': { status: 'PASS' },
      'variable:AGENT_FLEET_LOGIN': {
        status: 'FAIL',
        detail: `differs from copy-from ${source}`,
      },
      'variable:AGENT_LCARS_CLIENT_ID': { status: 'FAIL', detail: 'absent' },
      [`secret:${SECRET_NAME}`]: { status: 'PASS' },
      'installation:fleet': { status: 'UNVERIFIED' },
      'installation:autoscaler': { status: 'UNVERIFIED' },
      labels: {
        status: 'FAIL',
        detail: '2 label(s) need to be created or updated',
      },
    });
    expect(fixture.calls.some((call) => call.args[1] === 'set')).toBe(false);
    for (const fact of facts)
      expect(typeof JSON.parse(JSON.stringify(fact)).detail).toBe('string');
    expect(JSON.stringify(facts)).not.toContain('drifted');

    const presenceOnly = fakeGh({}, { targetVariables: SECRET_VALUES });
    const presence = await run({
      mode: 'verify',
      gh: presenceOnly.gh,
      skipInstallations: true,
    });
    expect(byFact(presence)).toMatchObject({
      'variable:AGENT_BOT_LOGINS': {
        status: 'PASS',
        detail: expect.stringContaining('not compared'),
      },
      [`secret:${SECRET_NAME}`]: { status: 'FAIL', detail: 'absent' },
    });
    // No key command runs for the secret in verify mode.
    expect(
      presenceOnly.calls.some(
        (call) => call.args[0] === 'secret' && call.args[1] === 'set',
      ),
    ).toBe(false);
  });
});

describe('App installation membership', () => {
  it('mints a metadata-read token, pages repositories, revokes, and reports inclusion', async () => {
    const { api, calls } = fakeApi({ pages: 2 });
    const facts = await run({
      env: {
        APP_CLIENT_ID: 'fleet-app',
        APP_PRIVATE_KEY: PEM,
        ...SECRET_VALUES,
      },
      gh: fakeGh({}, { targetVariables: SECRET_VALUES, secrets: [SECRET_NAME] })
        .gh,
      api,
    });
    expect(byFact(facts)['installation:fleet']).toEqual({
      repo,
      fact: 'installation:fleet',
      status: 'PASS',
      detail: `installation 11 includes ${repo} (101 repositories visible)`,
    });
    expect(byFact(facts)['installation:autoscaler'].status).toBe('UNVERIFIED');
    const mutations = calls.filter((call) => call.method !== 'GET');
    expect(mutations).toEqual([
      {
        path: '/app/installations/11/access_tokens',
        token: expect.any(String),
        method: 'POST',
        body: { permissions: { metadata: 'read' } },
      },
      {
        path: '/installation/token',
        token: 'installation-token-11',
        method: 'DELETE',
        body: undefined,
      },
    ]);
    expect(
      calls.some((call) => call.path.includes('/app/installations/12/')),
    ).toBe(false);
    expect(
      calls.filter((call) =>
        call.path.startsWith('/installation/repositories?'),
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(facts)).not.toContain('installation-token');
  });

  it('checks the autoscaler App separately with its own credential', async () => {
    const { api, calls } = fakeApi();
    const facts = await run({
      env: {
        RUNNER_APP_CLIENT_ID: 'runner-app',
        RUNNER_APP_PRIVATE_KEY: PEM,
        ...SECRET_VALUES,
      },
      gh: fakeGh({}, { targetVariables: SECRET_VALUES, secrets: [SECRET_NAME] })
        .gh,
      api,
    });
    expect(byFact(facts)['installation:fleet'].status).toBe('UNVERIFIED');
    expect(byFact(facts)['installation:autoscaler'].status).toBe('PASS');
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('fails with the exact UI instruction, never modifying an installation', async () => {
    const { api, calls } = fakeApi({ included: false });
    const facts = await run({
      env: {
        APP_CLIENT_ID: 'fleet-app',
        APP_PRIVATE_KEY: PEM,
        ...SECRET_VALUES,
      },
      gh: fakeGh({}, { targetVariables: SECRET_VALUES, secrets: [SECRET_NAME] })
        .gh,
      api,
    });
    expect(byFact(facts)['installation:fleet']).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining(
        'https://github.com/settings/installations/11',
      ),
    });
    expect(byFact(facts)['installation:fleet'].detail).toContain(
      'never modifies',
    );
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(
      calls.filter((call) => ['PUT', 'PATCH'].includes(call.method)),
    ).toHaveLength(0);
    expect(hasFailure(facts)).toBe(true);
  });

  it('names the organization settings page and a missing installation', async () => {
    expect(
      installationSettingsUrl({
        id: 5,
        account: { login: 'acme', type: 'Organization' },
      }),
    ).toBe('https://github.com/organizations/acme/settings/installations/5');
    const { api } = fakeApi({
      installations: [
        { id: 9, account: { login: 'someone-else', type: 'User' } },
      ],
    });
    await expect(checkInstallation({ api, jwt: 'jwt', repo })).rejects.toThrow(
      /no installation on example;.*never modifies/,
    );
  });

  it('reports a status-only failure and a failed revocation separately', async () => {
    const { api } = fakeApi();
    const facts = await run({
      env: {
        APP_CLIENT_ID: 'fleet-app',
        APP_PRIVATE_KEY: PEM,
        ...SECRET_VALUES,
      },
      gh: fakeGh({}, { targetVariables: SECRET_VALUES, secrets: [SECRET_NAME] })
        .gh,
      api: async (
        path: string,
        token: string,
        method = 'GET',
        body?: unknown,
      ) => {
        if (path === '/installation/token') throw new Error('GitHub HTTP 500');
        return api(path, token, method, body);
      },
    });
    expect(
      facts.filter((fact) => fact.fact.startsWith('installation:fleet')),
    ).toMatchObject([
      { fact: 'installation:fleet', status: 'PASS' },
      { fact: 'installation:fleet:token-revocation', status: 'FAIL' },
    ]);
    const broken = await run({
      env: {
        APP_CLIENT_ID: 'fleet-app',
        APP_PRIVATE_KEY: PEM,
        ...SECRET_VALUES,
      },
      gh: fakeGh({}, { targetVariables: SECRET_VALUES, secrets: [SECRET_NAME] })
        .gh,
      api: async () => {
        throw new Error('body with a token: ghs_private');
      },
    });
    expect(byFact(broken)['installation:fleet']).toEqual({
      repo,
      fact: 'installation:fleet',
      status: 'FAIL',
      detail: 'request failed',
    });
  });
});

describe('labels', () => {
  it('requires the repository in the label manifest before syncing', async () => {
    const labelCalls: unknown[] = [];
    const facts = await run({
      env: SECRET_VALUES,
      gh: fakeGh({}, { targetVariables: SECRET_VALUES, secrets: [SECRET_NAME] })
        .gh,
      skipInstallations: true,
      labelManifest: { labels: {}, repositories: {} },
      labelSync: (options: unknown) => {
        labelCalls.push(options);
        return { status: 0, changes: 0 };
      },
    });
    expect(byFact(facts).labels).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('fleet-onboard.mjs admit'),
    });
    expect(labelCalls).toEqual([]);
  });

  it('passes --apply to the sync only in apply mode and fails on a sync error', async () => {
    const labelCalls: { apply: boolean }[] = [];
    const facts = await run({
      env: SECRET_VALUES,
      gh: fakeGh({}, { targetVariables: SECRET_VALUES, secrets: [SECRET_NAME] })
        .gh,
      skipInstallations: true,
      labelSync: (options: { apply: boolean }) => {
        labelCalls.push(options);
        return { status: 2, changes: 0 };
      },
    });
    expect(labelCalls).toEqual([{ repo, apply: true }]);
    expect(byFact(facts).labels).toEqual({
      repo,
      fact: 'labels',
      status: 'FAIL',
      detail: 'label sync failed',
    });
  });
});

describe('main', () => {
  it('prints one JSON line per fact and exits nonzero only on FAIL', async () => {
    const lines: string[] = [];
    const deps = {
      env: SECRET_VALUES,
      gh: fakeGh({}, { targetVariables: SECRET_VALUES, secrets: [SECRET_NAME] })
        .gh,
      api: fakeApi().api,
      runCommand: () => '',
      labelSync: () => ({ status: 0, changes: 0 }),
      labelManifest,
      log: (line: string) => lines.push(line),
    };
    expect(await main(['--repo', repo, '--verify'], deps)).toBe(0);
    expect(lines).toHaveLength(3 + 1 + 2 + 1);
    for (const line of lines) {
      const fact = JSON.parse(line);
      expect(Object.keys(fact).sort()).toEqual([
        'detail',
        'fact',
        'repo',
        'status',
      ]);
      expect(['PASS', 'FAIL', 'SKIP', 'PLAN', 'UNVERIFIED']).toContain(
        fact.status,
      );
    }
    lines.length = 0;
    expect(
      await main(['--repo', repo, '--verify'], {
        ...deps,
        labelSync: () => ({ status: 1, changes: 1 }),
      }),
    ).toBe(1);
    lines.length = 0;
    expect(await main(['--help'], deps)).toBe(0);
    expect(lines[0]).toContain('usage');
  });
});
