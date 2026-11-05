import type {
  CredentialSet,
  JobCredentialGrant,
  JobSecretRecord,
} from '@agent-lcars/work';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobSecretBackend } from './job-secret-backend';
import type { JobSecretCollection, JobSecretStore } from './job-secret-store';
import { JobSecrets, type SecretJob } from './job-secrets';
import { jobSecretsHttp } from './job-secrets-http';
import type { WorkPrincipal } from './work-auth';

class Registry implements JobSecretStore {
  rows = new Map<string, unknown>();
  events: Record<string, string>[] = [];
  async get(kind: JobSecretCollection, id: string) {
    return structuredClone(this.rows.get(`${kind}/${id}`));
  }
  async list(kind: JobSecretCollection) {
    return [...this.rows]
      .filter(([key]) => key.startsWith(`${kind}/`))
      .map(([, value]) => structuredClone(value));
  }
  async put(
    kind: JobSecretCollection,
    id: string,
    value: unknown,
    createOnly = false,
  ) {
    const key = `${kind}/${id}`;
    if (createOnly && this.rows.has(key)) throw new Error('Already exists');
    this.rows.set(key, structuredClone(value));
  }
  async audit(event: Record<string, string>) {
    this.events.push(event);
  }
  async mutateSecret(
    name: string,
    change: (current: JobSecretRecord) => JobSecretRecord,
  ) {
    const key = `secrets/${name}`;
    const next = change(structuredClone(this.rows.get(key)) as JobSecretRecord);
    this.rows.set(key, structuredClone(next));
    return next;
  }
}
const now = new Date('2026-11-04T00:00:00Z');
const actor = 'user:jlapenna';
let registry: Registry;
let backend: JobSecretBackend;
let service: JobSecrets;
let job: SecretJob;
let grant: JobCredentialGrant;
let versions: Map<string, string[]>;
const set: CredentialSet = {
  name: 'dev-maintenance',
  revision: 1,
  github: 'github-jlapenna',
  environment: { EXAMPLE_API_KEY: 'example-key' },
  files: { certificate: 'example-key' },
};
const githubValue = JSON.stringify({
  token: 'fixture-github-token',
  expiresAt: null,
});

describe('credential monitoring', () => {
  it('observes bounded metadata and expiry states without accessing any secret value', async () => {
    const github = registry.rows.get(
      'secrets/github-jlapenna',
    ) as JobSecretRecord;
    for (const [name, change] of [
      ['expired', { expiresAt: '2026-11-03T23:59:00Z' }],
      ['expiring', { expiresAt: '2026-11-04T00:30:00Z' }],
      ['unknown', { expiresAt: undefined }],
      ['disabled', { enabled: false, expiresAt: '2026-11-03T23:59:00Z' }],
      ['unpromoted', { promotedVersion: undefined, expiresAt: undefined }],
    ] as const)
      registry.rows.set(`secrets/${name}`, { ...github, ...change, name });
    registry.rows.set('health/current', {
      deliveries: 4,
      admissionRefusals: 2,
      deliveryRefusals: 3,
      lastDeliveryAt: now.toISOString(),
      lastRefusalAt: now.toISOString(),
    });
    vi.clearAllMocks();
    const observation = await service.observe();
    expect(observation).toMatchObject({
      version: 1,
      configured: true,
      metadataAvailable: true,
      dependency: 'ready',
      counts: {
        total: 7,
        ready: 3,
        disabled: 1,
        unpromoted: 1,
        expired: 1,
        expiring: 1,
        unknown: 1,
      },
      deliveries: 4,
      admissionRefusals: 2,
      deliveryRefusals: 3,
    });
    expect(backend.checkContainer).toHaveBeenCalledTimes(1);
    expect(backend.readVersion).not.toHaveBeenCalled();
    expect(backend.addVersion).not.toHaveBeenCalled();
    expect(JSON.stringify(observation)).not.toMatch(
      /jlapenna|fixture-|github-jlapenna|example-key/u,
    );
  });
  it('distinguishes an idle registry from missing or corrupt telemetry and a failed metadata dependency', async () => {
    registry.rows.clear();
    vi.clearAllMocks();
    expect(await service.observe()).toMatchObject({
      metadataAvailable: true,
      dependency: 'idle',
      counts: { total: 0 },
      deliveries: 0,
    });
    expect(backend.checkContainer).not.toHaveBeenCalled();
    registry.rows.set('health/current', { deliveries: 'not-a-counter' });
    expect(await service.observe()).toEqual({
      version: 1,
      observedAt: now.toISOString(),
      configured: true,
      metadataAvailable: false,
      dependency: 'unknown',
    });
    registry.rows.delete('health/current');
    registry.rows.set('secrets/example-key', {
      name: 'example-key',
      kind: 'opaque',
      enabled: true,
      updatedBy: actor,
      updatedAt: now.toISOString(),
    });
    vi.mocked(backend.checkContainer).mockRejectedValue(
      new Error('fixture-private-sdk-credential'),
    );
    const unavailable = await service.observe();
    expect(unavailable).toMatchObject({
      metadataAvailable: true,
      dependency: 'unavailable',
      counts: { unpromoted: 1 },
    });
    expect(JSON.stringify(unavailable)).not.toContain(
      'fixture-private-sdk-credential',
    );
    vi.spyOn(registry, 'list').mockRejectedValue(
      new Error('fixture-private-read-error'),
    );
    expect(await service.observe()).toMatchObject({
      metadataAvailable: false,
      dependency: 'unknown',
    });
  });
  it('records refused operations before Work exists without recording the failing input or SDK error', async () => {
    await service.refused(job, 'admission');
    await service.refused(job, 'delivery');
    expect(registry.events.slice(-2)).toEqual(
      ['admission-refused', 'delivery-refused'].map((operation) => ({
        operation,
        actor: job.principal,
        runOccurrence: job.id,
        repository: job.definition.repository,
        job: job.definition.name,
        profile: job.profile.name,
        trigger: job.trigger,
        at: now.toISOString(),
      })),
    );
  });
});
beforeEach(async () => {
  registry = new Registry();
  versions = new Map();
  backend = {
    checkContainer: vi.fn(async () => undefined),
    addVersion: vi.fn(async (name, value) => {
      const all = versions.get(name) ?? [];
      all.push(value);
      versions.set(name, all);
      return String(all.length);
    }),
    readVersion: vi.fn(async (name, version) => {
      const value = versions.get(name)?.[Number(version) - 1];
      if (!value) throw new Error('Backend fixture-private-error');
      return value;
    }),
  };
  service = new JobSecrets(
    registry,
    backend,
    () => now,
    async () => 'jlapenna',
  );
  for (const [name, kind] of [
    ['github-jlapenna', 'github'],
    ['example-key', 'opaque'],
  ] as const) {
    await service.register({
      name,
      kind,
      ...(kind === 'github' ? { login: 'jlapenna' } : {}),
      enabled: true,
      updatedAt: now.toISOString(),
      updatedBy: actor,
    });
    await service.upload(
      name,
      kind === 'github' ? githubValue : 'fixture-api-key',
      actor,
    );
    await service.promote(name, '1', actor);
  }
  await service.publish(set, actor);
  grant = {
    repository: 'jlapenna/dev',
    job: 'external-pr-sweep',
    profile: 'dev-maintenance',
    credentialSet: { name: set.name, revision: 1 },
    principals: [actor],
    enabled: true,
    allowScheduled: true,
  };
  await service.grant(grant, actor);
  job = {
    id: 'a'.repeat(64),
    principal: actor,
    trigger: 'schedule',
    definition: { repository: grant.repository, name: grant.job },
    profile: { name: grant.profile, credentialSet: grant.credentialSet },
  } as SecretJob;
  vi.mocked(backend.readVersion).mockClear();
});

it('runs unattended with only its approved GitHub, environment and file bindings', async () => {
  const snapshot = await service.pin(job);
  expect(snapshot.versions).toEqual({
    'github-jlapenna': '1',
    'example-key': '1',
  });
  expect(JSON.stringify(snapshot)).not.toContain('fixture-');
  expect(await service.deliver(job, snapshot)).toEqual({
    environment: { EXAMPLE_API_KEY: 'fixture-api-key' },
    files: { certificate: 'fixture-api-key' },
  });
  expect(await service.github(job, snapshot)).toMatchObject({
    token: 'fixture-github-token',
    login: 'jlapenna',
    expiresAt: null,
  });
  expect(registry.events).toContainEqual(
    expect.objectContaining({
      operation: 'deliver',
      runOccurrence: job.id,
      secret: 'example-key',
      version: '1',
    }),
  );
  expect(JSON.stringify([...registry.rows])).not.toContain('fixture-');
  expect(JSON.stringify(registry.events)).not.toContain('fixture-');
  expect(
    registry.events.filter((event) => event.operation === 'delivery-completed'),
  ).toHaveLength(2);
});
it('pins existing occurrences while newly admitted occurrences follow a validated promotion', async () => {
  const snapshot = await service.pin(job);
  await service.upload('example-key', 'fixture-rotated-key', actor);
  await service.promote('example-key', '2', actor);
  expect(
    (await service.deliver(job, snapshot)).environment.EXAMPLE_API_KEY,
  ).toBe('fixture-api-key');
  expect(
    (await service.deliver(job, await service.pin(job))).environment
      .EXAMPLE_API_KEY,
  ).toBe('fixture-rotated-key');
});
it.each([
  'other-job',
  'other-repository',
  'other-principal',
  'other-profile',
  'scheduled-disabled',
  'grant-revoked',
  'secret-disabled',
  'set-revision',
  'forged-snapshot',
])('refuses %s before reading any secret values', async (failure) => {
  const snapshot = await service.pin(job);
  if (failure === 'other-job') job.definition.name = 'foreign-job';
  if (failure === 'other-repository') job.definition.repository = 'other/repo';
  if (failure === 'other-principal') job.principal = 'user:other';
  if (failure === 'other-profile') job.profile.name = 'other';
  if (failure === 'scheduled-disabled')
    await service.grant({ ...grant, allowScheduled: false }, actor);
  if (failure === 'grant-revoked')
    await service.grant({ ...grant, enabled: false }, actor);
  if (failure === 'secret-disabled')
    await service.disable('example-key', actor);
  if (failure === 'set-revision') job.profile.credentialSet!.revision = 2;
  if (failure === 'forged-snapshot')
    snapshot.versions['ungranted-secret'] = '1';
  await expect(service.deliver(job, snapshot)).rejects.toThrow();
  expect(backend.readVersion).not.toHaveBeenCalled();
});
it('does not let a promotion overwrite a concurrent disable', async () => {
  let resume!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(backend.readVersion).mockImplementationOnce(async () => {
    started();
    await blocked;
    return 'fixture-promoted-key';
  });
  const pending = service.promote('example-key', '1', actor);
  await reading;
  await service.disable('example-key', actor);
  resume();
  expect((await pending).enabled).toBe(false);
  await expect(service.pin(job)).rejects.toThrow('disabled');
});
it('does not enable a different version than the one it validated', async () => {
  await service.disable('example-key', actor);
  let resume!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(backend.readVersion).mockImplementationOnce(async () => {
    started();
    await blocked;
    return 'fixture-original-key';
  });
  const pending = service.setEnabled('example-key', true, actor);
  await reading;
  await service.upload('example-key', 'fixture-rotated-key', actor);
  await service.promote('example-key', '2', actor);
  resume();
  await expect(pending).rejects.toThrow('version changed');
  await service.setEnabled('example-key', true, actor);
  expect(
    (await service.deliver(job, await service.pin(job))).environment
      .EXAMPLE_API_KEY,
  ).toBe('fixture-rotated-key');
});
it('keeps set revisions immutable and refuses GitHub tokens as generic environment values', async () => {
  await expect(
    service.publish({ ...set, environment: {} }, actor),
  ).rejects.toThrow('Already exists');
  await expect(
    service.publish(
      {
        ...set,
        revision: 2,
        environment: { EXAMPLE_API_KEY: 'github-jlapenna' },
      },
      actor,
    ),
  ).rejects.toThrow('type mismatch');
});
it.each([
  'PATH',
  'LCARS_RUN_TOKEN',
  'GITHUB_TOKEN',
  'BASH_ENV',
  'NODE_OPTIONS',
  'GOOGLE_APPLICATION_CREDENTIALS',
])('rejects runtime override %s', async (name) => {
  await expect(
    service.publish(
      { ...set, revision: 2, environment: { [name]: 'example-key' } },
      actor,
    ),
  ).rejects.toThrow();
});
it.each(['expired', 'wrong-user', 'malformed'])(
  'refuses %s GitHub versions before upload/promotion',
  async (failure) => {
    const data =
      failure === 'malformed'
        ? 'fixture-plaintext-error'
        : JSON.stringify({
            token: 'fixture-new-token',
            expiresAt: failure === 'expired' ? now.toISOString() : null,
          });
    if (failure === 'wrong-user')
      service = new JobSecrets(
        registry,
        backend,
        () => now,
        async () => 'wrong-user',
      );
    await expect(
      service.upload('github-jlapenna', data, actor),
    ).rejects.toThrow();
    expect(versions.get('github-jlapenna')).toHaveLength(1);
  },
);

describe('credential administration HTTP boundary', () => {
  const principal = {
    principal: actor,
    scopes: new Set(['secrets.admin']),
    via: 'session',
    pipelines: ['goose'],
  } as WorkPrincipal;
  function request(path: string, body?: unknown) {
    return new Request(`https://console.test/api/work/v1/credentials${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  it('denies operators and repository-bound callers without opening the store', async () => {
    const factory = vi.fn(() => service);
    for (const caller of [
      undefined,
      { ...principal, scopes: new Set(['work.operator']) } as WorkPrincipal,
      { ...principal, sourceRepository: 'jlapenna/dev' },
    ])
      expect(
        (await jobSecretsHttp(request('/secrets'), caller, factory)).status,
      ).toBe(403);
    expect(factory).not.toHaveBeenCalled();
  });
  it('registers metadata without accepting a promoted version or a payload', async () => {
    const response = await jobSecretsHttp(
      request('/secrets', { name: 'new-key', kind: 'opaque' }),
      principal,
      () => service,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: 'new-key',
      enabled: true,
    });
    const invalid = await jobSecretsHttp(
      request('/secrets', {
        name: 'injected',
        kind: 'opaque',
        promotedVersion: '1',
        value: 'fixture-private-value',
      }),
      principal,
      () => service,
    );
    expect(invalid.status).toBe(409);
    expect(await registry.get('secrets', 'injected')).toBeUndefined();
  });
  it('lists safe metadata and provides protected-input upload without reflecting values or SDK errors', async () => {
    const listed = await jobSecretsHttp(
      request('/secrets'),
      principal,
      () => service,
    );
    const rows = (await listed.json()) as JobSecretRecord[];
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('fixture-');
    const uploaded = await jobSecretsHttp(
      request('/secrets/example-key/versions', { value: 'fixture-new-key' }),
      principal,
      () => service,
    );
    expect(await uploaded.json()).toEqual({ version: '2' });
    vi.mocked(backend.addVersion).mockRejectedValue(
      new Error('Authorization: Bearer fixture-private-error'),
    );
    const failed = await jobSecretsHttp(
      request('/secrets/example-key/versions', {
        value: 'fixture-private-error',
      }),
      principal,
      () => service,
    );
    expect(failed.status).toBe(409);
    expect(await failed.text()).not.toContain('fixture-private-error');
  });
});
