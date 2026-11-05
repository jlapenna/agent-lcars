import 'server-only';

import { logger } from '@agent-lcars/logging';
import {
  type CredentialSet,
  credentialSetSchema,
  githubJobSecretSchema,
  type JobCredentialGrant,
  jobCredentialGrantSchema,
  type JobSecretRecord,
  jobSecretRecordSchema,
  type JobSecretSnapshot,
  type JobCredentialObservation,
  jobSecretSnapshotSchema,
  jobSecretValueSchema,
} from '@agent-lcars/work';
import { z } from 'zod';

import type { JobSecretBackend } from './job-secret-backend';
import type { JobSecretStore } from './job-secret-store';
import { jobDigest } from './repository-job-definition';
import type { JobOccurrence } from './repository-job-store';

export type SecretJob = Pick<
  JobOccurrence,
  'id' | 'principal' | 'trigger' | 'definition' | 'profile'
>;
export function jobCredentialGrantId(
  grant: Pick<
    JobCredentialGrant,
    'repository' | 'job' | 'profile' | 'credentialSet'
  >,
) {
  return jobDigest([
    grant.repository,
    grant.job,
    grant.profile,
    grant.credentialSet,
  ]);
}
const setId = (set: { name: string; revision: number }) =>
  `${set.name}-${set.revision}`;
function secretNames(set: CredentialSet) {
  return [
    ...new Set([
      ...(set.github ? [set.github] : []),
      ...Object.values(set.environment),
      ...Object.values(set.files),
    ]),
  ];
}

export class JobSecrets {
  constructor(
    readonly store: JobSecretStore,
    private readonly backend: JobSecretBackend,
    private readonly now: () => Date = () => new Date(),
    private readonly githubLogin: (token: string) => Promise<string> = async (
      token,
    ) => {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('GitHub credential refused');
      const body = await response.json();
      if (typeof body.login !== 'string')
        throw new Error('GitHub identity unavailable');
      return body.login;
    },
  ) {}

  private async record(
    name: string,
    requireEnabled = true,
  ): Promise<JobSecretRecord> {
    const record = jobSecretRecordSchema.parse(
      await this.store.get('secrets', name),
    );
    if (record.name !== name || (requireEnabled && !record.enabled))
      throw new Error('Secret disabled or registry name mismatch');
    return record;
  }
  private async event(
    actor: string,
    operation: string,
    fields: Record<string, string>,
  ) {
    await this.store.audit({
      at: this.now().toISOString(),
      actor,
      operation,
      ...fields,
    });
  }
  async refused(job: SecretJob, stage: 'admission' | 'delivery') {
    try {
      await this.event(job.principal, `${stage}-refused`, {
        runOccurrence: job.id,
      });
    } catch {
      // Never replace the original refusal with credential-bearing SDK errors.
      logger.error('Job credential refusal audit unavailable');
    }
  }
  async observe(): Promise<JobCredentialObservation> {
    const now = this.now();
    const base = {
      version: 1 as const,
      observedAt: now.toISOString(),
      configured: true,
    };
    try {
      const [raw, health] = await Promise.all([
        this.store.list('secrets'),
        this.store.get('health', 'current'),
      ]);
      const records = z.array(jobSecretRecordSchema).max(500).parse(raw);
      const count = z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .default(0);
      const counters = z
        .strictObject({
          deliveries: count,
          deliveryTimed: count,
          deliveryDurationSeconds: z
            .number()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .default(0),
          admissionRefusals: count,
          deliveryRefusals: count,
          lastDeliveryAt: z.iso.datetime().optional(),
          lastRefusalAt: z.iso.datetime().optional(),
        })
        .parse(health ?? {});
      if (counters.deliveries > 0 && !counters.lastDeliveryAt)
        throw new Error('Credential counter clock unavailable');
      if (
        counters.deliveryTimed > counters.deliveries ||
        (counters.admissionRefusals + counters.deliveryRefusals > 0 &&
          !counters.lastRefusalAt)
      )
        throw new Error('Credential counter evidence unavailable');
      const counts = {
        total: records.length,
        ready: 0,
        disabled: 0,
        unpromoted: 0,
        expired: 0,
        expiring: 0,
        unknown: 0,
      };
      for (const record of records) {
        if (!record.enabled) counts.disabled++;
        else if (!record.promotedVersion) counts.unpromoted++;
        else if (record.kind === 'github' && record.expiresAt === undefined)
          counts.unknown++;
        else if (
          record.kind === 'github' &&
          record.expiresAt &&
          Date.parse(record.expiresAt) <= now.getTime() + 60_000
        )
          counts.expired++;
        else {
          counts.ready++;
          if (
            record.kind === 'github' &&
            record.expiresAt &&
            Date.parse(record.expiresAt) <= now.getTime() + 86_400_000
          )
            counts.expiring++;
        }
      }
      // One bounded, rotating container-metadata read; never read a secret value
      // or contact GitHub/inference merely to manufacture health evidence.
      const candidates = records
        .filter((record) => record.enabled)
        .sort((a, b) => a.name.localeCompare(b.name));
      let dependency: JobCredentialObservation['dependency'] = 'idle';
      if (candidates.length) {
        const candidate =
          candidates[Math.floor(now.getTime() / 300_000) % candidates.length];
        try {
          if (!candidate) throw new Error('No credential metadata candidate');
          await this.backend.checkContainer(candidate.name);
          dependency = 'ready';
        } catch {
          dependency = 'unavailable';
        }
      }
      return {
        ...base,
        observedAt: this.now().toISOString(),
        metadataAvailable: true,
        dependency,
        counts,
        ...counters,
      };
    } catch {
      return {
        ...base,
        observedAt: this.now().toISOString(),
        metadataAvailable: false,
        dependency: 'unknown',
      };
    }
  }
  async register(value: JobSecretRecord) {
    const record = jobSecretRecordSchema.parse(value);
    if (record.promotedVersion)
      throw new Error('Register first, then validate and promote a version');
    await this.backend.checkContainer(record.name);
    await this.event(record.updatedBy, 'register', { secret: record.name });
    await this.store.put('secrets', record.name, record, true);
    return record;
  }
  private async validate(record: JobSecretRecord, value: string) {
    jobSecretValueSchema.parse(value);
    if (record.kind === 'github') {
      const credential = githubJobSecretSchema.parse(JSON.parse(value));
      if (
        credential.expiresAt !== null &&
        Date.parse(credential.expiresAt) <= this.now().getTime() + 60000
      )
        throw new Error('GitHub credential expired');
      if (
        (await this.githubLogin(credential.token)).toLowerCase() !==
        record.login?.toLowerCase()
      )
        throw new Error('Unexpected GitHub identity');
      return credential;
    }
    return undefined;
  }
  async upload(name: string, value: string, actor: string) {
    const record = await this.record(name, false);
    await this.validate(record, value);
    await this.event(actor, 'upload', { secret: name });
    return { version: await this.backend.addVersion(name, value) };
  }
  async promote(name: string, version: string, actor: string) {
    const record = await this.record(name, false);
    const credential = await this.validate(
      record,
      await this.backend.readVersion(name, version),
    );
    await this.event(actor, 'promote', { secret: name, version });
    return this.store.mutateSecret(name, (current) => ({
      ...current,
      promotedVersion: version,
      validatedAt: this.now().toISOString(),
      ...(credential ? { expiresAt: credential.expiresAt } : {}),
      updatedAt: this.now().toISOString(),
      updatedBy: actor,
    }));
  }
  async disable(name: string, actor: string) {
    return this.setEnabled(name, false, actor);
  }
  async setEnabled(name: string, enabled: boolean, actor: string) {
    const record = await this.record(name, false);
    if (enabled && record.promotedVersion)
      await this.validate(
        record,
        await this.backend.readVersion(name, record.promotedVersion),
      );
    await this.event(actor, enabled ? 'enable' : 'disable', { secret: name });
    return this.store.mutateSecret(name, (current) => {
      if (enabled && current.promotedVersion !== record.promotedVersion)
        throw new Error(
          'Promoted version changed during validation; retry enable',
        );
      return {
        ...current,
        enabled,
        updatedBy: actor,
        updatedAt: this.now().toISOString(),
      };
    });
  }
  async publish(value: CredentialSet, actor: string) {
    const set = credentialSetSchema.parse(value);
    for (const name of secretNames(set)) {
      const record = await this.record(name);
      const needsOpaque =
        Object.values(set.environment).includes(name) ||
        Object.values(set.files).includes(name);
      if (
        (name === set.github && record.kind !== 'github') ||
        (needsOpaque && record.kind !== 'opaque')
      )
        throw new Error('Credential binding type mismatch');
    }
    await this.event(actor, 'publish-set', {
      set: set.name,
      revision: String(set.revision),
    });
    await this.store.put('sets', setId(set), set, true);
    return set;
  }
  async grant(value: JobCredentialGrant, actor: string) {
    const grant = jobCredentialGrantSchema.parse(value);
    credentialSetSchema.parse(
      await this.store.get('sets', setId(grant.credentialSet)),
    );
    await this.event(actor, grant.enabled ? 'grant' : 'revoke', {
      repository: grant.repository,
      job: grant.job,
      profile: grant.profile,
      set: grant.credentialSet.name,
      revision: String(grant.credentialSet.revision),
    });
    await this.store.put('grants', jobCredentialGrantId(grant), grant);
    return grant;
  }
  async authorize(job: SecretJob, snapshot?: JobSecretSnapshot) {
    const reference = job.profile.credentialSet;
    if (!reference) throw new Error('No credential set selected');
    if (snapshot && jobDigest(snapshot.credentialSet) !== jobDigest(reference))
      throw new Error('Credential set revision changed');
    const set = credentialSetSchema.parse(
      await this.store.get('sets', setId(reference)),
    );
    if (
      jobDigest({ name: set.name, revision: set.revision }) !==
      jobDigest(reference)
    )
      throw new Error('Credential set reference mismatch');
    const expected = {
      repository: job.definition.repository,
      job: job.definition.name,
      profile: job.profile.name,
      credentialSet: reference,
    };
    const grant = jobCredentialGrantSchema.parse(
      await this.store.get('grants', jobCredentialGrantId(expected)),
    );
    if (
      !grant.enabled ||
      jobCredentialGrantId(grant) !== jobCredentialGrantId(expected) ||
      !grant.principals.includes(job.principal) ||
      (job.trigger === 'schedule' && !grant.allowScheduled)
    )
      throw new Error('Job credential grant refused');
    const records = new Map<string, JobSecretRecord>();
    const versions: Record<string, string> = {};
    for (const name of secretNames(set)) {
      const record = await this.record(name);
      const version = snapshot
        ? snapshot.versions[name]
        : record.promotedVersion;
      if (!version) throw new Error('No approved secret version');
      versions[name] = version;
      records.set(name, record);
    }
    if (snapshot && jobDigest(versions) !== jobDigest(snapshot.versions))
      throw new Error('Credential snapshot bindings changed');
    return { set, records, versions };
  }
  async pin(job: SecretJob): Promise<JobSecretSnapshot> {
    const { set, versions } = await this.authorize(job);
    return jobSecretSnapshotSchema.parse({
      credentialSet: { name: set.name, revision: set.revision },
      versions,
    });
  }
  async deliver(job: SecretJob, snapshot: JobSecretSnapshot) {
    const started = performance.now();
    const { set, records, versions } = await this.authorize(job, snapshot);
    const values = new Map<string, string>();
    for (const name of new Set([
      ...Object.values(set.environment),
      ...Object.values(set.files),
    ])) {
      const version = versions[name];
      if (records.get(name)?.kind !== 'opaque' || !version)
        throw new Error('Credential binding type mismatch');
      const value = await this.backend.readVersion(name, version);
      await this.event(job.principal, 'deliver', {
        runOccurrence: job.id,
        secret: name,
        version,
      });
      values.set(name, value);
    }
    const delivery = {
      environment: Object.fromEntries(
        Object.entries(set.environment).map(([key, name]) => [
          key,
          jobSecretValueSchema.parse(values.get(name)),
        ]),
      ),
      files: Object.fromEntries(
        Object.entries(set.files).map(([key, name]) => [
          key,
          jobSecretValueSchema.parse(values.get(name)),
        ]),
      ),
    };
    await this.event(job.principal, 'delivery-completed', {
      runOccurrence: job.id,
      durationSeconds: String((performance.now() - started) / 1000),
    });
    return delivery;
  }
  async github(job: SecretJob, snapshot: JobSecretSnapshot) {
    const started = performance.now();
    const { set, records, versions } = await this.authorize(job, snapshot);
    if (!set.github) return undefined;
    const record = records.get(set.github);
    const version = versions[set.github];
    if (!record || record.kind !== 'github' || !record.login || !version)
      throw new Error('Credential binding type mismatch');
    const value = await this.backend.readVersion(record.name, version);
    const credential = await this.validate(record, value);
    if (!credential) throw new Error('GitHub credential missing');
    await this.event(job.principal, 'deliver-github', {
      runOccurrence: job.id,
      secret: record.name,
      version,
    });
    await this.event(job.principal, 'delivery-completed', {
      runOccurrence: job.id,
      durationSeconds: String((performance.now() - started) / 1000),
    });
    return {
      ...credential,
      login: record.login,
      refreshAt: new Date(
        Math.min(
          credential.expiresAt === null
            ? Infinity
            : Date.parse(credential.expiresAt),
          this.now().getTime() + 300000,
        ),
      ).toISOString(),
    };
  }
}
