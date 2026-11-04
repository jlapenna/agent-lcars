import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  issueSourceKey,
  REPLY_COMMANDS,
  type TrackerIssue,
} from '@agent-lcars/dispatch-contracts';
import { isRefusal } from '@agent-lcars/orchestrator';
import {
  storedWorkPayloadSchema,
  ulid,
  WORK_TITLE_MAX,
} from '@agent-lcars/work';
import { z } from 'zod';

import { readLinearComment, readLinearIssue } from './linear-client';
import {
  type LinearConfig,
  linearIssueRepository,
  linearTeam,
} from './linear-config';
import { matchReplyTrigger } from './reply-trigger';
import { normalizeWorkPayload } from './work-from-github';
import { grantForPrincipal } from './work-grants';
import { mintItem, type WorkContext } from './work-mint';
import { requestReply } from './work-reply';
import { createReplyContext } from './work-reply-context';

export const linearWebhookEnvelopeSchema = z.object({
  type: z.string(),
  action: z.string(),
  organizationId: z.uuid(),
  webhookTimestamp: z.number().int(),
  createdAt: z.iso.datetime().optional(),
  actor: z.object({ id: z.uuid(), type: z.string() }).nullish(),
  data: z.object({ id: z.uuid() }).passthrough(),
  updatedFrom: z.object({ labelIds: z.array(z.uuid()).nullish() }).optional(),
});

export function verifyLinearSignature(
  body: Buffer,
  signature: string | null,
  secret: string,
): boolean {
  return (
    !!signature &&
    /^[a-f\d]{64}$/iu.test(signature) &&
    timingSafeEqual(
      Buffer.from(signature, 'hex'),
      createHmac('sha256', secret).update(body).digest(),
    )
  );
}
export type LinearIntakeResult = {
  status: number;
  body: Record<string, unknown>;
};
export interface LinearIntakeDeps {
  authenticatedQueueDelivery?: boolean;
  readIssue?: typeof readLinearIssue;
  readComment?: typeof readLinearComment;
  reconcileTriage?: (issue: TrackerIssue, repo: string) => Promise<void>;
}
const ignored = (reason: string): LinearIntakeResult => ({
  status: 200,
  body: { outcome: 'ignored', reason },
});

/** Source synchronization is distinct from dispatch: even an unlabelled issue
 * has durable current metadata. Runs retain their own admitted source snapshot. */
export async function refreshLinearIssue(
  runtime: WorkContext['runtime'],
  config: LinearConfig,
  issue: TrackerIssue,
  now = new Date().toISOString(),
): Promise<
  { repo?: string; workId?: string; routingConflict?: boolean } | undefined
> {
  if (
    issue.reference.tracker !== 'linear' ||
    issue.reference.organizationId !== config.organizationId ||
    !issue.teamId
  )
    return undefined;
  const team = linearTeam(config, issue.teamId);
  if (!team) return undefined;
  let repo = linearIssueRepository(config, issue);
  await runtime.store.writeTrackerIssue({
    issue,
    ...(repo === undefined ? {} : { repo }),
    observedAt: now,
  });
  const workId = await runtime.store.readSourceWorkId(
    issueSourceKey(issue.reference),
  );
  if (workId) {
    const existing = await runtime.store.readTask({ workId });
    if (existing) {
      const origin = storedWorkPayloadSchema.parse(existing.task.work).origin;
      if (
        origin.channel !== 'linear' ||
        origin.thread !==
          JSON.stringify({
            organizationId: config.organizationId,
            issueId: issue.reference.issueId,
          })
      )
        throw new Error(
          'Linear source mapping does not match stored Work origin',
        );
      const refreshed = await runtime.orchestrator.refreshIssue(
        { workId },
        issue,
      );
      if (isRefusal(refreshed))
        throw new Error(`Linear source refresh refused: ${refreshed.reason}`);
      const current = refreshed.task.issue;
      if (current?.state === 'closed') {
        const active = await runtime.store.readActiveRun({ workId });
        if (active?.params?.['mode'] === 'implement')
          await runtime.orchestrator.cancelUnclaimedBefore({
            runId: active.runId,
            notAfter: current.updatedAt,
            issue: current,
            note: `Linear issue confirmed closed at ${current.updatedAt}`,
          });
      }
      const stored = storedWorkPayloadSchema.parse(existing.task.work).spec;
      const target = 'target' in stored ? stored.target.repo : undefined;
      if (!target) throw new Error('Linear source is bound to non-coding Work');
      if (repo !== undefined && repo !== target)
        return { repo: target, workId, routingConflict: true };
      repo = target;
    }
  }
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(workId ? { workId } : {}),
  };
}

export async function dispatchLinearIssue(
  runtime: WorkContext['runtime'],
  config: LinearConfig,
  issue: TrackerIssue,
  route: LinearConfig['routes'][number],
  command?: { ref: string; reply?: { text: string; principal: string } },
): Promise<LinearIntakeResult> {
  if (
    issue.reference.tracker !== 'linear' ||
    issue.reference.organizationId !== config.organizationId ||
    issue.teamId !== route.teamId
  )
    return ignored('issue outside route');
  if (issue.state !== 'open' && !command?.reply)
    return ignored('inactive issue');
  const grant = grantForPrincipal(route.principal);
  if (grant?.channel !== 'linear' || !grant.scopes.includes('work.operator'))
    return {
      status: 403,
      body: { error: 'Linear work.operator grant required' },
    };
  const id = await runtime.store.resolveSourceWorkId(
    issueSourceKey(issue.reference),
    ulid(),
  );
  const thread = JSON.stringify({
    organizationId: config.organizationId,
    issueId: issue.reference.issueId,
  });
  const existing = await runtime.store.readTask({ workId: id });
  if (existing) {
    const origin = storedWorkPayloadSchema.parse(existing.task.work).origin;
    if (origin.channel !== 'linear' || origin.thread !== thread)
      throw new Error(
        'Linear source mapping does not match stored Work origin',
      );
    const existingSpec = storedWorkPayloadSchema.parse(existing.task.work).spec;
    if (!('target' in existingSpec) || existingSpec.target.repo !== route.repo)
      return ignored('issue is already bound to a different repository');
    await runtime.orchestrator.refreshIssue({ workId: id }, issue);
    return { status: 200, body: { outcome: 'existing', itemId: id } };
  }
  const work = normalizeWorkPayload({
    origin: { principal: grant.principal, channel: 'linear', thread },
    spec: {
      title: `${issue.identifier}: ${issue.title}`.slice(0, WORK_TITLE_MAX),
      description: `Linear issue: ${issue.url}\n\n${issue.description || '(No description provided.)'}`,
      pipeline: route.pipeline,
      target: { repo: route.repo },
    },
  });
  const reply = command?.reply;
  const result = await mintItem(
    {
      runtime: {
        ...runtime,
        drain: async () => ({ dispatched: [], reported: [], failed: [] }),
      },
    },
    {
      id,
      spec: work.spec,
      origin: work.origin,
      issue,
      grantsPrincipal: grant,
      ...(command ? { requestId: `reply:${command.ref}` } : {}),
      ...(reply
        ? {
            params: {
              mode: 'reply',
              reply: reply.text.slice(0, 16_384),
              replyChannel: 'linear',
              replyPrincipal: reply.principal,
            },
          }
        : {}),
    },
  );
  if (result.kind === 'forbidden')
    return { status: 403, body: { error: result.message } };
  if (result.kind === 'conflict') {
    const winner = await runtime.store.readTask({ workId: id });
    if (!winner)
      throw new Error(`Linear admission conflict: ${result.message}`);
    const origin = storedWorkPayloadSchema.parse(winner.task.work).origin;
    if (origin.channel !== 'linear' || origin.thread !== thread)
      throw new Error(
        'Linear source mapping does not match stored Work origin',
      );
    return { status: 200, body: { outcome: 'existing', itemId: id } };
  }
  return { status: 200, body: { outcome: result.kind, itemId: id } };
}

export async function admitLinearWebhook(
  rawBody: Buffer,
  config: LinearConfig,
  runtime: WorkContext['runtime'],
  now = Date.now(),
  deps: LinearIntakeDeps = {},
): Promise<LinearIntakeResult> {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'Malformed JSON' } };
  }
  const parsed = linearWebhookEnvelopeSchema.safeParse(json);
  if (!parsed.success)
    return { status: 400, body: { error: 'Malformed Linear event' } };
  const event = parsed.data;
  if (
    !deps.authenticatedQueueDelivery &&
    Math.abs(now - event.webhookTimestamp) > 60_000
  )
    return { status: 401, body: { error: 'Stale Linear event' } };
  if (event.organizationId !== config.organizationId)
    return ignored('organization outside integration');
  if (
    !['Issue', 'Comment'].includes(event.type) ||
    !['create', 'update', 'remove'].includes(event.action)
  )
    return ignored('unsupported event');
  const commentEvent = event.type === 'Comment';
  const commentData = commentEvent
    ? z.object({ issueId: z.uuid(), body: z.string() }).safeParse(event.data)
    : undefined;
  if (commentEvent && (!commentData?.success || event.action !== 'create'))
    return ignored('unsupported comment event');
  const issueId = commentData?.success
    ? commentData.data.issueId
    : event.data.id;
  let issue = await (deps.readIssue ?? readLinearIssue)(
    config.organizationId,
    issueId,
  );
  if (!issue) {
    if (event.type !== 'Issue' || event.action !== 'remove')
      throw new Error('Linear current source is unavailable');
    const previous = await runtime.store.readTrackerIssue({
      tracker: 'linear',
      organizationId: config.organizationId,
      issueId,
    });
    if (!previous) return ignored('issue no longer exists');
    issue = {
      ...previous.issue,
      state: 'closed',
      updatedAt:
        event.createdAt ?? new Date(event.webhookTimestamp).toISOString(),
    };
  }
  const binding = await refreshLinearIssue(
    runtime,
    config,
    issue,
    new Date(now).toISOString(),
  );
  if (!binding) return ignored('team outside integration');
  const decide = async (): Promise<LinearIntakeResult> => {
    if (binding.routingConflict)
      return {
        status: 200,
        body: {
          outcome: 'refused',
          reason: 'issue is already bound to a different repository',
          itemId: binding.workId,
        },
      };
    if (commentEvent && commentData?.success) {
      const actor = event.actor;
      if (actor?.type !== 'user' || !config.operatorIds?.includes(actor.id))
        return ignored('untrusted comment author');
      const comment = await (deps.readComment ?? readLinearComment)(
        event.data.id,
      );
      if (
        !comment ||
        comment.issue?.id !== issueId ||
        comment.user?.id !== actor.id ||
        comment.body !== commentData.data.body ||
        comment.body.includes('<!-- agent-lcars:outcome -->') ||
        comment.body.includes('<!-- fleet-triage:v1:')
      )
        return ignored('comment changed or is adapter output');
      const trigger = matchReplyTrigger(comment.body, [
        ...REPLY_COMMANDS.keys(),
      ]);
      const pipeline = trigger ? REPLY_COMMANDS.get(trigger) : undefined;
      if (!pipeline) return ignored('no reply command');
      const route = config.routes.find(
        (candidate) =>
          candidate.teamId === issue.teamId &&
          candidate.repo === binding.repo &&
          candidate.pipeline === pipeline,
      );
      if (!route) return ignored('reply pipeline is not routed');
      const grant = grantForPrincipal(route.principal);
      if (
        grant?.channel !== 'linear' ||
        !grant.scopes.includes('work.operator')
      )
        return {
          status: 403,
          body: { error: 'Linear work.operator grant required' },
        };
      const ref = `linear:${config.organizationId}:${comment.id}`;
      const admitted: LinearIntakeResult = binding.workId
        ? { status: 200, body: { itemId: binding.workId } }
        : await dispatchLinearIssue(runtime, config, issue, route, {
            ref,
            reply: { text: comment.body, principal: `linear:${actor.id}` },
          });
      const itemId = admitted.body['itemId'];
      if (typeof itemId !== 'string') return admitted;
      if (!binding.workId && admitted.body['outcome'] === 'minted')
        return admitted;
      const context = createReplyContext(runtime, {
        principal: grant.principal,
        subject: grant.subjects[0],
        scopes: new Set(grant.scopes),
        pipelines: grant.pipelines,
        via: 'oidc',
        channel: 'linear',
      });
      const result = await requestReply(context, {
        task: { workId: itemId },
        text: comment.body,
        channel: 'linear',
        principal: `linear:${actor.id}`,
        ref,
        pipeline,
      });
      return {
        status: 200,
        body: {
          itemId,
          ...(result.ok
            ? {
                outcome: 'accepted',
                runId: result.runId,
                resumed: result.resumed,
              }
            : { outcome: 'refused', reason: result.message }),
        },
      };
    }
    if (issue.state === 'closed')
      return {
        status: 200,
        body: {
          outcome: 'inactive',
          ...(binding.workId ? { itemId: binding.workId } : {}),
        },
      };
    const labelIds = issue.labels.map((label) => label.id);
    const routes = config.routes.filter(
      (route) =>
        route.teamId === issue.teamId && labelIds.includes(route.labelId),
    );
    if (routes.length !== 1) {
      return ignored(
        routes.length
          ? 'multiple matching routes; select one dispatch label'
          : 'no matching route',
      );
    }
    const route = routes[0];
    const labelRef =
      event.createdAt &&
      event.actor?.type === 'user' &&
      config.operatorIds?.includes(event.actor.id) &&
      event.updatedFrom?.labelIds &&
      !event.updatedFrom.labelIds.includes(route.labelId) &&
      event.data['updatedAt'] === issue.updatedAt
        ? `linear-label:${createHash('sha256')
            .update(
              JSON.stringify([
                config.organizationId,
                issueId,
                event.createdAt,
                route.labelId,
                event.actor.id,
              ]),
            )
            .digest('hex')}`
        : undefined;
    const admitted = await dispatchLinearIssue(
      runtime,
      config,
      issue,
      route,
      labelRef ? { ref: labelRef } : undefined,
    );
    if (binding.workId && labelRef && event.actor) {
      const grant = grantForPrincipal(route.principal);
      if (!grant)
        return { status: 403, body: { error: 'Linear grant required' } };
      const context = createReplyContext(runtime, {
        principal: grant.principal,
        subject: grant.subjects[0],
        scopes: new Set(grant.scopes),
        pipelines: grant.pipelines,
        via: 'oidc',
        channel: 'linear',
      });
      const result = await requestReply(context, {
        task: { workId: binding.workId },
        text: `Dispatch requested from ${issue.identifier}.\n\n${issue.description}`,
        channel: 'linear',
        principal: `linear:${event.actor.id}`,
        ref: labelRef,
        pipeline: route.pipeline,
      });
      return {
        status: 200,
        body: {
          itemId: binding.workId,
          ...(result.ok
            ? {
                outcome: 'accepted',
                runId: result.runId,
                resumed: result.resumed,
              }
            : { outcome: 'refused', reason: result.message }),
        },
      };
    }
    return admitted;
  };
  const result = await decide();
  if (binding.repo) await deps.reconcileTriage?.(issue, binding.repo);
  return result;
}
