import { isLive, isRefusal, retiredKey } from '@agent-lcars/orchestrator';
import { slotItemId } from '@agent-lcars/work';

import type { OrchestratorRouteDeps } from './orchestrator-routes';
import {
  authorizeJob,
  type JobDefinition,
  jobDigest,
  jobDueAt,
  type JobProfile,
} from './repository-job-definition';
import type {
  CatalogJob,
  JobArtifact,
  JobOccurrence,
  JobStore,
} from './repository-job-store';

export interface RepositoryJobsDeps {
  store: JobStore;
  runtime: OrchestratorRouteDeps;
  profiles: () => JobProfile[];
  granted: (principal: string, repository: string) => boolean;
  now: () => Date;
}
export class RepositoryJobs {
  constructor(readonly deps: RepositoryJobsDeps) {}
  authorize(definition: JobDefinition, principal: string): JobProfile {
    if (!this.deps.granted(principal, definition.repository))
      throw new Error('Goose operator grant required');
    return authorizeJob(
      definition,
      this.deps
        .profiles()
        .find((profile) => profile.name === definition.job.execution.profile),
      principal,
    );
  }
  async enable(
    id: string,
    digest: string,
    principal: string,
    enabled: boolean,
  ): Promise<void> {
    const at = this.deps.now().toISOString();
    await this.deps.store.mutate(id, undefined, (job) => {
      if (!enabled) {
        if (!job || !this.deps.granted(principal, job.repository))
          throw new Error('Goose operator grant required');
        return { job: { ...job, enabled: false } };
      }
      if (!job?.definition || job.error || job.definition.digest !== digest)
        throw new Error('Refresh and review the current definition');
      this.authorize(job.definition, principal);
      return {
        job: { ...job, enabled, enabledBy: principal, activationFloor: at },
      };
    });
  }
  async admit(
    id: string,
    requestId: string,
    principal: string,
    trigger: 'manual' | 'schedule',
    digest: string,
  ): Promise<JobOccurrence> {
    if (!/^[\w:.-]{1,128}$/u.test(requestId))
      throw new Error('Invalid request ID');
    const at = this.deps.now();
    const occurrenceId = jobDigest([id, principal, trigger, requestId]);
    // Stable even across a crash between the reservation and Work mint.
    const workId = await slotItemId(occurrenceId, at);
    const requestDigest = jobDigest([digest, trigger]);
    const reserved = await this.deps.store.mutate(
      id,
      occurrenceId,
      (job, existing) => {
        if (!job?.definition) throw new Error('Job not found');
        const profile = this.authorize(job.definition, principal);
        if (existing) {
          if (existing.requestDigest !== requestDigest)
            throw new Error('Request ID reused with different definition');
          return { occurrence: existing };
        }
        if (
          !job.enabled ||
          job.error ||
          job.definition.digest !== digest ||
          at.getTime() - Date.parse(job.refreshedAt) > 600000
        )
          throw new Error('Job disabled, changed, or catalog refresh required');
        if (trigger === 'manual' && !job.definition.job.triggers.manual)
          throw new Error('Manual invocation disabled');
        const slot = new Date(requestId);
        if (
          trigger === 'schedule' &&
          (!Number.isFinite(slot.getTime()) ||
            slot.getTime() > at.getTime() ||
            at.getTime() - slot.getTime() > 300000 ||
            !jobDueAt(job.definition, slot) ||
            !job.activationFloor ||
            slot.getTime() <= Date.parse(job.activationFloor))
        )
          throw new Error('Schedule occurrence not eligible');
        const comparison = jobDigest([
          job.definition.job.inputs,
          job.definition.job.result,
        ]);
        const occurrence: JobOccurrence = {
          id: occurrenceId,
          jobId: id,
          workId,
          requestDigest,
          principal,
          trigger,
          createdAt: at.toISOString(),
          skipped: job.active !== undefined,
          definition: job.definition,
          profile,
          comparison,
          ...(job.definition.job.state.previousSuccessfulResult &&
          job.baseline?.comparison === comparison
            ? { baselineOccurrence: job.baseline.occurrence }
            : {}),
        };
        return {
          job: {
            ...job,
            latest: occurrenceId,
            ...(occurrence.skipped ? {} : { active: occurrenceId }),
          },
          occurrence,
        };
      },
    );
    const occurrence = reserved.occurrence;
    if (!occurrence) throw new Error('Admission reservation missing');
    if (!occurrence.skipped) await this.mint(occurrence);
    return occurrence;
  }
  async mint(occurrence: JobOccurrence): Promise<void> {
    const existing = await this.deps.runtime.store.readTask({
      workId: occurrence.workId,
    });
    if (existing) return;
    // Authorization may be revoked after reservation. Keep it durable and
    // visible; do not launch until the current grant permits it again.
    const profile = this.authorize(occurrence.definition, occurrence.principal);
    if (jobDigest(profile) !== jobDigest(occurrence.profile))
      throw new Error('Reserved execution profile changed');
    const result = await this.deps.runtime.orchestrator.request({
      taskId: { workId: occurrence.workId },
      requestId: occurrence.id,
      pipeline: 'goose',
      priority: 'background',
      params: { mode: 'recipe', jobOccurrence: occurrence.id },
      work: {
        origin: {
          principal: occurrence.principal,
          channel: occurrence.trigger === 'schedule' ? 'cron' : 'api',
        },
        spec: {
          title: `${occurrence.definition.name} · ${occurrence.definition.repository}`,
          description: occurrence.definition.job.description,
          pipeline: 'goose',
          priority: 'background',
          target: { repo: occurrence.definition.repository },
          jobOccurrence: occurrence.id,
        },
      },
    });
    if (isRefusal(result) && result.reason !== 'duplicate-request')
      throw new Error(`Work admission: ${result.reason}`);
    await this.deps.runtime.drain();
  }
  async stage(occurrence: JobOccurrence, artifact: JobArtifact): Promise<void> {
    await this.deps.store.mutate(
      occurrence.jobId,
      occurrence.id,
      (job, current) => {
        if (!current || job?.active !== current.id || current.reconciledAt)
          throw new Error('Occurrence no longer active');
        if (current.artifact && current.artifact.digest !== artifact.digest)
          throw new Error('Result already staged with different digest');
        return { occurrence: { ...current, artifact } };
      },
    );
  }
  async reconcile(job: CatalogJob): Promise<void> {
    if (!job.active) return;
    const occurrence = await this.deps.store.readOccurrence(job.active);
    if (!occurrence) throw new Error('Active occurrence missing');
    await this.mint(occurrence);
    const runs = await this.deps.runtime.store.listRuns({
      workId: occurrence.workId,
    });
    if (runs.length !== 1 || isLive(runs[0]!.state)) return;
    const run = runs[0]!;
    // Native terminal state alone is not evidence the worker has stopped.
    if (run.queue?.claimedAt) {
      const retired = await this.deps.runtime.store.transactCapacity({
        now: this.deps.now().toISOString(),
        recordKeys: [retiredKey(run.runId)],
        decide: (snapshot) => {
          const record = snapshot.records.get(retiredKey(run.runId));
          return {
            value: record?.kind === 'retired' && record.released === true,
          };
        },
      });
      if (!retired) return;
    }
    await this.deps.store.mutate(job.id, occurrence.id, (current, saved) => {
      if (!current || !saved || current.active !== occurrence.id) return {};
      const { active: _active, ...rest } = current;
      const success =
        run.state === 'finished' &&
        run.result?.ok &&
        saved.artifact?.successful &&
        run.result.ref === `job-result:${saved.artifact.digest}`;
      return {
        job: {
          ...rest,
          ...(success
            ? {
                baseline: {
                  occurrence: saved.id,
                  comparison: saved.comparison,
                },
              }
            : {}),
        },
        occurrence: { ...saved, reconciledAt: this.deps.now().toISOString() },
      };
    });
  }
  async tick(deadline = Number.POSITIVE_INFINITY): Promise<string[]> {
    const failures: string[] = [];
    const jobs = await this.deps.store.list();
    for (const job of jobs) {
      if (Date.now() >= deadline) break;
      try {
        await this.reconcile(job);
        const now = this.deps.now();
        if (!job.enabled || job.error || !job.definition || !job.enabledBy)
          continue;
        now.setUTCSeconds(0, 0);
        let found = false;
        for (let minute = 0; minute < 5; minute++) {
          if (jobDueAt(job.definition, now)) {
            found = true;
            break;
          }
          now.setUTCMinutes(now.getUTCMinutes() - 1);
        }
        if (!found) continue;
        if (!job.activationFloor || now.toISOString() <= job.activationFloor)
          continue;
        await this.admit(
          job.id,
          now.toISOString(),
          job.enabledBy,
          'schedule',
          job.definition.digest,
        );
      } catch (error) {
        failures.push(
          `${job.repository}:${job.name}: ${error instanceof Error ? error.message : 'maintenance failed'}`,
        );
      }
    }
    return failures;
  }
}
