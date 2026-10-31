import { MemoryStore, Orchestrator } from '@agent-lcars/orchestrator';
import { workSpecSchema } from '@agent-lcars/work';
import { deriveItemState } from '@agent-lcars/work/derive';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import {
  jobDueAt,
  jobKey,
  type JobProfile,
  jobProfileSchema,
  parseJobDefinition,
  repositoryJobSchema,
} from './repository-job-definition';
import { validateJobResult } from './repository-job-result';
import {
  type CatalogJob,
  type JobOccurrence,
  type JobStore,
} from './repository-job-store';
import { RepositoryJobs } from './repository-jobs';

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
  async mutate(
    id: string,
    occurrenceId: string | undefined,
    change: Parameters<JobStore['mutate']>[2],
  ) {
    const result = change(
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
) {
  let at = new Date('2026-10-27T06:00:00.000Z');
  const allocation = { cpu: 2, memory: '6Gi', storage: '24Gi' };
  const definition = parseJobDefinition(
    'octo/repo',
    'a'.repeat(40),
    'audit',
    stringify({
      version: 1,
      description: 'Audit inventory',
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
        profile: 'audit',
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
  it('holds overlap until the executor reports the worker exited', async () => {
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
  });
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
    f.definition.job.triggers.schedule = {
      cron: '0 2 * * *',
      timezone: 'America/Los_Angeles',
    };
    expect(jobDueAt(f.definition, new Date('2026-03-08T10:00:00Z'))).toBe(
      false,
    );
  });
  it('keeps fortnightly intervals across month, year and DST boundaries', () => {
    const f = fixture();
    f.definition.job.triggers.schedule = {
      intervalDays: 14,
      startsAt: '2026-10-26T14:00:00Z',
    };
    for (const date of [
      '2026-10-26T14:00:00Z',
      '2026-11-09T14:00:00Z',
      '2026-12-21T14:00:00Z',
      '2027-01-04T14:00:00Z',
      '2027-03-15T14:00:00Z',
    ]) {
      expect(jobDueAt(f.definition, new Date(date))).toBe(true);
    }
    for (const date of [
      '2026-10-12T14:00:00Z',
      '2026-11-02T14:00:00Z',
      '2026-11-09T13:59:00Z',
      '2026-11-09T14:01:00Z',
      '2027-01-01T14:00:00Z',
    ]) {
      expect(jobDueAt(f.definition, new Date(date))).toBe(false);
    }
  });
  it('admits an interval once within the tick window and skips the intervening week', async () => {
    const f = fixture();
    const schedule = { intervalDays: 14, startsAt: '2026-11-02T14:00:00Z' };
    f.definition.job.triggers.schedule = schedule;
    const catalog = f.store.jobs.get(f.id)!;
    catalog.definition = f.definition;
    catalog.refreshedAt = '2026-11-02T14:03:00Z';
    f.setTime('2026-11-02T14:03:00Z');
    expect(await f.jobs.tick()).toEqual([]);
    expect(await f.jobs.tick()).toEqual([]);
    expect(f.store.occurrences.size).toBe(1);
    const occurrence = [...f.store.occurrences.values()][0]!;
    expect(occurrence.trigger).toBe('schedule');
    expect(occurrence.definition.job.triggers.schedule).toEqual(schedule);
    f.setTime('2026-11-09T14:00:00Z');
    f.store.jobs.get(f.id)!.refreshedAt = '2026-11-09T14:00:00Z';
    expect(await f.jobs.tick()).toEqual([]);
    expect(f.store.occurrences.size).toBe(1);
  });
  it.each([
    { intervalDays: 0, startsAt: '2026-11-02T14:00:00Z' },
    { intervalDays: 1.5, startsAt: '2026-11-02T14:00:00Z' },
    { intervalDays: 14, startsAt: 'not-a-date' },
    { intervalDays: 14, startsAt: '2026-11-02T14:00:01Z' },
    {
      intervalDays: 14,
      startsAt: '2026-11-02T14:00:00Z',
      cron: '0 14 * * 1',
      timezone: 'UTC',
    },
  ])('rejects an invalid interval schedule: %j', (schedule) => {
    const f = fixture();
    expect(
      repositoryJobSchema.safeParse({
        ...f.definition.job,
        triggers: { manual: true, schedule },
      }).success,
    ).toBe(false);
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

it('bounds recipe timeouts below the executor Pod deadline', () => {
  const timeout = repositoryJobSchema.shape.execution.shape.timeout;
  expect(timeout.safeParse('45m').success).toBe(true);
  expect(timeout.safeParse('46m').success).toBe(false);
});
