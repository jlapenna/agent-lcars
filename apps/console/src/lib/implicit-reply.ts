import 'server-only';

import { splitEnvList } from '@agent-lcars/env';
import { PIPELINES } from '@agent-lcars/work';

import { issueCommentEventSchema } from './orchestrator-ingest';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
import { unreachableScheduleStore } from './push-watch';
import type { WorkPrincipal, WorkScope } from './work-auth';
import { workMaxLiveRuns } from './work-grants';
import type { WorkContext } from './work-mint';
import { requestReply } from './work-reply';
import {
  sessionDocsForRuns,
  sessionForResume,
  sessionsForRuns,
} from './work-sessions';

type RouteResult = { status: number; body: Record<string, unknown> };

/**
 * The webhook has already authenticated this delivery (HMAC signature, one
 * layer up), so this is not a bearer identity -- it exists only to satisfy
 * `requestReply`'s "every reply carries a principal" invariant and to
 * answer `forbiddenReason`'s pipeline check. Granted every pipeline
 * directly, the same way `pin:tick` (`work-auth.ts`) is a synthetic
 * principal constructed inline rather than resolved through
 * `AGENT_LCARS_WORK_GRANTS` -- an implicit reply always continues a
 * pipeline the anchor's own admission already chose, so there is nothing
 * left for a grant to gate here that isn't already gated by the
 * `AGENT_LCARS_IMPLICIT_REPLY_REPOS` allowlist below.
 */
const IMPLICIT_REPLY_PRINCIPAL: WorkPrincipal = {
  principal: 'svc:github-implicit-reply',
  subject: 'svc:github-implicit-reply',
  scopes: new Set<WorkScope>(['work.operator']),
  pipelines: [...PIPELINES],
  via: 'oidc',
};

/** Builds the `WorkContext` `requestReply` needs, the same way
 *  `push-watch.ts`'s `pushWatchContext` builds what `mintItem` needs --
 *  except `principal` must be set here, since `requestReply` (unlike
 *  `mintItem`) refuses `FORBIDDEN` for a context with none. */
function implicitReplyContext(runtime: OrchestratorRouteDeps): WorkContext {
  return {
    principal: IMPLICIT_REPLY_PRINCIPAL,
    runtime,
    sessionsFor: sessionsForRuns,
    getSessionDoc: sessionForResume,
    sessionDocsForRuns,
    maxLiveRuns: workMaxLiveRuns(),
    scheduleStore: unreachableScheduleStore,
    grants: () => [],
    now: () => new Date(),
  };
}

/**
 * The stateful second pass over an `issue_comment` the pure interpreter
 * (`orchestrator-ingest.ts`) already declined as `no-reply-command`.
 *
 * It cannot live in that module: deciding "is this anchor parked" needs
 * the store, and `interpretDelivery`/`interpretIssueCommentEvent` are
 * deliberately pure and stateless. This is the same split
 * `handlePushWebhookDelivery` (`push-watch.ts`) already uses for `push`.
 *
 * Returns `undefined` when the delivery is not an implicit reply at all,
 * so the caller (`orchestrator-routes.ts`) falls through to its existing
 * ignore-and-refresh path.
 */
export async function handleImplicitReplyDelivery(
  deps: OrchestratorRouteDeps,
  input: { event: string; deliveryId: string; payload: unknown },
): Promise<RouteResult | undefined> {
  if (input.event !== 'issue_comment') return undefined;

  const allowed = new Set(
    splitEnvList('AGENT_LCARS_IMPLICIT_REPLY_REPOS').map((repo) =>
      repo.toLowerCase(),
    ),
  );
  if (allowed.size === 0) return undefined;

  const parsed = issueCommentEventSchema.safeParse(input.payload);
  if (!parsed.success) return undefined;
  const { action, repository, issue, comment, sender } = parsed.data;
  if (action !== 'created') return undefined;
  if (!allowed.has(repository.full_name.toLowerCase())) return undefined;

  // Identical to the explicit-trigger gate in `interpretIssueCommentEvent`,
  // and load-bearing for loop prevention: the agent's own park comment is
  // authored by a Bot, so it can never answer itself.
  if (
    comment.user?.type === 'Bot' ||
    (comment.author_association !== 'OWNER' &&
      comment.author_association !== 'MEMBER')
  ) {
    return undefined;
  }

  const outcome = await requestReply(implicitReplyContext(deps), {
    task: { repo: repository.full_name, issue: issue.number },
    text: comment.body,
    channel: 'github',
    principal: `github:${sender.login}`,
    // The comment's own URL: an idempotent request id, so a redelivery of
    // this webhook maps back to the run it already minted rather than
    // minting a second one.
    ...(comment.html_url === undefined ? {} : { ref: comment.html_url }),
  });

  if (outcome.ok) {
    return {
      status: 200,
      body: { replied: outcome.runId, resumed: outcome.resumed },
    };
  }
  // A task that was never dispatched at all is not this feature's concern
  // -- fall through to the ordinary ignore path exactly as before.
  if (outcome.code === 'NOT_FOUND') return undefined;
  // Every other refusal here is an ordinary, expected outcome -- a live
  // run, a principal grant conflict, the fleet's live-run cap. Answering
  // 200 with a reason keeps GitHub from retrying a delivery that will
  // never succeed.
  return { status: 200, body: { ignored: outcome.message } };
}
