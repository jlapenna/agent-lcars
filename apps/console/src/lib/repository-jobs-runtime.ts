import 'server-only';

import { logger } from '@agent-lcars/logging';
import { required } from '@agent-lcars/util-server';
import { Firestore } from '@google-cloud/firestore';
import { z } from 'zod';

import { controlPlaneRepositories } from './deployment';
import { createDispatchTokenProvider } from './github-app-tokens';
import { jobSecrets } from './job-secrets-runtime';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import { refreshJobCatalogs } from './repository-job-catalog';
import { jobProfileSchema } from './repository-job-definition';
import { FirestoreJobStore } from './repository-job-store';
import { RepositoryJobs } from './repository-jobs';
import { workForbiddenReason } from './work-authorization';
import { grantForPrincipal, workGrants } from './work-grants';

/** Automatic activation is attributed to the scheduler: the one Work grant
 * holding `work.cron` for the `goose` pipeline, which drives the maintenance
 * tick. Zero or several such grants disable automatic activation. */
export function jobAutomationPrincipal(): string | undefined {
  const scheduler = workGrants().filter(
    (grant) =>
      grant.scopes.includes('work.cron') && grant.pipelines.includes('goose'),
  );
  return scheduler.length === 1 ? scheduler[0]!.principal : undefined;
}

let store: FirestoreJobStore | undefined;
export function repositoryJobs(runtime: OrchestratorRouteDeps): RepositoryJobs {
  store ??= new FirestoreJobStore(
    new Firestore({
      projectId: required('PROJECT_ID'),
      databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
    }),
  );
  return new RepositoryJobs({
    store,
    runtime,
    now: () => new Date(),
    secrets: jobSecrets(),
    profiles: () =>
      z
        .array(jobProfileSchema)
        .max(64)
        .refine(
          (profiles) =>
            new Set(profiles.map((profile) => profile.name)).size ===
            profiles.length,
          'Profile names must be unique',
        )
        .parse(JSON.parse(process.env['AGENT_LCARS_JOB_PROFILES'] ?? '[]')),
    automationPrincipal: jobAutomationPrincipal,
    granted: (principal, repo) => {
      const grant = grantForPrincipal(principal);
      return (
        grant !== undefined &&
        (grant.scopes.includes('work.operator') ||
          principal === jobAutomationPrincipal()) &&
        workForbiddenReason(grant, { pipeline: 'goose', target: { repo } }) ===
          undefined
      );
    },
  });
}

export async function maintainRepositoryJobs(
  deadline: number,
  runtime: OrchestratorRouteDeps,
): Promise<void> {
  const jobs = repositoryJobs(runtime);
  const tick = async () => {
    if (Date.now() < deadline)
      for (const failure of await jobs.tick(deadline))
        logger.error('Repository jobs: %s', failure);
  };
  // Settlement and refresh each start with the full maintenance window. Wait
  // for both even on failure so neither continues after this request returns.
  // Discovery covers every control-plane repository, not only those that
  // already have an enabled job, so a merged definition needs no install step.
  const results = await Promise.allSettled([
    (async () =>
      refreshJobCatalogs(
        jobs.deps.store,
        controlPlaneRepositories(),
        () => createDispatchTokenProvider(process.env, { contents: 'read' }),
        deadline,
        (definition) => jobs.automaticActivation(definition),
        (principal, definition) => jobs.authorizes(definition, principal),
      ))(),
    tick(),
  ]);
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
  // A previously stale catalog may now admit this minute's schedule. The
  // deterministic occurrence ID makes replay of the first tick idempotent.
  await tick();
}
