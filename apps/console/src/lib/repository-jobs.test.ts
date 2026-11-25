import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  externalizeRunMessage,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import { workSpecSchema } from '@agent-lcars/work';
import { deriveItemState } from '@agent-lcars/work/derive';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml, stringify } from 'yaml';

import { GcsCodexAuthStore } from './codex-auth-store';
import { releaseCodexCredentialLease } from './codex-credential-operations';
import { deliveryCorrectionAuthorized } from './ready-delivery';
import {
  gooseJobExecutionSchema,
  harnessJobExecutionSchema,
  jobDueAt,
  jobKey,
  type JobProfile,
  jobProfileSchema,
  parseJobDefinition,
  renderHarnessJobPrompt,
} from './repository-job-definition';
import { validateJobResult } from './repository-job-result';
import {
  type CatalogJob,
  FirestoreJobStore,
  type JobOccurrence,
  jobOccurrenceSchema,
  type JobStore,
} from './repository-job-store';
import { RepositoryJobs } from './repository-jobs';
import { ConditionalCodexBucket } from './testing/codex-auth-bucket';
import { parseWorkGrants } from './work-grants';

class TestStore implements JobStore {
  jobs = new Map<string, CatalogJob>();
  occurrences = new Map<string, JobOccurrence>();
  async list() {
    return [...this.jobs.values()];
  }
  async readOccurrence(id: string) {
    return this.occurrences.get(id);
  }
  async history(id: string) {
    return [...this.occurrences.values()].filter((value) => value.jobId === id);
  }
  async sourceRefreshes() {
    return new Map<string, string>();
  }
  async recordSourceRefresh() {
    return undefined;
  }
  async mutate(
    id: string,
    occurrenceId: string | undefined,
    change: Parameters<JobStore['mutate']>[2],
  ) {
    const result = await change(
      this.jobs.get(id),
      occurrenceId ? this.occurrences.get(occurrenceId) : undefined,
    );
    if (result.job) this.jobs.set(id, structuredClone(result.job));
    if (result.occurrence)
      this.occurrences.set(
        result.occurrence.id,
        structuredClone(result.occurrence),
      );
    return result;
  }
}
function fixture(
  parameters: {
    key: string;
    description: string;
    input_type: 'string';
    requirement: 'required' | 'optional';
    default?: string;
  }[] = [],
  profileName = 'audit',
  description = 'Audit inventory',
) {
  let at = new Date('2026-10-27T06:00:00.000Z');
  const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
  const definition = parseJobDefinition(
    'octo/repo',
    'a'.repeat(40),
    'audit',
    stringify({
      version: 1,
      description,
      triggers: {
        manual: true,
        ...(parameters.length
          ? {}
          : {
              schedule: { cron: '0 1 * * *', timezone: 'America/Los_Angeles' },
            }),
      },
      execution: {
        recipe: './recipe.yaml',
        profile: profileName,
        timeout: '10m',
        maxAttempts: 1,
        resources: { requests: { ...allocation }, limits: { ...allocation } },
      },
      inputs: { scope: 'inventory', mode: 'report' },
      concurrency: { maxRuns: 1, overlap: 'skip' },
      state: { previousSuccessfulResult: true },
      result: {
        contract: 'json-v1',
        requiredArtifacts: ['report.md', 'result.json'],
      },
    }),
    stringify({
      version: '1.0.0',
      title: 'Audit',
      description: 'Read inventory',
      prompt: 'Report inventory',
      parameters: [
        ...['scope', 'mode', 'baseline'].map((key) => ({
          key,
          description: key,
          input_type: 'string',
          requirement: 'required',
        })),
        ...parameters,
      ],
    }),
  );
  const profile: JobProfile = {
    name: 'audit',
    allocation,
    repositories: ['octo/repo'],
    principals: ['user:joe'],
    inputSets: [{ scope: 'inventory', mode: 'report' }],
  };
  const store = new TestStore();
  const native = new MemoryStore();
  const orchestrator = new Orchestrator(native, {
    now: () => at.toISOString(),
  });
  const granted = vi.fn(() => true);
  const jobs = new RepositoryJobs({
    store,
    profiles: () => [profile],
    granted,
    now: () => at,
    runtime: {
      store: native,
      orchestrator,
      drain: async () => ({ dispatched: [], reported: [], failed: [] }),
    },
  });
  const id = jobKey('octo/repo', 'audit');
  store.jobs.set(id, {
    id,
    repository: 'octo/repo',
    name: 'audit',
    definition,
    enabled: true,
    enabledBy: 'user:joe',
    activationFloor: '2026-10-26T00:00:00.000Z',
    refreshedAt: at.toISOString(),
  });
  return {
    jobs,
    store,
    native,
    orchestrator,
    definition,
    profile,
    granted,
    id,
    setTime: (value: string) => {
      at = new Date(value);
    },
  };
}
describe('production repository job admission', () => {
  it('enables and admits a repository job without per-job configuration', async () => {
    const f = fixture([], 'repository');
    f.jobs.deps.profiles = vi.fn(() => []);
    f.store.jobs.get(f.id)!.enabled = false;
    await expect(
      f.jobs.enable(f.id, 'stale-digest', 'user:joe', true),
    ).rejects.toThrow('review the current definition');
    await f.jobs.enable(f.id, f.definition.digest, 'user:joe', true);
    const occurrence = await f.jobs.admit(
      f.id,
      'installed',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    expect(f.jobs.deps.profiles).not.toHaveBeenCalled();
    expect(occurrence.profile.inputSets).toEqual([f.definition.job.inputs]);
    expect(occurrence.profile.repositories).toEqual(['octo/repo']);
    const runs = await f.native.listRuns({ workId: occurrence.workId });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.params?.['crossRepo']).toBeUndefined();
    f.granted.mockReturnValue(false);
    await expect(
      f.jobs.enable(f.id, f.definition.digest, 'user:joe', true),
    ).rejects.toThrow('Goose operator grant required');
    await expect(
      f.jobs.admit(f.id, 'revoked', 'user:joe', 'manual', f.definition.digest),
    ).rejects.toThrow('Goose operator grant required');
  });
  it('keeps the repository lane allocation fixed and ignores configured authority overrides', () => {
    const f = fixture([], 'repository');
    f.profile.name = 'repository';
    f.profile.crossRepo = true;
    expect(
      f.jobs.authorize(f.definition, 'user:joe').crossRepo,
    ).toBeUndefined();
    f.definition.job.execution.resources.requests.memory = '3Gi';
    f.definition.job.execution.resources.limits.memory = '3Gi';
    expect(() => f.jobs.authorize(f.definition, 'user:joe')).toThrow(
      'Allocation must match profile exactly',
    );
  });
  it('admits weekly repository schedules with the enabling principal grant', async () => {
    const f = fixture([], 'repository');
    f.jobs.deps.profiles = () => [];
    f.definition.job.triggers.schedule = { cron: '0 6 * * 2', timezone: 'UTC' };
    await f.jobs.tick();
    const occurrence = [...f.store.occurrences.values()][0]!;
    expect(occurrence.trigger).toBe('schedule');
    expect(occurrence.principal).toBe('user:joe');
    expect(await f.native.listRuns({ workId: occurrence.workId })).toHaveLength(
      1,
    );
  });
  it.each([undefined, false, true])(
    'uses cross-repository credentials only when the operator profile enables them (%s)',
    async (crossRepo) => {
      const f = fixture([
        {
          key: 'crossRepo',
          description: 'Caller data, not credential authority',
          input_type: 'string',
          requirement: 'optional',
        },
      ]);
      if (crossRepo !== undefined) f.profile.crossRepo = crossRepo;
      // Parsing old persisted profiles must preserve their digest.
      expect(jobProfileSchema.parse(f.profile)).toEqual(f.profile);
      // The retired Goose environment overlay selector is not configuration.
      expect(() =>
        jobProfileSchema.parse({ ...f.profile, environment: 'skill-evals' }),
      ).toThrow();
      const occurrence = await f.jobs.admit(
        f.id,
        'manual-credential-scope',
        'user:joe',
        'manual',
        f.definition.digest,
        { crossRepo: crossRepo === true ? 'false' : 'true' },
      );
      const runs = await f.native.listRuns({ workId: occurrence.workId });
      expect(runs).toHaveLength(1);
      expect(runs[0]!.params?.['crossRepo']).toBe(
        crossRepo === true ? 'true' : undefined,
      );
    },
  );
  it('requires a model exactly for the Antigravity harness', () => {
    const f = fixture([]);
    const agy = {
      ...f.profile,
      providerAuth: 'agy' as const,
      providerModel: 'gemini-4-argon',
    };
    expect(jobProfileSchema.parse(agy).providerModel).toBe('gemini-4-argon');
    const { providerModel: _model, ...withoutModel } = agy;
    expect(() => jobProfileSchema.parse(withoutModel)).toThrow();
    expect(() =>
      jobProfileSchema.parse({ ...agy, providerAuth: 'claude' }),
    ).toThrow();
    expect(() =>
      jobProfileSchema.parse({ ...agy, providerModel: 'bad model' }),
    ).toThrow();
  });
  it('accepts operator-owned result files without changing existing profiles', () => {
    const f = fixture([]);
    expect(jobProfileSchema.parse(f.profile)).toEqual(f.profile);
    const resultFile = '/tmp/skill-evals/report/result.json';
    expect(
      jobProfileSchema.parse({ ...f.profile, resultFile }).resultFile,
    ).toBe(resultFile);
    for (const path of [
      '/run/secrets/result.json',
      '/tmp/../result.json',
      '/tmp//result.json',
      '/tmp/./result.json',
    ])
      expect(() =>
        jobProfileSchema.parse({ ...f.profile, resultFile: path }),
      ).toThrow();
  });
  it('admits automatically activated schedules only after the activation floor', async () => {
    const f = fixture([], 'repository');
    f.jobs.deps.profiles = () => [];
    f.jobs.deps.automationPrincipal = () => 'svc:scheduler';
    f.definition.job.triggers.schedule = { cron: '0 6 * * 2', timezone: 'UTC' };
    const job = f.store.jobs.get(f.id)!;
    // Activated two minutes after Tuesday's 06:00 slot, still inside the
    // tick's five-minute window: that slot predates activation.
    f.setTime('2026-10-27T06:02:00.000Z');
    expect(f.jobs.automaticActivation(f.definition)).toBe('svc:scheduler');
    Object.assign(job, {
      enabledBy: 'svc:scheduler',
      activationFloor: '2026-10-27T06:02:00.000Z',
      refreshedAt: '2026-10-27T06:02:00.000Z',
    });
    f.setTime('2026-10-27T06:04:00.000Z');
    expect(await f.jobs.tick()).toEqual([]);
    expect(f.store.occurrences.size).toBe(0);
    f.setTime('2026-11-03T06:01:00.000Z');
    job.refreshedAt = '2026-11-03T06:00:30.000Z';
    expect(await f.jobs.tick()).toEqual([]);
    const occurrence = [...f.store.occurrences.values()][0]!;
    expect(occurrence).toMatchObject({
      trigger: 'schedule',
      principal: 'svc:scheduler',
    });
    // Admission still re-checks the scheduler's current grant.
    f.granted.mockReturnValue(false);
    f.setTime('2026-11-10T06:01:00.000Z');
    job.refreshedAt = '2026-11-10T06:00:30.000Z';
    delete f.store.jobs.get(f.id)!.active;
    expect(await f.jobs.tick()).toEqual([
      'octo/repo:audit: Goose operator grant required',
    ]);
  });
  it('replays one request, skips overlap, and rejects changed request content', async () => {
    const f = fixture();
    const run = await f.jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    expect(
      await f.jobs.admit(
        f.id,
        'manual-1',
        'user:joe',
        'manual',
        f.definition.digest,
      ),
    ).toEqual(run);
    expect(
      (
        await f.jobs.admit(
          f.id,
          'manual-2',
          'user:joe',
          'manual',
          f.definition.digest,
        )
      ).skipped,
    ).toBe(true);
    expect(await f.native.listRuns({ workId: run.workId })).toHaveLength(1);
    await expect(
      f.jobs.admit(f.id, 'manual-1', 'user:joe', 'manual', 'c'.repeat(64)),
    ).rejects.toThrow('reused');
    expect(
      workSpecSchema.safeParse({
        title: 'forged',
        description: 'forged',
        pipeline: 'goose',
        target: { repo: 'octo/repo' },
      }).success,
    ).toBe(false);
  });
  it('recovers an interrupted mint using the original immutable reservation', async () => {
    const f = fixture();
    const request = vi
      .spyOn(f.orchestrator, 'request')
      .mockRejectedValueOnce(new Error('interrupted'));
    await expect(
      f.jobs.admit(f.id, 'manual-1', 'user:joe', 'manual', f.definition.digest),
    ).rejects.toThrow('interrupted');
    const occurrence = [...f.store.occurrences.values()][0]!;
    // Firestore map ordering differs from configuration JSON ordering.
    occurrence.profile.inputSets[0] = { mode: 'report', scope: 'inventory' };
    f.store.jobs.get(f.id)!.definition = {
      ...f.definition,
      revision: 'c'.repeat(40),
    };
    await f.jobs.reconcile(f.store.jobs.get(f.id)!);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await f.native.listRuns({ workId: occurrence.workId })).toHaveLength(
      1,
    );
    expect(occurrence.definition.revision).toBe('a'.repeat(40));
  });
  it('does not advance baseline for staged artifacts or failed Work', async () => {
    const f = fixture();
    const occurrence = await f.jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    const artifact = validateJobResult(f.definition, {
      report: 'Inventory read',
      complete: true,
      data: { count: 3 },
    });
    await f.jobs.stage(occurrence, artifact);
    await f.jobs.reconcile(f.store.jobs.get(f.id)!);
    expect(f.store.jobs.get(f.id)!.baseline).toBeUndefined();
    const run = (await f.native.listRuns({ workId: occurrence.workId }))[0]!;
    await f.orchestrator.report(run.runId, {
      ok: false,
      ref: `job-result:${artifact.digest}`,
    });
    await f.jobs.reconcile(f.store.jobs.get(f.id)!);
    expect(f.store.jobs.get(f.id)!.baseline).toBeUndefined();
    expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
  });
  it('refuses placeholder results instead of staging a baseline', () => {
    const f = fixture();
    expect(() =>
      validateJobResult(f.definition, {
        report: 'placeholder',
        complete: true,
        data: {},
      }),
    ).toThrow('Placeholder text');
    const audit = {
      ...f.definition,
      job: {
        ...f.definition.job,
        inputs: { subnet: '192.0.2.0/24' },
        result: {
          contract: 'security-audit-v1' as const,
          requiredArtifacts: ['report.md', 'findings.json', 'coverage.json'],
        },
      },
    };
    const result = (evidence: string) => ({
      report: 'Scanned the subnet.',
      findings: { version: 1, items: [] },
      coverage: {
        version: 1,
        scope: '192.0.2.0/24',
        checks: [
          'discovery',
          'ports',
          'services',
          'baseline',
          'existing-issues',
        ].map((name) => ({ name, status: 'complete', evidence: [evidence] })),
      },
    });
    expect(
      validateJobResult(audit, result('256 addresses probed')).successful,
    ).toBe(true);
    expect(() => validateJobResult(audit, result(' placeholder '))).toThrow(
      'Placeholder text',
    );
  });
  it('advances baseline only from matching successful native completion', async () => {
    const f = fixture();
    const occurrence = await f.jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    const artifact = validateJobResult(f.definition, {
      report: 'Inventory read',
      complete: true,
      data: { count: 3 },
    });
    await f.jobs.stage(occurrence, artifact);
    const run = (await f.native.listRuns({ workId: occurrence.workId }))[0]!;
    await f.orchestrator.report(run.runId, {
      ok: true,
      ref: `job-result:${artifact.digest}`,
    });
    await f.jobs.reconcile(f.store.jobs.get(f.id)!);
    expect(f.store.jobs.get(f.id)!.baseline?.occurrence).toBe(occurrence.id);
    const next = await f.jobs.admit(
      f.id,
      'manual-2',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    expect(next.baselineOccurrence).toBe(occurrence.id);
  });
  it('refuses revoked grants and stale catalog admission', async () => {
    const f = fixture();
    f.granted.mockReturnValue(false);
    await expect(
      f.jobs.admit(f.id, 'manual-1', 'user:joe', 'manual', f.definition.digest),
    ).rejects.toThrow('grant');
    f.granted.mockReturnValue(true);
    f.setTime('2026-10-27T06:11:00.000Z');
    await expect(
      f.jobs.admit(f.id, 'manual-1', 'user:joe', 'manual', f.definition.digest),
    ).rejects.toThrow('refresh');
  });
  it.each([false, true])(
    'holds overlap and baseline until actual executor exit (Codex provider=%s)',
    async (codex) => {
      const f = fixture();
      if (codex) f.profile.providerAuth = 'codex';
      const occurrence = await f.jobs.admit(
        f.id,
        'manual-1',
        'user:joe',
        'manual',
        f.definition.digest,
      );
      const run = (await f.native.listRuns({ workId: occurrence.workId }))[0]!;
      const at = '2026-10-27T06:00:00.000Z';
      await f.native.enqueueRun({ runId: run.runId, now: at });
      await f.native.claimQueuedRun({
        pipelines: ['goose'],
        now: at,
        claimedBy: 'executor',
        claimedBySubject: 'executor@example.iam.gserviceaccount.com',
        tokenHash: 'a'.repeat(64),
      });
      const artifact = validateJobResult(f.definition, {
        report: 'Probe inventory verified',
        complete: true,
        data: { count: 3 },
      });
      await f.jobs.stage(occurrence, artifact);
      await f.orchestrator.report(
        run.runId,
        { ok: true, ref: `job-result:${artifact.digest}` },
        'a'.repeat(64),
      );
      if (codex) {
        await releaseCodexCredentialLease(
          {
            store: f.native,
            orchestrator: f.orchestrator,
            codexAuth: new GcsCodexAuthStore(
              new ConditionalCodexBucket().bucket,
            ),
            now: () => new Date(at),
          },
          (await f.native.readRun(run.runId))!,
        );
      }
      // A settled run is not evidence that its worker stopped.
      await f.jobs.reconcile(f.store.jobs.get(f.id)!);
      expect(f.store.jobs.get(f.id)!.active).toBe(occurrence.id);
      await f.orchestrator.executorExited(run.runId, {
        subject: 'executor@example.iam.gserviceaccount.com',
        runner: 'executor',
        claimFingerprint: 'a'.repeat(64),
      });
      await f.jobs.reconcile(f.store.jobs.get(f.id)!);
      expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
      expect(f.store.jobs.get(f.id)!.baseline?.occurrence).toBe(occurrence.id);
    },
  );
  it('releases occupancy once the worker can no longer be running', async () => {
    const f = fixture();
    const occurrence = await f.jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    const run = (await f.native.listRuns({ workId: occurrence.workId }))[0]!;
    const at = '2026-10-27T06:00:00.000Z';
    await f.native.enqueueRun({ runId: run.runId, now: at });
    await f.native.claimQueuedRun({
      pipelines: ['goose'],
      now: at,
      claimedBy: 'executor',
      claimedBySubject: 'executor@example.iam.gserviceaccount.com',
      tokenHash: 'a'.repeat(64),
    });
    await f.orchestrator.report(run.runId, { ok: false }, 'a'.repeat(64));
    const settledAt = Date.parse(
      (await f.native.readRun(run.runId))!.updatedAt,
    );
    // No exit report ever arrives (for example, an executor restart lost
    // track of a deleted Job): placement wait plus the Pod runtime limit
    // bound how long its worker could still run.
    f.setTime(new Date(settledAt + 3 * 3_600_000 - 60_000).toISOString());
    await f.jobs.reconcile(f.store.jobs.get(f.id)!);
    expect(f.store.jobs.get(f.id)!.active).toBe(occurrence.id);
    f.setTime(new Date(settledAt + 3 * 3_600_000 + 60_000).toISOString());
    await f.jobs.reconcile(f.store.jobs.get(f.id)!);
    expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
  });
  it('recognizes both fall-back occurrences and skips a nonexistent local time', () => {
    const f = fixture();
    expect(jobDueAt(f.definition, new Date('2026-11-01T08:00:00Z'))).toBe(true);
    expect(jobDueAt(f.definition, new Date('2026-11-01T09:00:00Z'))).toBe(true);
    f.definition.job.triggers.schedule!.cron = '0 2 * * *';
    expect(jobDueAt(f.definition, new Date('2026-03-08T10:00:00Z'))).toBe(
      false,
    );
  });
  it('settles a lost recipe without creating an automatic successor', async () => {
    const f = fixture();
    const occurrence = await f.jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    f.setTime('2026-10-27T10:00:00.000Z');
    const sweep = await f.orchestrator.sweepExpired();
    expect(sweep.retried).toHaveLength(0);
    expect(
      (await f.native.listRuns({ workId: occurrence.workId })).map(
        (run) => run.state,
      ),
    ).toEqual(['lost']);
    expect(
      deriveItemState(
        (await f.native.readTask({ workId: occurrence.workId }))!.task,
        await f.native.listRuns({ workId: occurrence.workId }),
      ),
    ).toBe('failed');
  });
});

it('mints Work that references the occurrence instead of copying a long job description', async () => {
  const description = 'd'.repeat(40 * 1024);
  const f = fixture([], 'audit', description);
  const occurrence = await f.jobs.admit(
    f.id,
    'manual-1',
    'user:joe',
    'manual',
    f.definition.digest,
  );
  const task = (await f.native.readTask({ workId: occurrence.workId }))!.task;
  expect(JSON.stringify(task)).not.toContain(description);
  expect(JSON.stringify(task)).toContain(
    `/api/work/v1/jobs/occurrences/${occurrence.id}`,
  );
  expect(occurrence.definition.job.description).toBe(description);
});

describe('recipe invocation parameters', () => {
  const parameter = {
    key: 'pullRequest',
    description: 'PR number',
    input_type: 'string' as const,
    requirement: 'required' as const,
  };
  it('pins values and replays the same named event after a catalog update', async () => {
    const f = fixture([
      parameter,
      {
        ...parameter,
        key: 'context',
        requirement: 'optional',
        default: 'original',
      },
    ]);
    const first = await f.jobs.invoke(
      'octo/repo',
      'audit',
      'event-1',
      'user:joe',
      { pullRequest: '42' },
    );
    expect(first.parameters).toEqual({
      pullRequest: '42',
      context: 'original',
    });
    const catalog = f.store.jobs.get(f.id)!;
    f.store.jobs.set(f.id, {
      ...catalog,
      definition: {
        ...f.definition,
        digest: 'b'.repeat(64),
        parameters: [{ ...parameter, key: 'newRequiredValue' }],
      },
    });
    expect(
      await f.jobs.invoke('octo/repo', 'audit', 'event-1', 'user:joe', {
        pullRequest: '42',
      }),
    ).toEqual(first);
    await expect(
      f.jobs.invoke('octo/repo', 'audit', 'event-1', 'user:joe', {
        pullRequest: '43',
      }),
    ).rejects.toThrow('Request ID reused');
  });
  it('rejects missing, unknown and fixed-scope overrides before creating Work', async () => {
    const f = fixture([parameter]);
    for (const values of [
      {},
      { pullRequest: '42', scope: 'other' },
      { pullRequest: '42', baseline: 'forged' },
      { pullRequest: '42', extra: 'x' },
    ]) {
      await expect(
        f.jobs.invoke('octo/repo', 'audit', 'invalid', 'user:joe', values),
      ).rejects.toThrow();
    }
    expect(f.store.occurrences.size).toBe(0);
  });
  it('defers a busy event without recording a permanent skipped occurrence', async () => {
    const f = fixture([parameter]);
    await f.jobs.invoke('octo/repo', 'audit', 'event-1', 'user:joe', {
      pullRequest: '42',
    });
    await expect(
      f.jobs.invoke('octo/repo', 'audit', 'event-2', 'user:joe', {
        pullRequest: '43',
      }),
    ).rejects.toThrow('Job already active');
    expect(f.store.occurrences.size).toBe(1);
    const { active: _active, ...idle } = f.store.jobs.get(f.id)!;
    f.store.jobs.set(f.id, idle);
    const admitted = await f.jobs.invoke(
      'octo/repo',
      'audit',
      'event-2',
      'user:joe',
      { pullRequest: '43' },
    );
    expect(admitted.skipped).toBe(false);
    expect(admitted.parameters.pullRequest).toBe('43');
  });
});

it('bounds recipe and harness timeouts and maxAttempts within Pod deadlines', () => {
  expect(gooseJobExecutionSchema.shape.timeout.safeParse('45m').success).toBe(
    true,
  );
  expect(gooseJobExecutionSchema.shape.timeout.safeParse('46m').success).toBe(
    false,
  );
  expect(gooseJobExecutionSchema.shape.maxAttempts.safeParse(1).success).toBe(
    true,
  );
  expect(gooseJobExecutionSchema.shape.maxAttempts.safeParse(2).success).toBe(
    true,
  );
  expect(gooseJobExecutionSchema.shape.maxAttempts.safeParse(3).success).toBe(
    false,
  );
  expect(harnessJobExecutionSchema.shape.timeout.safeParse('80m').success).toBe(
    true,
  );
  expect(harnessJobExecutionSchema.shape.timeout.safeParse('81m').success).toBe(
    false,
  );
});

it('pins an explicitly authorized manual profile without changing the manifest or schedule', async () => {
  const f = fixture([], 'repository');
  f.profile.credentialSet = { name: 'personal', revision: 1 };
  f.jobs.deps.secrets = {
    refused: vi.fn(async () => undefined),
    pin: async () => ({
      credentialSet: { name: 'personal', revision: 1 },
      versions: {},
    }),
    authorize: vi.fn(),
  };
  f.profile.gitIdentity = { name: 'Joe LaPenna', email: 'joe@example.invalid' };
  expect(f.jobs.availableProfiles(f.definition, 'user:joe')).toEqual([
    'repository',
    'audit',
  ]);
  expect(f.jobs.availableProfiles(f.definition, 'other-user')).toEqual([
    'repository',
  ]);
  const occurrence = await f.jobs.invoke(
    'octo/repo',
    'audit',
    'personal-once',
    'user:joe',
    {},
    'audit',
  );
  expect(occurrence.profile.credentialSet?.name).toBe('personal');
  expect(occurrence.definition.job.execution.profile).toBe('repository');
  expect(f.jobs.authorizeOccurrence(occurrence)).toEqual(f.profile);
  expect(
    await f.jobs.invoke(
      'octo/repo',
      'audit',
      'personal-once',
      'user:joe',
      {},
      'audit',
    ),
  ).toEqual(occurrence);
  await expect(
    f.jobs.invoke('octo/repo', 'audit', 'personal-once', 'user:joe'),
  ).rejects.toThrow('Request ID reused');
  await expect(
    f.jobs.invoke(
      'octo/repo',
      'audit',
      'not-granted',
      'user:joe',
      {},
      'missing',
    ),
  ).rejects.toThrow('not granted');
  await expect(
    f.jobs.admit(
      f.id,
      'schedule',
      'user:joe',
      'schedule',
      f.definition.digest,
      {},
      false,
      'audit',
    ),
  ).rejects.toThrow('Scheduled runs use the manifest profile');
  const pinned = (await f.store.readOccurrence(occurrence.id))!;
  f.profile.credentialSet = { name: 'different', revision: 1 };
  expect(() => f.jobs.authorizeOccurrence(pinned)).toThrow(
    'Reserved execution profile changed',
  );
});

it('rejects a manual profile for another principal or repository', async () => {
  const f = fixture([], 'repository');
  f.profile.credentialSet = { name: 'personal', revision: 1 };
  f.jobs.deps.secrets = {
    refused: vi.fn(async () => undefined),
    pin: async () => ({
      credentialSet: { name: 'personal', revision: 1 },
      versions: {},
    }),
    authorize: vi.fn(),
  };
  await expect(
    f.jobs.invoke(
      'octo/repo',
      'audit',
      'wrong-user',
      'other-user',
      {},
      'audit',
    ),
  ).rejects.toThrow('not granted');
  f.profile.repositories = ['other/repo'];
  await expect(
    f.jobs.invoke('octo/repo', 'audit', 'wrong-repo', 'user:joe', {}, 'audit'),
  ).rejects.toThrow('not granted');
});

it('refuses credential admission before reserving the active slot and retries after access is restored', async () => {
  const f = fixture();
  f.profile.credentialSet = { name: 'personal', revision: 1 };
  const pin = vi.fn().mockRejectedValue(new Error('fixture-private-error'));
  const refused = vi.fn(async () => undefined);
  f.jobs.deps.secrets = { pin, authorize: vi.fn(), refused };
  await expect(
    f.jobs.admit(
      f.id,
      'denied-credentials',
      'user:joe',
      'manual',
      f.definition.digest,
    ),
  ).rejects.toThrow('Job credential admission refused');
  expect(f.store.jobs.get(f.id)?.active).toBeUndefined();
  expect(f.store.occurrences.size).toBe(0);
  expect(refused).toHaveBeenCalledWith(
    expect.objectContaining({ trigger: 'manual' }),
    'admission',
  );
  pin.mockResolvedValue({
    credentialSet: f.profile.credentialSet,
    versions: { 'github-jlapenna': '1' },
  });
  const admitted = await f.jobs.admit(
    f.id,
    'denied-credentials',
    'user:joe',
    'manual',
    f.definition.digest,
  );
  expect(admitted.secretSnapshot?.versions).toEqual({ 'github-jlapenna': '1' });
  expect(await f.native.listRuns({ workId: admitted.workId })).toHaveLength(1);
});

it('settles terminal Work after credential or profile revocation without stranding future occurrences', async () => {
  const f = fixture();
  f.profile.credentialSet = { name: 'personal', revision: 1 };
  const pin = vi.fn(async () => ({
    credentialSet: { name: 'personal', revision: 1 },
    versions: { 'github-jlapenna': '1' },
  }));
  f.jobs.deps.secrets = {
    pin,
    authorize: vi.fn(),
    refused: vi.fn(async () => undefined),
  };
  const occurrence = await f.jobs.admit(
    f.id,
    'before-revocation',
    'user:joe',
    'manual',
    f.definition.digest,
  );
  pin.mockRejectedValue(new Error('Grant revoked'));
  f.profile.credentialSet = { name: 'replacement', revision: 2 };
  const run = (await f.native.listRuns({ workId: occurrence.workId }))[0]!;
  await f.orchestrator.report(run.runId, { ok: false });
  await f.jobs.reconcile(f.store.jobs.get(f.id)!);
  expect(f.store.jobs.get(f.id)?.active).toBeUndefined();
  expect(
    (await f.store.readOccurrence(occurrence.id))?.reconciledAt,
  ).toBeDefined();
});

it('decodes occurrences admitted with the retired Goose environment overlay while rejecting legacy credentials', async () => {
  const f = fixture();
  const occurrence = await f.jobs.admit(
    f.id,
    'overlay-history',
    'user:joe',
    'manual',
    f.definition.digest,
  );
  const stored = {
    ...occurrence,
    profile: { ...occurrence.profile, environment: 'skill-evals' },
  };
  const decoded = jobOccurrenceSchema.parse(stored);
  expect(decoded.profile).toEqual(stored.profile);
  const document = { exists: true, data: () => structuredClone(decoded) };
  const database = {
    collection: () => ({
      doc: () => ({ get: async () => document }),
      where: () => ({
        limit: () => ({ get: async () => ({ docs: [document] }) }),
      }),
    }),
  };
  const persisted = new FirestoreJobStore(
    database as unknown as ConstructorParameters<typeof FirestoreJobStore>[0],
  );
  expect(await persisted.readOccurrence(decoded.id)).toEqual(decoded);
  expect(await persisted.history(decoded.jobId)).toEqual([decoded]);
  expect(() =>
    jobOccurrenceSchema.parse({
      ...occurrence,
      profile: {
        ...occurrence.profile,
        credentials: { github: 'personal' },
      },
    }),
  ).toThrow();
  expect(() =>
    jobOccurrenceSchema.parse({
      ...stored,
      profile: { ...stored.profile, environment: 'Skill Evals' },
    }),
  ).toThrow();
});

it('pins provider auth into the admitted recipe run and revokes it with the profile', async () => {
  const f = fixture();
  f.profile.providerAuth = 'codex';
  const occurrence = await f.jobs.invoke(
    'octo/repo',
    'audit',
    'codex-provider',
    'user:joe',
  );
  const task = await f.native.readTask({ workId: occurrence.workId });
  const run = await f.native.readRun(task!.task.activeRunId!);
  expect(run?.params).toMatchObject({
    jobOccurrence: occurrence.id,
    providerAuth: 'codex',
  });
  delete f.profile.providerAuth;
  expect(() => f.jobs.authorizeOccurrence(occurrence)).toThrow();
});

describe('provider-limit fallback', () => {
  async function settle(
    f: ReturnType<typeof fixture>,
    jobs: RepositoryJobs,
    occurrence: { id: string; workId: string },
    data: Record<string, unknown>,
  ) {
    const run = (await f.native.listRuns({ workId: occurrence.workId }))[0]!;
    const artifact = validateJobResult(f.definition, {
      report: 'Evaluator report',
      complete: false,
      data,
    });
    const saved = (await f.store.readOccurrence(occurrence.id))!;
    await jobs.stage(saved, artifact);
    await f.orchestrator.report(run.runId, {
      ok: true,
      ref: `job-result:${artifact.digest}`,
    });
    await jobs.reconcile(f.store.jobs.get(f.id)!);
  }
  function withFallback(f: ReturnType<typeof fixture>) {
    f.profile.providerAuth = 'codex';
    f.profile.fallbackProfile = 'audit-claude';
    const claude: JobProfile = {
      ...f.profile,
      name: 'audit-claude',
      providerAuth: 'claude',
    };
    delete claude.fallbackProfile;
    return new RepositoryJobs({
      ...f.jobs.deps,
      profiles: () => [f.profile, claude],
    });
  }

  it('re-admits a provider-limited occurrence once under the fallback profile', async () => {
    const f = fixture();
    const jobs = withFallback(f);
    const original = await jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    await settle(f, jobs, original, {
      runner: 'codex',
      partial: true,
      partialReason: 'provider-limit',
    });
    const job = f.store.jobs.get(f.id)!;
    expect(job.active).toBeDefined();
    expect(job.active).not.toBe(original.id);
    expect(job.latest).toBe(job.active);
    expect((await f.store.readOccurrence(original.id))?.successful).toBe(false);
    const fallback = (await f.store.readOccurrence(job.active!))!;
    expect(fallback).toMatchObject({
      fallbackOf: original.id,
      trigger: 'manual',
      principal: 'user:joe',
      profile: { name: 'audit-claude', providerAuth: 'claude' },
    });
    expect(fallback.comparison).not.toBe(original.comparison);

    // The next tick mints the fallback's Work with the Claude harness.
    await jobs.reconcile(f.store.jobs.get(f.id)!);
    const runs = await f.native.listRuns({ workId: fallback.workId });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.params).toMatchObject({ providerAuth: 'claude' });

    // A fallback whose profile declares no further fallback settles.
    await settle(f, jobs, fallback, {
      runner: 'claude',
      partial: true,
      partialReason: 'provider-limit',
    });
    expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
    expect((await f.store.readOccurrence(fallback.id))?.successful).toBe(false);
  });

  it('chains through declared fallbacks at most twice and never revisits a profile', async () => {
    const f = fixture();
    f.profile.providerAuth = 'codex';
    f.profile.fallbackProfile = 'audit-claude';
    const claude: JobProfile = {
      ...f.profile,
      name: 'audit-claude',
      providerAuth: 'claude',
      fallbackProfile: 'audit-agy',
    };
    const agy: JobProfile = {
      ...f.profile,
      name: 'audit-agy',
      providerAuth: 'agy',
      providerModel: 'gemini-4-argon',
      // A cycle back to the original profile must not re-run it.
      fallbackProfile: f.profile.name,
    };
    const jobs = new RepositoryJobs({
      ...f.jobs.deps,
      profiles: () => [f.profile, claude, agy],
    });
    const original = await jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    const limited = { partial: true, partialReason: 'provider-limit' };
    await settle(f, jobs, original, { runner: 'codex', ...limited });
    const second = (await f.store.readOccurrence(
      f.store.jobs.get(f.id)!.active!,
    ))!;
    expect(second).toMatchObject({
      fallbackOf: original.id,
      fallbackProfiles: [f.profile.name],
      profile: { name: 'audit-claude' },
    });
    await jobs.reconcile(f.store.jobs.get(f.id)!);
    await settle(f, jobs, second, { runner: 'claude', ...limited });
    const third = (await f.store.readOccurrence(
      f.store.jobs.get(f.id)!.active!,
    ))!;
    expect(third).toMatchObject({
      fallbackOf: second.id,
      fallbackProfiles: [f.profile.name, 'audit-claude'],
      profile: {
        name: 'audit-agy',
        providerAuth: 'agy',
        providerModel: 'gemini-4-argon',
      },
    });
    await jobs.reconcile(f.store.jobs.get(f.id)!);
    const runs = await f.native.listRuns({ workId: third.workId });
    expect(runs[0]!.params).toMatchObject({ providerAuth: 'agy' });
    await settle(f, jobs, third, { runner: 'antigravity', ...limited });
    expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
    expect(f.store.occurrences.size).toBe(3);
  });

  it('does not chain a fallback recorded before chaining existed', async () => {
    const f = fixture();
    f.profile.providerAuth = 'codex';
    f.profile.fallbackProfile = 'audit-claude';
    const claude: JobProfile = {
      ...f.profile,
      name: 'audit-claude',
      providerAuth: 'claude',
      fallbackProfile: 'audit-agy',
    };
    const agy: JobProfile = {
      ...f.profile,
      name: 'audit-agy',
      providerAuth: 'agy',
      providerModel: 'gemini-4-argon',
    };
    delete agy.fallbackProfile;
    const jobs = new RepositoryJobs({
      ...f.jobs.deps,
      profiles: () => [f.profile, claude, agy],
    });
    const original = await jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    await settle(f, jobs, original, {
      partial: true,
      partialReason: 'provider-limit',
    });
    const fallback = (await f.store.readOccurrence(
      f.store.jobs.get(f.id)!.active!,
    ))!;
    delete fallback.fallbackProfiles;
    f.store.occurrences.set(fallback.id, fallback);
    await jobs.reconcile(f.store.jobs.get(f.id)!);
    await settle(f, jobs, fallback, {
      partial: true,
      partialReason: 'provider-limit',
    });
    expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
    expect(f.store.occurrences.size).toBe(2);
  });

  it.each([
    [
      'grading error',
      { partial: true, partialReason: 'provider or grading error' },
    ],
    ['failed grades', { partial: false, exit: 1 }],
  ])('does not fall back on %s', async (_name, data) => {
    const f = fixture();
    const jobs = withFallback(f);
    const original = await jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    await settle(f, jobs, original, data);
    expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
    expect(f.store.occurrences.size).toBe(1);
  });

  it.each([
    ['disabled by an operator', { enabled: false, vetoedBy: 'user:joe' }],
    ['source error', { error: 'Source unavailable' }],
    ['stale catalog', { refreshedAt: '2026-10-27T05:00:00.000Z' }],
  ])('does not fall back when the job is %s', async (_name, change) => {
    const f = fixture();
    const jobs = withFallback(f);
    const original = await jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    Object.assign(f.store.jobs.get(f.id)!, change);
    await settle(f, jobs, original, {
      partial: true,
      partialReason: 'provider-limit',
    });
    expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
    expect(f.store.occurrences.size).toBe(1);
  });

  it('settles as an ordinary failure when the fallback profile is not authorized', async () => {
    const f = fixture();
    f.profile.fallbackProfile = 'missing-profile';
    const original = await f.jobs.admit(
      f.id,
      'manual-1',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    await settle(f, f.jobs, original, {
      partial: true,
      partialReason: 'provider-limit',
    });
    expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
    expect(f.store.occurrences.size).toBe(1);
  });

  it('re-admits under the fallback profile when Goose settles the run directly as provider-limit without a result file', async () => {
    const f = fixture();
    const jobs = withFallback(f);
    const original = await jobs.admit(
      f.id,
      'manual-goose-limit',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    const run = (await f.native.listRuns({ workId: original.workId }))[0]!;
    await f.orchestrator.report(run.runId, {
      ok: false,
      summary: 'provider-limit',
      message: 'Goose exited 1: Rate limit exceeded',
    });
    await jobs.reconcile(f.store.jobs.get(f.id)!);
    const job = f.store.jobs.get(f.id)!;
    expect(job.active).toBeDefined();
    expect(job.active).not.toBe(original.id);
    const fallback = (await f.store.readOccurrence(job.active!))!;
    expect(fallback).toMatchObject({
      fallbackOf: original.id,
      profile: { name: 'audit-claude', providerAuth: 'claude' },
    });
  });
});

describe('operational extensions: maxAttempts, manual-only, native harness and apphosting', () => {
  it('retries a maxAttempts=2 job once on worker loss and reconciles the highest generation after all claims retire', async () => {
    const f = fixture();
    f.definition.job.execution.maxAttempts = 2;
    const occurrence = await f.jobs.admit(
      f.id,
      'retry-once',
      'user:joe',
      'manual',
      f.definition.digest,
    );
    const r1 = (await f.native.listRuns({ workId: occurrence.workId }))[0]!;
    await f.native.enqueueRun({
      runId: r1.runId,
      now: '2026-10-27T06:00:00.000Z',
    });
    await f.native.claimQueuedRun({
      pipelines: ['goose'],
      now: '2026-10-27T06:00:00.000Z',
      claimedBy: 'executor',
      claimedBySubject: 'executor@example.iam.gserviceaccount.com',
      tokenHash: '1'.repeat(64),
    });
    // First loss mints r2 automatically; r1 is not yet retired in this simulated lease expiry.
    f.setTime('2026-10-27T08:30:00.000Z');
    const firstSweep = await f.orchestrator.sweepExpired();
    expect(firstSweep.retried).toHaveLength(1);
    const runsAfterFirstLoss = await f.native.listRuns({
      workId: occurrence.workId,
    });
    expect(runsAfterFirstLoss.map((r) => [r.runId, r.state])).toEqual([
      [`work:${occurrence.workId}/r1`, 'lost'],
      [`work:${occurrence.workId}/r2`, 'pending'],
    ]);
    const r2 = runsAfterFirstLoss[1]!;
    await f.native.enqueueRun({
      runId: r2.runId,
      now: '2026-10-27T08:30:00.000Z',
    });
    await f.native.claimQueuedRun({
      pipelines: ['goose'],
      now: '2026-10-27T08:31:00.000Z',
      claimedBy: 'executor',
      claimedBySubject: 'executor@example.iam.gserviceaccount.com',
      tokenHash: '2'.repeat(64),
    });
    const artifact = validateJobResult(f.definition, {
      report: 'Recovered on attempt 2',
      complete: true,
      data: { count: 9 },
    });
    await f.jobs.stage(occurrence, artifact);
    await f.orchestrator.report(
      r2.runId,
      { ok: true, ref: `job-result:${artifact.digest}` },
      '2'.repeat(64),
    );
    await f.orchestrator.executorExited(r2.runId, {
      subject: 'executor@example.iam.gserviceaccount.com',
      runner: 'executor',
      claimFingerprint: '2'.repeat(64),
    });
    // r1 is still unretired (within backstop), so occupancy holds.
    await f.jobs.reconcile(f.store.jobs.get(f.id)!);
    expect(f.store.jobs.get(f.id)!.active).toBe(occurrence.id);
    // Retire r1 and return runs in reverse order to prove generation ordering.
    await f.orchestrator.executorExited(r1.runId, {
      subject: 'executor@example.iam.gserviceaccount.com',
      runner: 'executor',
      claimFingerprint: '1'.repeat(64),
    });
    vi.spyOn(f.native, 'listRuns').mockResolvedValueOnce(
      [...(await f.native.listRuns({ workId: occurrence.workId }))].reverse(),
    );
    await f.jobs.reconcile(f.store.jobs.get(f.id)!);
    expect(f.store.jobs.get(f.id)!.active).toBeUndefined();
    expect(f.store.jobs.get(f.id)!.baseline?.occurrence).toBe(occurrence.id);
    expect((await f.store.readOccurrence(occurrence.id))?.successful).toBe(
      true,
    );
  });

  it('admits unvetoed manual-only jobs without enabling a schedule, while honoring vetoes', async () => {
    const f = fixture([
      {
        key: 'note',
        description: 'Optional note',
        input_type: 'string',
        requirement: 'optional',
        default: 'default-note',
      },
    ]);
    // fixture with parameters omits triggers.schedule (manual-only).
    const job = f.store.jobs.get(f.id)!;
    job.enabled = false;
    job.vetoedBy = null;
    const admitted = await f.jobs.invoke(
      'octo/repo',
      'audit',
      'manual-only-1',
      'user:joe',
    );
    expect(admitted.skipped).toBe(false);
    expect(f.store.jobs.get(f.id)!.active).toBe(admitted.id);

    // An explicit operator disable sets vetoedBy and blocks manual-only invocation.
    const fVeto = fixture([
      {
        key: 'note',
        description: 'Optional note',
        input_type: 'string',
        requirement: 'optional',
        default: 'default-note',
      },
    ]);
    fVeto.store.jobs.get(fVeto.id)!.enabled = false;
    await fVeto.jobs.enable(
      fVeto.id,
      fVeto.definition.digest,
      'user:joe',
      false,
    );
    await expect(
      fVeto.jobs.invoke('octo/repo', 'audit', 'vetoed-1', 'user:joe'),
    ).rejects.toThrow('Job disabled');
  });

  it('mints and reconciles a native harness report-v1 job with full run message and baseline carry-forward', async () => {
    const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
    const definition = parseJobDefinition(
      'jlapenna/homelab',
      'b'.repeat(40),
      'onduty-daily',
      stringify({
        version: 1,
        description: 'Daily Homelab duty report',
        triggers: {
          manual: true,
          schedule: { cron: '0 15 * * *', timezone: 'UTC' },
        },
        execution: {
          harness: 'opencode',
          fallbackHarnesses: ['claude'],
          prompt: './prompt.md',
          profile: 'repository',
          timeout: '60m',
          maxAttempts: 2,
          resources: { requests: { ...allocation }, limits: { ...allocation } },
        },
        inputs: { focus: 'fleet' },
        parameters: [
          {
            key: 'window',
            description: 'Lookback window',
            input_type: 'string',
            requirement: 'optional',
            default: '24h',
          },
        ],
        concurrency: { maxRuns: 1, overlap: 'skip' },
        state: { previousSuccessfulResult: true },
        result: { contract: 'report-v1', requiredArtifacts: ['report.md'] },
      }),
      'Inspect {{ focus }} over {{ window }}.\nPrior report:\n{{ baseline }}\n',
    );
    const store = new TestStore();
    const native = new MemoryStore();
    let at = new Date('2026-10-27T15:00:00.000Z');
    const orchestrator = new Orchestrator(native, {
      now: () => at.toISOString(),
    });
    const jobs = new RepositoryJobs({
      store,
      profiles: () => [],
      granted: (_principal, _repo, pipeline) =>
        ['goose', 'opencode', 'claude'].includes(pipeline ?? 'goose'),
      automationPrincipal: () => 'svc:job-scheduler',
      now: () => at,
      runtime: {
        store: native,
        orchestrator,
        drain: async () => ({ dispatched: [], reported: [], failed: [] }),
      },
    });
    const id = jobKey('jlapenna/homelab', 'onduty-daily');
    store.jobs.set(id, {
      id,
      repository: 'jlapenna/homelab',
      name: 'onduty-daily',
      definition,
      enabled: true,
      enabledBy: 'svc:job-scheduler',
      activationFloor: '2026-10-26T00:00:00.000Z',
      refreshedAt: at.toISOString(),
    });
    const first = await jobs.admit(
      id,
      '2026-10-27T15:00:00.000Z',
      'svc:job-scheduler',
      'schedule',
      definition.digest,
    );
    const task = (await native.readTask({ workId: first.workId }))!.task;
    const spec = workSpecSchema.parse(task.work['spec']);
    expect(spec.pipeline).toBe('opencode');
    expect(spec.deliverable).toBe('report');
    expect(spec.fallbackPipelines).toEqual(['claude']);
    expect(spec.description).toContain('Inspect fleet over 24h.');
    expect(spec.description).toContain('Prior report:\nnone');

    const run = (await native.listRuns({ workId: first.workId }))[0]!;
    expect(run.params).toMatchObject({
      mode: 'implement',
      jobOccurrence: first.id,
      maxAttempts: '2',
    });
    const largeReport = `# Daily Duty\n\n${'Healthy host check.\n'.repeat(2000)}`;
    await orchestrator.report(
      run.runId,
      await externalizeRunMessage(native, run.runId, {
        ok: true,
        summary: 'report',
        message: largeReport,
      }),
    );
    await jobs.reconcile(store.jobs.get(id)!);
    expect(store.jobs.get(id)!.baseline?.occurrence).toBe(first.id);
    const settledFirst = (await store.readOccurrence(first.id))!;
    expect(settledFirst.successful).toBe(true);
    expect(settledFirst.artifact?.artifacts['report.md']).toBe(largeReport);

    at = new Date('2026-10-28T15:00:00.000Z');
    store.jobs.get(id)!.refreshedAt = at.toISOString();
    const second = await jobs.admit(
      id,
      '2026-10-28T15:00:00.000Z',
      'svc:job-scheduler',
      'schedule',
      definition.digest,
    );
    expect(second.baselineOccurrence).toBe(first.id);
    const secondTask = (await native.readTask({ workId: second.workId }))!.task;
    expect(workSpecSchema.parse(secondTask.work['spec']).description).toContain(
      '# Daily Duty',
    );

    // A parked report-v1 run must settle unsuccessful and preserve the prior baseline.
    const secondRun = (await native.listRuns({ workId: second.workId }))[0]!;
    await orchestrator.report(secondRun.runId, {
      ok: true,
      summary: 'park',
      message: 'Blocked waiting on operator input',
    });
    await jobs.reconcile(store.jobs.get(id)!);
    expect((await store.readOccurrence(second.id))?.successful).toBe(false);
    expect(store.jobs.get(id)!.baseline?.occurrence).toBe(first.id);
  });

  it('reconciles canceled or failed-correction deliverable-v1 harness jobs as unsuccessful and fits near-limit prompts', async () => {
    const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
    const definition = parseJobDefinition(
      'jlapenna/agent-lcars',
      'a'.repeat(40),
      'auto-fix',
      stringify({
        version: 1,
        description: 'Deliverable job',
        triggers: { manual: true },
        execution: {
          harness: 'claude',
          prompt: './prompt.md',
          profile: 'repository',
          timeout: '30m',
          maxAttempts: 1,
          resources: {
            requests: { ...allocation },
            limits: { ...allocation },
          },
        },
        inputs: {},
        concurrency: { maxRuns: 1, overlap: 'skip' },
        state: { previousSuccessfulResult: true },
        result: {
          contract: 'deliverable-v1',
          requiredArtifacts: ['report.md'],
        },
      }),
      'Fix drift. Prior: {{ baseline }}',
    );
    const store = new TestStore();
    const native = new MemoryStore();
    const at = new Date('2026-10-27T15:00:00.000Z');
    const orchestrator = new Orchestrator(native, {
      now: () => at.toISOString(),
    });
    const jobs = new RepositoryJobs({
      store,
      profiles: () => [],
      granted: () => true,
      automationPrincipal: () => 'svc:job-scheduler',
      now: () => at,
      runtime: {
        store: native,
        orchestrator,
        drain: async () => ({ dispatched: [], reported: [], failed: [] }),
      },
    });
    const id = jobKey('jlapenna/agent-lcars', 'auto-fix');
    store.jobs.set(id, {
      id,
      repository: 'jlapenna/agent-lcars',
      name: 'auto-fix',
      definition,
      enabled: false,
      refreshedAt: at.toISOString(),
    });

    // 1. Operator cancels while delivery is waiting: active releases, successful=false.
    const canceledOcc = await jobs.admit(
      id,
      'cancel-waiting',
      'user:jlapenna',
      'manual',
      definition.digest,
    );
    const r1 = (await native.listRuns({ workId: canceledOcc.workId }))[0]!;
    await orchestrator.report(r1.runId, {
      ok: true,
      summary: 'pr',
      ref: 'https://github.com/jlapenna/agent-lcars/pull/999',
      message: 'Opened PR',
    });
    await native.transactRun({
      runId: r1.runId,
      decide: ({ task, run }) => ({
        task: {
          ...task!.task,
          delivery: {
            state: 'waiting',
            repo: 'jlapenna/agent-lcars',
            number: 999,
            head: 'b'.repeat(40),
            runId: r1.runId,
            nextCheckAt: at.toISOString(),
          },
        },
        run: run!,
        outbox: [],
      }),
    });
    await jobs.reconcile(store.jobs.get(id)!);
    expect(store.jobs.get(id)!.active).toBe(canceledOcc.id);

    await orchestrator.close({ workId: canceledOcc.workId });
    await jobs.reconcile(store.jobs.get(id)!);
    expect(store.jobs.get(id)!.active).toBeUndefined();
    expect((await store.readOccurrence(canceledOcc.id))?.successful).toBe(
      false,
    );
    expect(store.jobs.get(id)!.baseline).toBeUndefined();

    // 2. Failed delivery correction while delivery.state === 'waiting' releases active as unsuccessful.
    const failedCorrOcc = await jobs.admit(
      id,
      'failed-correction',
      'user:jlapenna',
      'manual',
      definition.digest,
    );
    const cr1 = (await native.listRuns({ workId: failedCorrOcc.workId }))[0]!;
    await orchestrator.report(cr1.runId, {
      ok: true,
      summary: 'pr',
      ref: 'https://github.com/jlapenna/agent-lcars/pull/1000',
      message: 'Opened PR',
    });
    const cr2Outcome = await orchestrator.request({
      taskId: { workId: failedCorrOcc.workId },
      requestId: `${failedCorrOcc.workId}:corr`,
      pipeline: 'claude',
      params: { mode: 'implement', jobOccurrence: failedCorrOcc.id },
    });
    if ('reason' in cr2Outcome) throw new Error(cr2Outcome.reason);
    const cr2 = (await native.listRuns({ workId: failedCorrOcc.workId })).find(
      (candidate) => candidate.runId.endsWith('/r2'),
    )!;
    await native.transactRun({
      runId: cr2.runId,
      decide: ({ task, run }) => ({
        task: {
          ...task!.task,
          delivery: {
            state: 'waiting',
            repo: 'jlapenna/agent-lcars',
            number: 1000,
            head: 'c'.repeat(40),
            runId: cr1.runId,
            correctionRunId: cr2.runId,
            nextCheckAt: at.toISOString(),
          },
        },
        run: run!,
        outbox: [],
      }),
    });
    await orchestrator.report(cr2.runId, {
      ok: false,
      summary: 'verification-failed',
      message: 'CI fix failed',
    });
    await jobs.reconcile(store.jobs.get(id)!);
    expect(store.jobs.get(id)!.active).toBeUndefined();
    expect((await store.readOccurrence(failedCorrOcc.id))?.successful).toBe(
      false,
    );

    // 3. Prompt within 51 bytes of WORK_DESCRIPTION_MAX_BYTES at baseline=null still fits when baseline overflows.
    const headerEstimate =
      'Repository job `near-limit` in `jlapenna/homelab` (pinned definition commit `' +
      'a'.repeat(40) +
      '`, timeout `30m`).\n\n';
    const padLen = 253_952 - Buffer.byteLength(headerEstimate) - 4 - 20;
    const nearLimitDef = parseJobDefinition(
      'jlapenna/homelab',
      'a'.repeat(40),
      'near-limit',
      stringify({
        version: 1,
        description: 'Near-limit prompt',
        triggers: { manual: true },
        execution: {
          harness: 'claude',
          prompt: './prompt.md',
          profile: 'repository',
          timeout: '30m',
          maxAttempts: 1,
          resources: {
            requests: { ...allocation },
            limits: { ...allocation },
          },
        },
        inputs: {},
        concurrency: { maxRuns: 1, overlap: 'skip' },
        state: { previousSuccessfulResult: true },
        result: { contract: 'report-v1', requiredArtifacts: ['report.md'] },
      }),
      `${'x'.repeat(padLen)}{{ baseline }}`,
    );
    const rendered = renderHarnessJobPrompt(
      nearLimitDef,
      {},
      'large-baseline-'.repeat(200),
    );
    expect(rendered.endsWith('none')).toBe(true);

    // 4. deliveryCorrectionAuthorized requires unique work.cron+goose scheduler grant.
    const prevGrants = process.env['AGENT_LCARS_WORK_GRANTS'];
    try {
      const taskSnap = (await native.readTask({
        workId: failedCorrOcc.workId,
      }))!.task;
      const cronTask = {
        ...taskSnap,
        work: {
          ...taskSnap.work,
          origin: { principal: 'svc:job-scheduler', channel: 'api' },
        },
      };
      process.env['AGENT_LCARS_WORK_GRANTS'] = JSON.stringify([
        {
          principal: 'svc:job-scheduler',
          subjects: ['job-scheduler@agent-lcars.iam.gserviceaccount.com'],
          pipelines: ['goose', 'claude'],
          scopes: ['work.cron'],
        },
      ]);
      expect(deliveryCorrectionAuthorized(cronTask, cr2)).toBe(true);

      process.env['AGENT_LCARS_WORK_GRANTS'] = JSON.stringify([
        {
          principal: 'svc:job-scheduler',
          subjects: ['job-scheduler@agent-lcars.iam.gserviceaccount.com'],
          pipelines: ['claude'],
          scopes: ['work.cron'],
        },
      ]);
      expect(deliveryCorrectionAuthorized(cronTask, cr2)).toBe(false);
    } finally {
      if (prevGrants === undefined)
        delete process.env['AGENT_LCARS_WORK_GRANTS'];
      else process.env['AGENT_LCARS_WORK_GRANTS'] = prevGrants;
    }
  });

  it('validates apphosting.yaml work grants and job profiles', () => {
    const apphostingPath = existsSync(join(process.cwd(), 'apphosting.yaml'))
      ? join(process.cwd(), 'apphosting.yaml')
      : join(process.cwd(), 'apps/console/apphosting.yaml');
    const apphosting = parseYaml(readFileSync(apphostingPath, 'utf8')) as {
      env: { variable: string; value?: string }[];
    };
    const grantsRaw = apphosting.env.find(
      (entry) => entry.variable === 'AGENT_LCARS_WORK_GRANTS',
    )?.value;
    const profilesRaw = apphosting.env.find(
      (entry) => entry.variable === 'AGENT_LCARS_JOB_PROFILES',
    )?.value;
    const grants = parseWorkGrants(grantsRaw);
    const scheduler = grants.find((g) => g.principal === 'svc:job-scheduler')!;
    expect(scheduler.pipelines).toEqual(
      expect.arrayContaining(['claude', 'codex', 'opencode', 'agy', 'goose']),
    );
    const memberAutomation = grants.find(
      (g) => g.principal === 'workflow:member-automation',
    )!;
    expect(memberAutomation.pipelines).toContain('goose');
    const profiles = (JSON.parse(profilesRaw!) as unknown[]).map((p) =>
      jobProfileSchema.parse(p),
    );
    expect(profiles.map((p) => p.name)).toEqual(
      expect.arrayContaining(['sprinkles-jobs', 'sync-padd-jobs']),
    );
  });
});
