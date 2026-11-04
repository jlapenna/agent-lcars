import { z } from 'zod';

import { createDispatchTokenProvider } from './github-app-tokens';
import { createOrchestratorRuntime } from './orchestrator-runtime';
import { readJobBody } from './repository-job-body';
import { refreshJobCatalog } from './repository-job-catalog';
import {
  jobInputsSchema,
  jobProfileNameSchema,
} from './repository-job-definition';
import { RepositoryJobBusyError, RepositoryJobs } from './repository-jobs';
import { repositoryJobs } from './repository-jobs-runtime';
import type { WorkPrincipal } from './work-auth';
import { scopedWorkGrant } from './work-authorization';

export async function repositoryJobsHttp(
  request: Request,
  principal: WorkPrincipal | undefined,
): Promise<Response> {
  if (
    !principal?.scopes.has('work.operator') ||
    !principal.pipelines.includes('goose')
  )
    return Response.json(
      { error: 'Goose operator grant required' },
      { status: 403 },
    );
  const base = repositoryJobs(createOrchestratorRuntime());
  const jobs = new RepositoryJobs({
    ...base.deps,
    granted: scopedWorkGrant(principal, base.deps.granted),
  });
  const path = new URL(request.url).pathname.slice('/api/work/v1/jobs'.length);
  try {
    if (request.method === 'GET' && path === '')
      return Response.json(
        (await jobs.deps.store.list()).filter((job) =>
          jobs.deps.granted(principal.principal, job.repository),
        ),
      );
    const occurrencePath = /^\/occurrences\/([a-f0-9]{64})$/u.exec(path);
    if (request.method === 'GET' && occurrencePath) {
      const occurrence = await jobs.deps.store.readOccurrence(
        occurrencePath[1]!,
      );
      if (!occurrence)
        return Response.json({ error: 'Not found' }, { status: 404 });
      jobs.authorize(
        occurrence.definition,
        principal.principal,
        occurrence.profile.name,
      );
      return Response.json(occurrence);
    }
    const profilesPath = /^\/([a-f0-9]{64})\/profiles$/u.exec(path);
    if (request.method === 'GET' && profilesPath) {
      const job = (await jobs.deps.store.list()).find(
        (entry) => entry.id === profilesPath[1],
      );
      if (!job?.definition)
        return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json(
        jobs.availableProfiles(job.definition, principal.principal),
      );
    }
    if (request.method !== 'POST')
      return Response.json({ error: 'Not found' }, { status: 404 });
    const text = await readJobBody(request, 16384);
    const body: unknown = JSON.parse(text);
    if (path === '/refresh') {
      const { repository } = z
        .strictObject({ repository: z.string() })
        .parse(body);
      if (!jobs.deps.granted(principal.principal, repository))
        throw new Error('Repository not managed');
      await refreshJobCatalog(
        jobs.deps.store,
        repository,
        createDispatchTokenProvider(process.env, { contents: 'read' }),
        new Date(),
      );
      return Response.json({ refreshed: repository });
    }
    if (path === '/invoke') {
      const input = z
        .strictObject({
          repository: z.string(),
          name: z.string(),
          requestId: z.string(),
          parameters: jobInputsSchema.default({}),
          profile: jobProfileNameSchema.optional(),
        })
        .parse(body);
      const occurrence = await jobs.invoke(
        input.repository,
        input.name,
        input.requestId,
        principal.principal,
        input.parameters,
        input.profile,
      );
      const runs = occurrence.skipped
        ? []
        : await jobs.deps.runtime.store.listRuns({ workId: occurrence.workId });
      return Response.json({
        ...occurrence,
        outcome: occurrence.skipped ? 'busy' : 'accepted',
        ...(runs[0] ? { runId: runs[0].runId } : {}),
      });
    }
    const match = /^\/([a-f0-9]{64})\/(enable|invoke)$/u.exec(path);
    if (!match) return Response.json({ error: 'Not found' }, { status: 404 });
    if (match[2] === 'enable') {
      const input = z
        .strictObject({ digest: z.string(), enabled: z.boolean() })
        .parse(body);
      await jobs.enable(
        match[1]!,
        input.digest,
        principal.principal,
        input.enabled,
      );
      return Response.json({ enabled: input.enabled });
    }
    const input = z
      .strictObject({
        digest: z.string(),
        requestId: z.string(),
        parameters: jobInputsSchema.default({}),
        profile: jobProfileNameSchema.optional(),
      })
      .parse(body);
    return Response.json(
      await jobs.admit(
        match[1]!,
        input.requestId,
        principal.principal,
        'manual',
        input.digest,
        input.parameters,
        false,
        input.profile,
      ),
    );
  } catch (error) {
    if (error instanceof RepositoryJobBusyError)
      return Response.json({ outcome: 'busy' });
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Job operation failed',
      },
      { status: 409 },
    );
  }
}
