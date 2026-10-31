import {
  isLive,
  isRefusal,
  RUN_LEASE_MS,
  RUN_PLACEMENT_WAIT_MAX_MS,
} from '@agent-lcars/orchestrator';
import { slotItemId } from '@agent-lcars/work';

import type { OrchestratorRouteDeps } from './orchestrator-routes';
import {
  authorizeJob,
  type JobDefinition,
  jobDigest,
  jobDueAt,
  jobKey,
  type JobProfile,
  resolveJobParameters,
} from './repository-job-definition';
import type {
  CatalogJob,
  JobArtifact,
  JobOccurrence,
  JobStore,
} from './repository-job-store';

/** Executor Pod runtime limits (2h, 50m for recipes) never exceed the run
 * lease; the placement allowance keeps the bound conservative. */
const RETIREMENT_BACKSTOP_MS = RUN_PLACEMENT_WAIT_MAX_MS + RUN_LEASE_MS;

export interface RepositoryJobsDeps {
  store: JobStore;
  runtime: OrchestratorRouteDeps;
  profiles: () => JobProfile[];
  granted: (principal: string, repository: string) => boolean;
  now: () => Date;
}
export class RepositoryJobBusyError extends Error {}

export class RepositoryJobs {
  constructor(readonly deps: RepositoryJobsDeps) {}
  authorize(definition: JobDefinition, principal: string): JobProfile {
    if (!this.deps.granted(principal, definition.repository))
      throw new Error('Goose operator grant required');
    return authorizeJob(
      definition,
      // The reviewed repository definition supplies fixed inputs, while the
      // existing Work grant supplies authority. This built-in lane never grants
      // cross-repository credentials and cannot be overridden by configuration.
      definition.job.execution.profile === 'repository'
        ? {
            name: 'repository',
            repositories: [definition.repository],
            principals: [principal],
            allocation: { cpu: 2, memory: '6Gi', storage: '24Gi' },
            inputSets: [definition.job.inputs],
          }
        : this.deps
            .profiles()
            .find(
              (profile) => profile.name === definition.job.execution.profile,
            ),
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
    values: Record<string, string> = {},
    deferOverlap = false,
  ): Promise<JobOccurrence> {
    if (!/^[\w:.-]{1,128}$/u.test(requestId))
      throw new Error('Invalid request ID');
    const at = this.deps.now();
    const occurrenceId = jobDigest([id, principal, trigger, requestId]);
    // Stable even across a crash between the reservation and Work mint.
    const workId = await slotItemId(occurrenceId, at);

    const reserved = await this.deps.store.mutate(
      id,
      occurrenceId,
      (job, existing) => {
        if (existing) {
          this.authorize(existing.definition, principal);
          const parameters = resolveJobParameters(existing.definition, values);
          if (
            existing.requestDigest !== jobDigest([digest, trigger, parameters])
          )
            throw new Error(
              'Request ID reused with different definition or parameters',
            );
          return { occurrence: existing };
        }
        if (!job?.definition) throw new Error('Job not found');
        const profile = this.authorize(job.definition, principal);
        const parameters = resolveJobParameters(job.definition, values);
        const requestDigest = jobDigest([digest, trigger, parameters]);
        if (
          !job.enabled ||
          job.error ||
          job.definition.digest !== digest ||
          at.getTime() - Date.parse(job.refreshedAt) > 600000
        )
          throw new Error('Job disabled, changed, or catalog refresh required');
        if (trigger === 'manual' && !job.definition.job.triggers.manual)
          throw new Error('Manual invocation disabled');
        if (deferOverlap && job.active !== undefined)
          throw new RepositoryJobBusyError('Job already active');
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
          parameters,
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
          parameters,
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
  async invoke(
    repository: string,
    name: string,
    requestId: string,
    principal: string,
    values: Record<string, string> = {},
  ): Promise<JobOccurrence> {
    const id = jobKey(repository, name);
    const existing = await this.deps.store.readOccurrence(
      jobDigest([id, principal, 'manual', requestId]),
    );
    const definition =
      existing?.definition ??
      (await this.deps.store.list()).find((job) => job.id === id)?.definition;
    if (!definition)
      throw new Error('Refresh and enable the repository job first');
    return this.admit(
      id,
      requestId,
      principal,
      'manual',
      definition.digest,
      values,
      true,
    );
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
      params: {
        mode: 'recipe',
        jobOccurrence: occurrence.id,
        ...(profile.crossRepo === true ? { crossRepo: 'true' } : {}),
      },
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
    // Native terminal state alone is not evidence the worker has stopped:
    // a claimed run waits for its executor's exit report to retire it. When
    // that report can never arrive (an executor restart lost track of a
    // deleted Job, or a Job was never created), the backstop still holds: a
    // worker placed after settlement cannot fetch its recipe (run-token
    // routes refuse a settled run), and one started before settlement ends
    // within its Pod runtime limit, which never exceeds the run lease.
    if (
      run.queue?.claimedAt &&
      run.queue.state !== 'retired' &&
      this.deps.now().getTime() - Date.parse(run.updatedAt) <
        RETIREMENT_BACKSTOP_MS
    )
      return;
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
        occurrence: {
          ...saved,
          successful: Boolean(success),
          reconciledAt: this.deps.now().toISOString(),
        },
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
