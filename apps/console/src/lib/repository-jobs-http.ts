import { z } from 'zod';

import { controlPlaneRepositories } from './deployment';
import { createDispatchTokenProvider } from './github-app-tokens';
import { createOrchestratorRuntime } from './orchestrator-runtime';
import { readJobBody } from './repository-job-body';
import { refreshJobCatalog } from './repository-job-catalog';
import { repositoryJobs } from './repository-jobs-runtime';
import type { WorkPrincipal } from './work-auth';

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
  // Cookie-authenticated writes must come from this console origin.
  if (
    request.method !== 'GET' &&
    principal.via === 'session' &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return Response.json(
      { error: 'Same-origin request required' },
      { status: 403 },
    );
  const jobs = repositoryJobs(createOrchestratorRuntime());
  const path = new URL(request.url).pathname.slice('/api/work/v1/jobs'.length);
  try {
    if (request.method === 'GET' && path === '')
      return Response.json(await jobs.deps.store.list());
    const occurrencePath = /^\/occurrences\/([a-f0-9]{64})$/u.exec(path);
    if (request.method === 'GET' && occurrencePath) {
      const occurrence = await jobs.deps.store.readOccurrence(
        occurrencePath[1]!,
      );
      if (!occurrence)
        return Response.json({ error: 'Not found' }, { status: 404 });
      jobs.authorize(occurrence.definition, principal.principal);
      return Response.json(occurrence);
    }
    if (request.method !== 'POST')
      return Response.json({ error: 'Not found' }, { status: 404 });
    const text = await readJobBody(request, 4096);
    const body: unknown = JSON.parse(text);
    if (path === '/refresh') {
      const { repository } = z
        .strictObject({ repository: z.string() })
        .parse(body);
      if (!controlPlaneRepositories().includes(repository))
        throw new Error('Repository not managed');
      await refreshJobCatalog(
        jobs.deps.store,
        repository,
        createDispatchTokenProvider(process.env, { contents: 'read' }),
        new Date(),
      );
      return Response.json({ refreshed: repository });
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
      .strictObject({ digest: z.string(), requestId: z.string() })
      .parse(body);
    return Response.json(
      await jobs.admit(
        match[1]!,
        input.requestId,
        principal.principal,
        'manual',
        input.digest,
      ),
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Job operation failed',
      },
      { status: 409 },
    );
  }
}
