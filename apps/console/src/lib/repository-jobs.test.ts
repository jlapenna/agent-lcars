import {
  MemoryStore,
  Orchestrator,
  retiredKey,
} from '@agent-lcars/orchestrator';
import { workSpecSchema } from '@agent-lcars/work';
import { deriveItemState } from '@agent-lcars/work/derive';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import {
  jobDueAt,
  jobKey,
  type JobProfile,
  parseJobDefinition,
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
function fixture() {
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
        schedule: { cron: '0 1 * * *', timezone: 'America/Los_Angeles' },
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
      parameters: ['scope', 'mode', 'baseline'].map((key) => ({
        key,
        description: key,
        input_type: 'string',
        requirement: 'required',
      })),
    }),
  );
  const profile: JobProfile = {
    name: 'audit',
    allocation,
    repositories: ['octo/repo'],
    principals: ['user:joe'],
    inputSets: [{ scope: 'inventory', mode: 'report' }],
    image: `example/worker@sha256:${'b'.repeat(64)}`,
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
  it('holds overlap until retirement is physically released', async () => {
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
      tokenHash: 'a'.repeat(64),
    });
    await f.orchestrator.report(run.runId, { ok: false }, 'a'.repeat(64));
    const retire = async (released: boolean) =>
      f.native.transactCapacity({
        now: at,
        recordKeys: [retiredKey(run.runId)],
        decide: (snapshot) => {
          snapshot.records.set(retiredKey(run.runId), {
            kind: 'retired',
            runId: run.runId,
            poolId: 'pool',
            nonce: 'nonce-01234567890123456789',
            jobName: 'job',
            pendingWrites: [],
            released,
          });
          return {
            value: true,
            state: snapshot.state,
            records: snapshot.records,
          };
        },
      });
    await retire(false);
    await f.jobs.reconcile(f.store.jobs.get(f.id)!);
    expect(f.store.jobs.get(f.id)!.active).toBe(occurrence.id);
    await retire(true);
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
