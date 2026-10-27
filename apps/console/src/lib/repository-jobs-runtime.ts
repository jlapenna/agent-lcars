import 'server-only';

import { logger } from '@agent-lcars/logging';
import { required } from '@agent-lcars/util-server';
import { Firestore } from '@google-cloud/firestore';
import { z } from 'zod';

import { isControlPlaneRepository } from './deployment';
import { createDispatchTokenProvider } from './github-app-tokens';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import { refreshJobCatalog } from './repository-job-catalog';
import { jobProfileSchema } from './repository-job-definition';
import { FirestoreJobStore } from './repository-job-store';
import { RepositoryJobs } from './repository-jobs';
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
        .refine(
          (profiles) =>
            new Set(profiles.map((profile) => profile.image)).size <= 1,
          'Version 1 supports one Goose execution image',
        )
        .parse(JSON.parse(process.env['AGENT_LCARS_JOB_PROFILES'] ?? '[]')),
    granted: (principal, repo) => {
      const grant = grantForPrincipal(principal);
      return (
        isControlPlaneRepository(repo) &&
        Boolean(
          grant?.scopes.includes('work.operator') &&
          grant.pipelines.includes('goose'),
        )
      );
    },
  });
}

export async function maintainRepositoryJobs(
  deadline: number,
  runtime: OrchestratorRouteDeps,
): Promise<void> {
  const jobs = repositoryJobs(runtime);
  const catalog = await jobs.deps.store.list();
  const repositories = [
    ...new Set(
      catalog.filter((job) => job.enabled).map((job) => job.repository),
    ),
  ];
  for (const repository of repositories) {
    if (Date.now() + 21000 > deadline) break;
    try {
      await refreshJobCatalog(
        jobs.deps.store,
        repository,
        createDispatchTokenProvider(process.env, { contents: 'read' }),
        new Date(),
      );
    } catch {
      logger.error('Repository job source refresh failed: %s', repository);
    }
  }
  if (Date.now() < deadline)
    for (const failure of await jobs.tick(deadline))
      logger.error('Repository jobs: %s', failure);
}
