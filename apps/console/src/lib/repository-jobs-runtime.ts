import 'server-only';

import { logger } from '@agent-lcars/logging';
import { required } from '@agent-lcars/util-server';
import { Firestore } from '@google-cloud/firestore';
import { z } from 'zod';

import { createDispatchTokenProvider } from './github-app-tokens';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import { refreshEnabledJobCatalogs } from './repository-job-catalog';
import { jobProfileSchema } from './repository-job-definition';
import { FirestoreJobStore } from './repository-job-store';
import { RepositoryJobs } from './repository-jobs';
import { workForbiddenReason } from './work-authorization';
import { grantForPrincipal } from './work-grants';

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
    granted: (principal, repo) => {
      const grant = grantForPrincipal(principal);
      return (
        grant !== undefined &&
        grant.scopes.includes('work.operator') &&
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
  const results = await Promise.allSettled([
    refreshEnabledJobCatalogs(
      jobs.deps.store,
      () => createDispatchTokenProvider(process.env, { contents: 'read' }),
      deadline,
    ),
    tick(),
  ]);
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
  // A previously stale catalog may now admit this minute's schedule. The
  // deterministic occurrence ID makes replay of the first tick idempotent.
  await tick();
}
