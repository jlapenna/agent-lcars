import 'server-only';

import type { ScheduleStore } from '@agent-lcars/orchestrator';
import { PIPELINES } from '@agent-lcars/work';

import { issueCommentEventSchema, type Pipeline } from './orchestrator-ingest';
import type { OrchestratorRouteDeps } from './orchestrator-routes';
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
 * By the time this runs, `interpretIssueCommentEvent` has already matched
 * an explicit trigger (`@claude`/`@agent`/`/codex`/`/oc`) and checked the
 * author gate (`OWNER`/`MEMBER`, never a `Bot`) -- so this is not a bearer
 * identity, it exists only to satisfy `requestReply`'s "every reply
 * carries a principal" invariant and to answer `forbiddenReason`'s
 * pipeline/repo check. Granted every pipeline directly, the same way
 * `pin:tick` (`work-auth.ts`) is a synthetic principal constructed inline
 * rather than resolved through `AGENT_LCARS_WORK_GRANTS`: a tagged reply
 * explicitly selects its pipeline through the already-validated trigger,
 * against a repository the pure interpreter already confirmed is
 * control-plane -- there is nothing left for a grant to gate here.
 */
const TAGGED_REPLY_PRINCIPAL: WorkPrincipal = {
  principal: 'svc:github-tagged-reply',
  subject: 'svc:github-tagged-reply',
  scopes: new Set<WorkScope>(['work.operator']),
  pipelines: [...PIPELINES],
  via: 'oidc',
};

/** Replies never read schedules. Fail locally if that contract changes. */
const unreachableScheduleStore: ScheduleStore = {
  readSchedule: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
  writeSchedule: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
  listSchedules: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
  listEnabledSchedules: () => {
    throw new Error('tagged-reply: scheduleStore is not available here');
  },
};

/** Builds the authenticated context required by `requestReply`. */
function taggedReplyContext(runtime: OrchestratorRouteDeps): WorkContext {
  return {
    principal: TAGGED_REPLY_PRINCIPAL,
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
 * The resume attempt behind a *tagged* GitHub reply
 * (`@claude`/`@agent`/`/codex`/`/oc`, matched by
 * `interpretIssueCommentEvent`'s `matchReplyCommand`) -- called from
 * `handleWebhookDelivery` before it falls into the ordinary
 * `admitGithubWork` dispatch for a `mode: 'reply'` decision.
 *
 * On a PARKED or DONE anchor this resumes that task's existing session
 * with the comment as its next turn: the same mechanism
 * resumable-conversations plan 2 (#1773) proved live for an untagged
 * comment (#1787), now gated behind the trigger tag instead of an
 * allowlist (#1788, #1789) -- the trigger word is the gate, continuity is
 * unchanged.
 *
 * Returns `undefined` whenever `requestReply` declines for *any* reason,
 * so the caller falls through to the unchanged `admitGithubWork` path:
 * `NOT_FOUND` above all, since a tagged comment on an issue with no task
 * yet is how work is started by comment, and that must keep working. A
 * claimed or same-provider queued anchor (`CONFLICT`/`task-busy`) falls
 * through too, but that is safe -- `admitGithubWork`'s concurrency guard (`decide.ts`'s
 * `requestRun`) refuses the very same live run before a second one could
 * ever be created. An explicit provider switch may atomically replace an
 * unclaimed queued attempt through `requestReply`; a claim that wins the
 * transaction race prevents replacement.
 */
export async function attemptTaggedReplyResume(
  deps: OrchestratorRouteDeps,
  input: {
    event: string;
    deliveryId: string;
    payload: unknown;
    pipeline: Pipeline;
  },
): Promise<RouteResult | undefined> {
  if (input.event !== 'issue_comment') return undefined;

  const parsed = issueCommentEventSchema.safeParse(input.payload);
  if (!parsed.success) return undefined;
  const { repository, issue, comment, sender } = parsed.data;

  const outcome = await requestReply(taggedReplyContext(deps), {
    task: { repo: repository.full_name, issue: issue.number },
    text: comment.body,
    // Preserve the validated trigger's provider choice. requestReply starts
    // fresh on a provider switch and keeps the original Work spec intact.
    pipeline: input.pipeline,
    channel: 'github',
    principal: `github:${sender.login}`,
    // The comment's own URL: an idempotent request id, so a redelivery of
    // this webhook maps back to the run it already minted rather than
    // minting a second one.
    ...(comment.html_url === undefined ? {} : { ref: comment.html_url }),
  });

  if (!outcome.ok) return undefined;
  return {
    status: 200,
    body: { runId: outcome.runId, resumed: outcome.resumed },
  };
}
