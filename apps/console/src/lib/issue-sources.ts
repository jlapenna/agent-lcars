import 'server-only';

import { createHash } from 'node:crypto';

import {
  type IssueReference,
  issueSourceKey,
  type TrackerIssue,
  type TrackerIssueProjection,
} from '@agent-lcars/dispatch-contracts';
import {
  type issueLookupSchema,
  storedWorkPayloadSchema,
  type WorkSpec,
} from '@agent-lcars/work';
import { ORPCError } from '@orpc/server';
import { z } from 'zod';

import { controlPlaneRepositories } from './deployment';
import { refreshCurrentGithubAnchorProjection } from './github-anchor-refresh';
import { createDispatchTokenProvider } from './github-app-tokens';
import { admitGithubWork } from './github-work-admission';
import {
  issueFromGithubProjection,
  issueReferenceForTask,
  issueTracker,
  readSourceWorkBinding,
} from './issue-trackers';
import { listLinearIssues, readLinearIssue } from './linear-client';
import {
  linearConfig,
  linearIssueRepository,
  linearIssueRouting,
  linearTeam,
} from './linear-config';
import { dispatchLinearIssue, refreshLinearIssue } from './linear-intake';
import { repositoryForbiddenReason } from './work-authorization';
import { normalizeWorkPayload } from './work-from-github';
import { forbiddenReason, type WorkContext } from './work-mint';
import { requestReply } from './work-reply';

type IssueLookup = z.infer<typeof issueLookupSchema>;
export type IssueSourceView = TrackerIssueProjection & { workId?: string };

function assertRepository(context: WorkContext, repo: string) {
  const reason = repositoryForbiddenReason(context.principal ?? {}, repo);
  if (reason) throw new ORPCError('FORBIDDEN', { message: reason });
}

export async function lookupIssueSource(
  context: WorkContext,
  lookup: IssueLookup,
): Promise<IssueSourceView> {
  let issue: TrackerIssue | undefined;
  let repo: string | undefined;
  if (lookup.tracker === 'github') {
    repo = controlPlaneRepositories().find(
      (candidate) => candidate.toLowerCase() === lookup.repo?.toLowerCase(),
    );
    if (!repo) throw new ORPCError('FORBIDDEN');
    assertRepository(context, repo);
    issue = await issueTracker({
      tokens: createDispatchTokenProvider(process.env),
    }).read({ tracker: 'github', repo, issue: Number(lookup.issue) });
  } else {
    const config = linearConfig();
    if (!config)
      throw new ORPCError('NOT_FOUND', { message: 'Linear is not configured' });
    issue = await readLinearIssue(config.organizationId, lookup.issue);
    const team = issue?.teamId ? linearTeam(config, issue.teamId) : undefined;
    if (!issue || !team)
      throw new ORPCError('NOT_FOUND', {
        message: 'No configured Linear issue',
      });
    repo = linearIssueRepository(config, issue);
  }
  if (!issue) throw new ORPCError('NOT_FOUND');
  const binding =
    issue.reference.tracker === 'linear'
      ? await readSourceWorkBinding(context.runtime.store, issue.reference)
      : undefined;
  const workId = binding?.workId;
  if (binding) {
    const bound = issueReferenceForTask(binding.task);
    if (!bound || issueSourceKey(bound) !== issueSourceKey(issue.reference))
      throw new ORPCError('CONFLICT', {
        message: 'Issue source binding does not match stored Work',
      });
    const stored = storedWorkPayloadSchema.safeParse(binding.task.work);
    if (stored?.success && 'target' in stored.data.spec)
      repo = stored.data.spec.target.repo;
  }
  if (repo) assertRepository(context, repo);
  else if (context.principal?.sourceRepository)
    throw new ORPCError('FORBIDDEN');
  return {
    issue,
    ...(repo ? { repo } : {}),
    observedAt: context.now().toISOString(),
    ...(workId ? { workId } : {}),
  };
}

const cursorSchema = z.discriminatedUnion('tracker', [
  z.object({ tracker: z.literal('linear'), key: z.string().max(512) }),
  z.object({
    tracker: z.literal('github'),
    sourceUpdatedAt: z.iso.datetime(),
    anchor: z.object({ repo: z.string(), issue: z.number().int().positive() }),
  }),
]);
export async function listIssueSources(
  context: WorkContext,
  input: {
    tracker: 'github' | 'linear';
    repo?: string;
    limit: number;
    cursor?: string;
  },
): Promise<{ issues: IssueSourceView[]; nextCursor?: string }> {
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, 'base64url').toString()),
      );
    } catch {
      throw new ORPCError('BAD_REQUEST', { message: 'Invalid issue cursor' });
    }
    if (cursor.tracker !== input.tracker)
      throw new ORPCError('BAD_REQUEST', {
        message: 'Issue cursor belongs to a different tracker',
      });
  }
  const repo = input.repo ?? context.principal?.sourceRepository;
  if (repo) assertRepository(context, repo);
  let sources: TrackerIssueProjection[];
  let nextCursor: string | undefined;
  if (input.tracker === 'github') {
    const page = await context.runtime.store.listOpenGithubAnchorProjectionPage(
      {
        limit: input.limit,
        ...(cursor?.tracker === 'github' ? { cursor } : {}),
      },
    );
    sources = page.projections.map((projection) => ({
      issue: issueFromGithubProjection(projection),
      repo: projection.anchor.repo,
      observedAt: projection.observedAt,
    }));
    if (page.nextCursor)
      nextCursor = Buffer.from(
        JSON.stringify({ tracker: 'github', ...page.nextCursor }),
      ).toString('base64url');
  } else {
    const page = await context.runtime.store.listTrackerIssues({
      limit: input.limit,
      ...(cursor?.tracker === 'linear' ? { cursor: cursor.key } : {}),
    });
    const config = linearConfig();
    sources = config
      ? page.issues
          .filter(
            (source) =>
              source.issue.reference.tracker === 'linear' &&
              source.issue.reference.organizationId === config.organizationId &&
              source.issue.state === 'open' &&
              linearTeam(config, source.issue.teamId ?? '') !== undefined,
          )
          .map((source) => ({
            issue: source.issue,
            observedAt: source.observedAt,
            repo: linearIssueRepository(config, source.issue),
          }))
      : [];
    if (page.nextCursor)
      nextCursor = Buffer.from(
        JSON.stringify({ tracker: 'linear', key: page.nextCursor }),
      ).toString('base64url');
  }
  // A source can move teams/repositories after admission. Authorize the
  // immutable Work target before exposing its binding, not the new projection.
  const bound = await Promise.all(
    sources.map(async (source) => {
      const binding =
        source.issue.reference.tracker === 'linear'
          ? await readSourceWorkBinding(
              context.runtime.store,
              source.issue.reference,
            )
          : undefined;
      if (!binding) return source;
      const { workId } = binding;
      const reference = issueReferenceForTask(binding.task);
      if (
        !reference ||
        issueSourceKey(reference) !== issueSourceKey(source.issue.reference)
      )
        throw new ORPCError('CONFLICT', {
          message: 'Issue source binding does not match stored Work',
        });
      const spec = storedWorkPayloadSchema.parse(binding.task.work).spec;
      return {
        ...source,
        ...(spec && 'target' in spec ? { repo: spec.target.repo } : {}),
        workId,
      };
    }),
  );
  const issues = bound.filter(
    (source) =>
      (!repo || source.repo?.toLowerCase() === repo.toLowerCase()) &&
      (source.repo
        ? repositoryForbiddenReason(context.principal ?? {}, source.repo) ===
          undefined
        : !context.principal?.sourceRepository),
  );
  return { issues, ...(nextCursor ? { nextCursor } : {}) };
}

export async function refreshIssueSources(
  context: WorkContext,
  input: { tracker: 'github' | 'linear'; teamId?: string; cursor?: string },
): Promise<{ refreshed: number; nextCursor?: string }> {
  if (input.tracker === 'github') {
    let cursor:
      | { sourceUpdatedAt: string; anchor: { repo: string; issue: number } }
      | undefined;
    if (input.cursor) {
      try {
        cursor = cursorSchema.options[1]
          .omit({ tracker: true })
          .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString()));
      } catch {
        throw new ORPCError('BAD_REQUEST', {
          message: 'Invalid issue refresh cursor',
        });
      }
    }
    const page = await context.runtime.store.listOpenGithubAnchorProjectionPage(
      { limit: 50, ...(cursor ? { cursor } : {}) },
    );
    for (const projection of page.projections)
      assertRepository(context, projection.anchor.repo);
    await Promise.all(
      page.projections.map((projection) =>
        refreshCurrentGithubAnchorProjection(projection.anchor),
      ),
    );
    return {
      refreshed: page.projections.length,
      ...(page.nextCursor
        ? {
            nextCursor: Buffer.from(JSON.stringify(page.nextCursor)).toString(
              'base64url',
            ),
          }
        : {}),
    };
  }
  const config = linearConfig();
  if (!config) throw new ORPCError('NOT_FOUND');
  const teamIds = [...new Set(config.routes.map((route) => route.teamId))];
  const teamId =
    input.teamId ?? (teamIds.length === 1 ? teamIds[0] : undefined);
  if (!teamId || !teamIds.includes(teamId))
    throw new ORPCError('BAD_REQUEST', {
      message: 'Select one configured Linear team',
    });
  const routes = config.routes.filter((route) => route.teamId === teamId);
  routes.forEach((route) => assertRepository(context, route.repo));
  const page = await listLinearIssues(
    config.organizationId,
    teamId,
    input.cursor,
  );
  for (const issue of page.issues)
    await refreshLinearIssue(context.runtime, config, issue);
  return {
    refreshed: page.issues.length,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function dispatchIssueSource(
  context: WorkContext,
  input: {
    issue: IssueReference;
    repo?: string;
    pipeline: WorkSpec['pipeline'];
    requestId: string;
  },
): Promise<{ runId: string; workId?: string; location: string }> {
  if (!context.principal) throw new ORPCError('UNAUTHORIZED');
  const ref = input.issue;
  const source = await lookupIssueSource(context, {
    tracker: ref.tracker,
    issue: ref.tracker === 'linear' ? ref.issueId : String(ref.issue),
    ...(ref.tracker === 'github' ? { repo: ref.repo } : {}),
  });
  if (issueSourceKey(source.issue.reference) !== issueSourceKey(ref))
    throw new ORPCError('FORBIDDEN', {
      message: 'Issue belongs to a different tracker workspace',
    });
  const repo = input.repo ?? source.repo;
  if (!repo)
    throw new ORPCError('BAD_REQUEST', {
      message: 'Select the issue target repository',
    });
  if (source.workId && source.repo !== repo)
    throw new ORPCError('CONFLICT', {
      message: 'Existing Work has a different target repository',
    });
  const denied = forbiddenReason(context.principal, {
    pipeline: input.pipeline,
    target: { repo },
  });
  if (denied) throw new ORPCError('FORBIDDEN', { message: denied });
  const key = `issue-dispatch:${createHash('sha256')
    .update(
      JSON.stringify([
        context.principal.principal,
        issueSourceKey(ref),
        input.requestId,
      ]),
    )
    .digest('hex')}`;
  const receipt = async (runId: string, location: string, workId?: string) => {
    const run = await context.runtime.store.readRun(runId);
    if (!run || run.pipeline !== input.pipeline)
      throw new ORPCError('CONFLICT', {
        message: 'request-id already used with a different provider',
      });
    return { runId, location, ...(workId ? { workId } : {}) };
  };
  const taskId =
    ref.tracker === 'github'
      ? { repo: ref.repo, issue: ref.issue }
      : source.workId
        ? { workId: source.workId }
        : undefined;
  const replay = taskId
    ? (await context.runtime.store.listRuns(taskId)).find(
        (run) =>
          run.requestSource === 'caller' && run.requestId === `reply:${key}`,
      )
    : undefined;
  if (replay)
    return receipt(
      replay.runId,
      ref.tracker === 'github'
        ? `/task/${repo}/${ref.issue}`
        : `/work/${source.workId}`,
      source.workId,
    );
  if (source.issue.state !== 'open')
    throw new ORPCError('CONFLICT', { message: 'Issue is closed' });
  if (ref.tracker === 'github') {
    const anchor = { repo: ref.repo, issue: ref.issue };
    if (repo !== ref.repo) throw new ORPCError('FORBIDDEN');
    const existing = await context.runtime.store.readTask(anchor);
    const authorization = {
      grantsPrincipal: context.principal,
      sourceRepository: context.principal.sourceRepository,
    };
    if (existing) {
      await context.runtime.orchestrator.refreshIssue(anchor, source.issue);
      const reply = await requestReply(context, {
        task: anchor,
        text: `Dispatch requested from ${source.issue.identifier}.\n\n${source.issue.description}`,
        ref: key,
        pipeline: input.pipeline,
        channel: context.principal.via === 'session' ? 'console' : 'api',
        principal: context.principal.principal,
      });
      if (!reply.ok)
        throw new ORPCError(reply.code, { message: reply.message });
      return receipt(reply.runId, `/task/${repo}/${ref.issue}`);
    }
    const result = await admitGithubWork(context.runtime, {
      anchor,
      requestId: `reply:${key}`,
      params: { mode: 'implement' },
      issue: source.issue,
      authorization,
      work: normalizeWorkPayload({
        origin: { principal: context.principal.principal, channel: 'github' },
        spec: {
          title: source.issue.title,
          description: source.issue.description,
          target: { repo },
          pipeline: input.pipeline,
        },
      }),
    });
    if (
      !['accepted', 'duplicate'].includes(result.kind) ||
      !('runId' in result)
    )
      throw new ORPCError('CONFLICT', {
        message: 'message' in result ? result.message : result.kind,
      });
    return receipt(result.runId, `/task/${repo}/${ref.issue}`);
  }
  const config = linearConfig();
  if (config && linearIssueRouting(config, source.issue).ambiguous)
    throw new ORPCError('CONFLICT', {
      message: 'Conflicting issue repository routes',
    });
  const route = config?.routes.find(
    (candidate) =>
      candidate.teamId === source.issue.teamId &&
      candidate.repo === repo &&
      candidate.pipeline === input.pipeline,
  );
  if (!config || !route)
    throw new ORPCError('FORBIDDEN', {
      message: 'No configured Linear route for this repository and pipeline',
    });
  await refreshLinearIssue(context.runtime, config, source.issue);
  const admission = await dispatchLinearIssue(
    context.runtime,
    config,
    source.issue,
    route,
    { ref: key },
  );
  const workId = admission.body['itemId'];
  if (typeof workId !== 'string')
    throw new ORPCError('CONFLICT', {
      message: String(admission.body['reason'] ?? admission.body['error']),
    });
  if (admission.body['outcome'] !== 'minted') {
    const result = await requestReply(context, {
      task: { workId },
      text: `Dispatch requested from ${source.issue.identifier}.\n\n${source.issue.description}`,
      ref: key,
      pipeline: input.pipeline,
      channel: context.principal.via === 'session' ? 'console' : 'api',
      principal: context.principal.principal,
    });
    if (!result.ok)
      throw new ORPCError(result.code, { message: result.message });
    return receipt(result.runId, `/work/${workId}`, workId);
  }
  await context.runtime.drain();
  const run = (await context.runtime.store.listRuns({ workId })).find(
    (run) => run.requestId === `reply:${key}`,
  );
  if (!run) throw new ORPCError('INTERNAL_SERVER_ERROR');
  return receipt(run.runId, `/work/${workId}`, workId);
}
