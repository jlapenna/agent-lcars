import { parseRunGeneration } from '@agent-lcars/dispatch-contracts';
import {
  deliveryWaiting,
  isLive,
  isRefusal,
  readFullRunMessage,
  type Run,
  RUN_LEASE_MS,
  RUN_PLACEMENT_WAIT_MAX_MS,
} from '@agent-lcars/orchestrator';
import { deriveItemState, slotItemId } from '@agent-lcars/work';

import type { JobSecrets } from './job-secrets';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import {
  authorizeJob,
  isHarnessJobExecution,
  type JobDefinition,
  jobDigest,
  jobDueAt,
  jobKey,
  type JobProfile,
  renderHarnessJobPrompt,
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
  granted: (
    principal: string,
    repository: string,
    pipeline?: string,
  ) => boolean;
  /** The principal automatic activation is attributed to; undefined
   * disables automatic activation. Schedule admission re-checks its grant. */
  automationPrincipal?: () => string | undefined;
  now: () => Date;
  secrets?: Pick<JobSecrets, 'pin' | 'authorize' | 'refused'>;
}
export class RepositoryJobBusyError extends Error {}

/** Results are comparable only under the same inputs, result contract,
 * parameters, provider harness and credentials. */
function occurrenceComparison(
  definition: JobDefinition,
  parameters: Record<string, string>,
  profile: JobProfile,
): string {
  return jobDigest([
    definition.job.inputs,
    definition.job.result,
    parameters,
    ...(isHarnessJobExecution(definition.job.execution)
      ? [definition.job.execution.harness]
      : []),
    ...(profile.providerAuth ? [profile.providerAuth] : []),
    ...(profile.providerModel ? [profile.providerModel] : []),
    ...(profile.credentialSet || profile.gitIdentity
      ? [profile.credentialSet ?? null, profile.gitIdentity ?? null]
      : []),
  ]);
}

/** Fallbacks one provider-limited occurrence may chain through. */
const MAX_FALLBACKS = 2;
/** Structured verdict from either the settled Run (`provider-limit` when Goose
 * itself exhausted provider quota/rate limits) or the evaluator's `result.json`
 * (`partialReason: "provider-limit"`); never inferred from free-text reports. */
function stoppedOnProviderLimit(
  occurrence: JobOccurrence,
  run?: Pick<Run, 'result'>,
): boolean {
  if (run?.result?.ok === false && run.result.summary === 'provider-limit') {
    return true;
  }
  const result = occurrence.artifact?.artifacts['result.json'];
  return (
    typeof result === 'object' &&
    result !== null &&
    'partialReason' in result &&
    result.partialReason === 'provider-limit'
  );
}

export class RepositoryJobs {
  constructor(readonly deps: RepositoryJobsDeps) {}
  authorize(
    definition: JobDefinition,
    principal: string,
    profileName = definition.job.execution.profile,
  ): JobProfile {
    const pipeline = isHarnessJobExecution(definition.job.execution)
      ? definition.job.execution.harness
      : 'goose';
    if (!this.deps.granted(principal, definition.repository, pipeline))
      throw new Error('Goose operator grant required');
    const profile = authorizeJob(
      definition,
      // The reviewed repository definition supplies fixed inputs, while the
      // existing Work grant supplies authority. This built-in lane never grants
      // cross-repository credentials and cannot be overridden by configuration.
      profileName === 'repository'
        ? {
            name: 'repository',
            repositories: [definition.repository],
            principals: [principal],
            allocation: { cpu: 2, memory: '6Gi', storage: '24Gi' },
            inputSets: [definition.job.inputs],
          }
        : this.deps.profiles().find((entry) => entry.name === profileName),
      principal,
      profileName,
    );
    if (
      isHarnessJobExecution(definition.job.execution) &&
      (profile.providerAuth !== undefined ||
        profile.resultFile !== undefined ||
        profile.credentialSet !== undefined)
    )
      throw new Error('Harness jobs cannot use recipe-only profile options');
    return profile;
  }
  /** Whether `principal` may enable `definition` under its own profile. */
  authorizes(definition: JobDefinition, principal: string): boolean {
    try {
      this.authorize(definition, principal);
      return true;
    } catch {
      return false;
    }
  }
  availableProfiles(definition: JobDefinition, principal: string): string[] {
    return [
      ...new Set(['repository', ...this.deps.profiles().map((p) => p.name)]),
    ].filter((name) => {
      try {
        this.authorize(definition, principal, name);
        return true;
      } catch {
        return false;
      }
    });
  }
  /** Activation on merge: the definition activates when its execution profile
   * admits the automation principal exactly as it would an enabling operator. */
  automaticActivation(definition: JobDefinition): string | undefined {
    const principal = this.deps.automationPrincipal?.();
    if (principal === undefined) return undefined;
    try {
      this.authorize(definition, principal);
      return principal;
    } catch {
      return undefined;
    }
  }
  authorizeOccurrence(occurrence: JobOccurrence): JobProfile {
    const profile = this.authorize(
      occurrence.definition,
      occurrence.principal,
      occurrence.profile.name,
    );
    if (jobDigest(profile) !== jobDigest(occurrence.profile))
      throw new Error('Reserved execution profile changed');
    return profile;
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
        // An explicit disable is the operator's per-job veto: it survives
        // definition changes until an explicit enable clears it.
        return { job: { ...job, enabled: false, vetoedBy: principal } };
      }
      if (!job?.definition || job.error || job.definition.digest !== digest)
        throw new Error('Refresh and review the current definition');
      this.authorize(job.definition, principal);
      return {
        job: {
          ...job,
          enabled,
          enabledBy: principal,
          activationFloor: at,
          vetoedBy: null,
        },
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
    profileName?: string,
  ): Promise<JobOccurrence> {
    if (trigger === 'schedule' && profileName !== undefined)
      throw new Error('Scheduled runs use the manifest profile');
    const requestDigestFor = (parameters: Record<string, string>) =>
      jobDigest([
        digest,
        trigger,
        parameters,
        ...(profileName === undefined ? [] : [profileName]),
      ]);
    if (!/^[\w:.-]{1,128}$/u.test(requestId))
      throw new Error('Invalid request ID');
    const at = this.deps.now();
    const occurrenceId = jobDigest([id, principal, trigger, requestId]);
    // Stable even across a crash between the reservation and Work mint.
    const workId = await slotItemId(occurrenceId, at);

    const reserved = await this.deps.store.mutate(
      id,
      occurrenceId,
      async (job, existing) => {
        if (existing) {
          this.authorize(existing.definition, principal, existing.profile.name);
          const parameters = resolveJobParameters(existing.definition, values);
          if (existing.requestDigest !== requestDigestFor(parameters))
            throw new Error(
              'Request ID reused with different definition, parameters or profile',
            );
          return { occurrence: existing };
        }
        if (!job?.definition) throw new Error('Job not found');
        const profile = this.authorize(job.definition, principal, profileName);
        const parameters = resolveJobParameters(job.definition, values);
        if (isHarnessJobExecution(job.definition.job.execution)) {
          renderHarnessJobPrompt(job.definition, parameters, null);
        }
        const requestDigest = requestDigestFor(parameters);
        const manualOnlyReady =
          trigger === 'manual' &&
          !job.definition.job.triggers.schedule &&
          !job.vetoedBy;
        if (
          (!job.enabled && !manualOnlyReady) ||
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
        const comparison = occurrenceComparison(
          job.definition,
          parameters,
          profile,
        );
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
        if (profile.credentialSet && !occurrence.skipped) {
          try {
            if (!this.deps.secrets)
              throw new Error('Secret store not configured');
            // Metadata-only preparation may repeat on a transaction retry. It
            // commits with the occurrence, so denial cannot strand job.active.
            occurrence.secretSnapshot = await this.deps.secrets.pin(occurrence);
          } catch {
            await this.deps.secrets?.refused(occurrence, 'admission');
            throw new Error('Job credential admission refused or unavailable');
          }
        }
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
    return (await this.deps.store.readOccurrence(occurrence.id)) ?? occurrence;
  }
  async invoke(
    repository: string,
    name: string,
    requestId: string,
    principal: string,
    values: Record<string, string> = {},
    profileName?: string,
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
      profileName,
    );
  }
  async mint(occurrence: JobOccurrence): Promise<void> {
    const existing = await this.deps.runtime.store.readTask({
      workId: occurrence.workId,
    });
    if (existing) return;
    if (occurrence.profile.credentialSet && !occurrence.secretSnapshot)
      throw new Error('Credential snapshot missing');
    // Authorization may be revoked after reservation. Keep it durable and
    // visible; do not launch until the current grant permits it again.
    const profile = this.authorizeOccurrence(occurrence);
    const execution = occurrence.definition.job.execution;
    if (isHarnessJobExecution(execution)) {
      const previous =
        occurrence.baselineOccurrence === undefined
          ? undefined
          : await this.deps.store.readOccurrence(occurrence.baselineOccurrence);
      const description = renderHarnessJobPrompt(
        occurrence.definition,
        occurrence.parameters,
        previous?.artifact?.baseline ?? null,
      );
      const allowedPipelines = execution.fallbackHarnesses?.filter(
        (candidate) =>
          candidate !== execution.harness &&
          this.deps.granted(
            occurrence.principal,
            occurrence.definition.repository,
            candidate,
          ),
      );
      const result = await this.deps.runtime.orchestrator.request({
        taskId: { workId: occurrence.workId },
        requestId: occurrence.id,
        pipeline: execution.harness,
        priority: 'background',
        ...(allowedPipelines && allowedPipelines.length > 0
          ? {
              providerFallback: {
                principal: occurrence.principal,
                allowedPipelines,
              },
            }
          : {}),
        params: {
          mode: 'implement',
          jobOccurrence: occurrence.id,
          maxAttempts: String(execution.maxAttempts),
          timeoutMinutes: String(parseInt(execution.timeout, 10)),
          ...(profile.crossRepo === true ? { crossRepo: 'true' } : {}),
        },
        work: {
          origin: {
            principal: occurrence.principal,
            channel: occurrence.trigger === 'schedule' ? 'cron' : 'api',
          },
          spec: {
            title: `${occurrence.definition.name} · ${occurrence.definition.repository}`,
            description,
            pipeline: execution.harness,
            priority: 'background',
            ...(execution.fallbackHarnesses?.length
              ? { fallbackPipelines: execution.fallbackHarnesses }
              : {}),
            ...(occurrence.definition.job.result.contract === 'report-v1'
              ? { deliverable: 'report' }
              : {}),
            target: { repo: occurrence.definition.repository },
          },
        },
      });
      if (isRefusal(result) && result.reason !== 'duplicate-request')
        throw new Error(`Work admission: ${result.reason}`);
      await this.deps.runtime.drain();
      return;
    }
    const result = await this.deps.runtime.orchestrator.request({
      taskId: { workId: occurrence.workId },
      requestId: occurrence.id,
      pipeline: 'goose',
      priority: 'background',
      params: {
        mode: 'recipe',
        jobOccurrence: occurrence.id,
        maxAttempts: String(execution.maxAttempts),
        ...(profile.providerAuth ? { providerAuth: profile.providerAuth } : {}),
        ...(profile.crossRepo === true ? { crossRepo: 'true' } : {}),
      },
      work: {
        origin: {
          principal: occurrence.principal,
          channel: occurrence.trigger === 'schedule' ? 'cron' : 'api',
        },
        spec: {
          title: `${occurrence.definition.name} · ${occurrence.definition.repository}`,
          // The occurrence pins the definition and its description, which
          // may be longer than a Work description; reference it instead.
          description: `Repository job occurrence ${occurrence.id}. Its pinned definition, parameters and results are at /api/work/v1/jobs/occurrences/${occurrence.id}.`,
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
    const storedTask = await this.deps.runtime.store.readTask({
      workId: occurrence.workId,
    });
    const runs = [
      ...(await this.deps.runtime.store.listRuns({
        workId: occurrence.workId,
      })),
    ].sort(
      (left, right) =>
        (parseRunGeneration(left.runId) ?? 0) -
        (parseRunGeneration(right.runId) ?? 0),
    );
    if (runs.length === 0 || runs.some((candidate) => isLive(candidate.state)))
      return;
    if (
      storedTask &&
      storedTask.task.closedAt === undefined &&
      deliveryWaiting(storedTask.task) &&
      deriveItemState(storedTask.task, runs) === 'running'
    )
      return;
    // Native terminal state alone is not evidence a worker has stopped:
    // every claimed attempt waits for its executor's exit report to retire it,
    // including an earlier lost attempt replaced by a maxAttempts=2 retry.
    // When that report can never arrive (an executor restart lost track of a
    // deleted Job, or a Job was never created), the backstop still holds: a
    // worker placed after settlement cannot fetch its recipe (run-token
    // routes refuse a settled run), and one started before settlement ends
    // within its Pod runtime limit, which never exceeds the run lease.
    const nowMs = this.deps.now().getTime();
    if (
      runs.some(
        (candidate) =>
          candidate.queue?.claimedAt &&
          candidate.queue.state !== 'retired' &&
          nowMs - Date.parse(candidate.updatedAt) < RETIREMENT_BACKSTOP_MS,
      )
    )
      return;
    const run = runs.at(-1)!;
    const isHarness = isHarnessJobExecution(
      occurrence.definition.job.execution,
    );
    let harnessArtifact: JobArtifact | undefined;
    if (isHarness) {
      const message = await readFullRunMessage(this.deps.runtime.store, run);
      const taskOpen =
        storedTask !== undefined && storedTask.task.closedAt === undefined;
      const deliverySatisfied =
        storedTask?.task.delivery === undefined ||
        storedTask.task.delivery.state === 'complete';
      const harnessSuccess =
        taskOpen &&
        (occurrence.definition.job.result.contract === 'report-v1'
          ? run.state === 'finished' &&
            run.result?.ok === true &&
            run.result.summary === 'report' &&
            Boolean(message?.trim())
          : deliverySatisfied &&
            run.state === 'finished' &&
            run.result?.ok === true &&
            run.result.summary !== 'park');
      const reportText = message?.trim()
        ? message
        : run.result?.ref
          ? `${run.result.summary ?? 'completed'}: ${run.result.ref}`
          : (run.result?.summary ?? run.state);
      const artifacts = {
        'report.md': reportText,
        ...(run.result?.ref ? { ref: run.result.ref } : {}),
      };
      harnessArtifact = {
        digest: jobDigest([harnessSuccess, artifacts]),
        successful: harnessSuccess,
        artifacts,
        baseline: reportText,
      };
    }
    const fallback = await this.reserveFallback(job, occurrence, run);
    await this.deps.store.mutate(job.id, occurrence.id, (current, saved) => {
      if (!current || !saved || current.active !== occurrence.id) return {};
      const { active: _active, ...rest } = current;
      const artifact = saved.artifact ?? harnessArtifact;
      const success = isHarness
        ? Boolean(artifact?.successful)
        : run.state === 'finished' &&
          run.result?.ok &&
          artifact?.successful &&
          run.result.ref === `job-result:${artifact.digest}`;
      if (!success && fallback) {
        // Settle this occurrence and hand the job to its already-reserved
        // fallback in one write, so no tick can admit another slot between.
        return {
          job: { ...rest, active: fallback, latest: fallback },
          occurrence: {
            ...saved,
            ...(artifact ? { artifact } : {}),
            successful: false,
            reconciledAt: this.deps.now().toISOString(),
          },
        };
      }
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
          ...(artifact ? { artifact } : {}),
          successful: Boolean(success),
          reconciledAt: this.deps.now().toISOString(),
        },
      };
    });
  }
  /** Reserve (idempotently) the re-run of a provider-limited occurrence
   * under its profile's fallbackProfile. Returns the fallback occurrence id,
   * or undefined when none applies or the fallback cannot be admitted (the
   * original then settles as an ordinary failure). */
  async reserveFallback(
    job: CatalogJob,
    occurrence: JobOccurrence,
    run?: Pick<Run, 'result'>,
  ): Promise<string | undefined> {
    const fallbackProfile = occurrence.profile.fallbackProfile;
    // Profiles this chain has already run under, including this attempt.
    const tried =
      occurrence.fallbackOf === undefined
        ? [occurrence.profile.name]
        : occurrence.fallbackProfiles && [
            ...occurrence.fallbackProfiles,
            occurrence.profile.name,
          ];
    if (
      !fallbackProfile ||
      !tried ||
      tried.length > MAX_FALLBACKS ||
      tried.includes(fallbackProfile) ||
      occurrence.artifact?.successful ||
      !stoppedOnProviderLimit(occurrence, run)
    )
      return undefined;
    const id = jobDigest([occurrence.id, 'fallback', fallbackProfile]);
    try {
      const reserved = await this.deps.store.mutate(
        job.id,
        id,
        async (current, existing) => {
          if (existing) return { occurrence: existing };
          if (!current || current.active !== occurrence.id) return {};
          // Same gates as admission: an operator disable/veto, a source error,
          // a changed definition or a stale catalog stops the fallback, and
          // the original then settles as an ordinary failure.
          const manualOnlyReady =
            occurrence.trigger === 'manual' &&
            !occurrence.definition.job.triggers.schedule &&
            !current.vetoedBy;
          if (
            (!current.enabled && !manualOnlyReady) ||
            current.error ||
            current.definition?.digest !== occurrence.definition.digest ||
            this.deps.now().getTime() - Date.parse(current.refreshedAt) > 600000
          )
            return {};
          const profile = this.authorize(
            occurrence.definition,
            occurrence.principal,
            fallbackProfile,
          );
          const comparison = occurrenceComparison(
            occurrence.definition,
            occurrence.parameters,
            profile,
          );
          const fallback: JobOccurrence = {
            id,
            jobId: occurrence.jobId,
            workId: await slotItemId(id, this.deps.now()),
            requestDigest: jobDigest([occurrence.requestDigest, id]),
            principal: occurrence.principal,
            trigger: occurrence.trigger,
            fallbackOf: occurrence.id,
            fallbackProfiles: tried,
            createdAt: this.deps.now().toISOString(),
            skipped: false,
            definition: occurrence.definition,
            profile,
            comparison,
            parameters: occurrence.parameters,
            ...(occurrence.definition.job.state.previousSuccessfulResult &&
            current.baseline?.comparison === comparison
              ? { baselineOccurrence: current.baseline.occurrence }
              : {}),
          };
          if (profile.credentialSet) {
            if (!this.deps.secrets)
              throw new Error('Secret store not configured');
            try {
              fallback.secretSnapshot = await this.deps.secrets.pin(fallback);
            } catch (error) {
              await this.deps.secrets.refused(fallback, 'admission');
              throw error;
            }
          }
          return { occurrence: fallback };
        },
      );
      return reserved.occurrence?.id;
    } catch {
      return undefined;
    }
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
