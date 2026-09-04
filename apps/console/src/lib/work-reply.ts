import 'server-only';

import {
  decidedRun,
  isRefusal,
  type TaskId,
  taskKey,
} from '@agent-lcars/orchestrator';
import type { SessionDoc } from '@agent-lcars/telemetry';
import { workPayloadSchema, type WorkSpec } from '@agent-lcars/work';
import { deriveItemState } from '@agent-lcars/work/derive';

import {
  forbiddenReason,
  liveNativeRunCount,
  type WorkContext,
} from './work-mint';

/** The one pipeline whose CLI session this plan can restore. Plans 3 and 4
 *  add `codex` and `opencode`; until then a reply on those pipelines is a
 *  fresh session carrying the reply text, which is exactly today's
 *  behavior and strictly better than refusing the reply. */
const RESUMABLE_PIPELINES: Record<string, string> = { claude: 'claude-code' };

/** Bounded to match `WORK_DESCRIPTION_MAX`: a reply is the same kind of
 *  prose an item's description is (spec decision 5). `runSchema.params`'s
 *  per-value bound (`libs/orchestrator/src/model.ts`) was raised to match
 *  so a full-length reply can actually be persisted on `Run.params.reply`. */
export const REPLY_MAX = 16_384;

export interface ReplyRequest {
  /** The orchestrator's own anchor union: `{ workId }` for a native item,
   *  `{ repo, issue }` for a GitHub-anchored task. A GitHub-anchored reply
   *  routes through exactly the machinery a native item already does --
   *  see `implicit-reply.ts`. */
  task: TaskId;
  text: string;
  channel: 'api' | 'console' | 'github' | 'slack';
  principal: string;
  /** Channel address of the human turn: a comment URL, a Slack ts. Used to
   *  derive an idempotent request id so a redelivered webhook or a
   *  double-clicked button maps back to the run it already minted. */
  ref?: string;
  pipeline?: string;
  resume?: boolean;
}

export type ReplyOutcome =
  | { ok: true; runId: string; resumed: boolean }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'TOO_MANY_REQUESTS';
      message: string;
    };

/**
 * The newest session that this item can actually resume: it must belong to
 * one of this item's own runs, carry an archived transcript, and be the
 * agent the requested pipeline runs. Pure, so the ownership rules are
 * testable without a Firestore double.
 */
export function selectResumeSession(
  sessions: readonly SessionDoc[],
  runIds: ReadonlySet<string>,
  pipeline: string,
): SessionDoc | undefined {
  const agent = RESUMABLE_PIPELINES[pipeline];
  if (agent === undefined) return undefined;
  return sessions
    .filter(
      (doc) =>
        doc.source === 'issue-agent' &&
        doc.intentId !== undefined &&
        runIds.has(doc.intentId) &&
        doc.agent === agent &&
        doc.transcriptGcsUri !== undefined,
    )
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
}

/**
 * The one channel-neutral primitive every reply ingress calls: the console
 * route (Task 3) and, in plan 2, the GitHub ingest directly. Mints the next
 * run with the human's text on `Run.params` and, when a resumable session
 * exists, the resume request on the same params -- resolving the
 * resumable session itself rather than making the caller pick one.
 *
 * Mirrors `redispatch`'s existing checks (`work-router.ts`) rather than
 * inventing new ones.
 */
export async function requestReply(
  context: WorkContext,
  request: ReplyRequest,
): Promise<ReplyOutcome> {
  // A reply always carries an authenticated identity: the router's
  // `operator` middleware guarantees `context.principal` for the console
  // route, and plan 2's GitHub ingest resolves its own service principal
  // before calling this. `WorkContext.principal` stays optional on the
  // shared type because other callers (e.g. `mintItem`'s webhook caller)
  // legitimately have none.
  if (context.principal === undefined) {
    return { ok: false, code: 'FORBIDDEN', message: 'no principal' };
  }
  const { principal } = context;

  const task = await context.runtime.store.readTask(request.task);
  if (task === undefined)
    return { ok: false, code: 'NOT_FOUND', message: 'no such item' };

  const runs = await context.runtime.store.listRuns(request.task);
  const state = deriveItemState(task.task, runs);
  // A reply is new information for an item that has stopped. A live run
  // already has the conversation open; queuing the reply is option B's
  // territory, so refuse with the orchestrator's own vocabulary.
  if (state === 'running')
    return { ok: false, code: 'CONFLICT', message: 'task-busy' };
  if (state === 'canceled')
    return { ok: false, code: 'CONFLICT', message: 'task-closed' };

  const { spec } = workPayloadSchema.parse(task.task.work);
  const latest = runs.at(-1);
  // Widened to `string` by `Run.pipeline`/`ReplyRequest.pipeline` (both
  // opaque routing data, not the enum `WorkSpec.pipeline` is) -- always one
  // of the same three values in practice, since each was itself validated
  // against that enum where it originated (the route input, or an earlier
  // `spec.pipeline`).
  const pipeline = (request.pipeline ??
    latest?.pipeline ??
    spec.pipeline) as WorkSpec['pipeline'];
  const forbidden = forbiddenReason(principal, { ...spec, pipeline });
  if (forbidden !== undefined)
    return { ok: false, code: 'FORBIDDEN', message: forbidden };

  // Cross-CLI resume is meaningless: a Codex thread cannot continue a
  // Claude session. Switching pipeline is allowed, it just starts fresh.
  const mayResume =
    (request.resume ?? true) && pipeline === (latest?.pipeline ?? pipeline);
  let resumeParams: Record<string, string> = {};
  if (mayResume) {
    const runIds = new Set(runs.map((r) => r.runId));
    const sessions = await context.sessionDocsForRuns([...runIds]);
    const chosen = selectResumeSession(sessions, runIds, pipeline);
    if (
      chosen !== undefined &&
      chosen.source === 'issue-agent' &&
      chosen.transcriptGcsUri !== undefined
    ) {
      resumeParams = {
        resumeSessionId: chosen.sessionId,
        resumeTranscriptGcsUri: chosen.transcriptGcsUri,
      };
    }
  }

  if ((await liveNativeRunCount(context)) >= context.maxLiveRuns) {
    return {
      ok: false,
      code: 'TOO_MANY_REQUESTS',
      message: 'fleet is at its live-run cap',
    };
  }

  const outcome = await context.runtime.orchestrator.request({
    taskId: request.task,
    requestId:
      request.ref === undefined
        ? `${taskKey(request.task)}:${task.task.runCount + 1}`
        : `reply:${request.ref}`,
    pipeline,
    params: {
      mode: 'reply',
      reply: request.text.slice(0, REPLY_MAX),
      replyChannel: request.channel,
      replyPrincipal: request.principal,
      ...(request.ref === undefined ? {} : { replyRef: request.ref }),
      ...resumeParams,
    },
  });
  if (isRefusal(outcome))
    return { ok: false, code: 'CONFLICT', message: outcome.reason };
  await context.runtime.drain();
  return {
    ok: true,
    runId: decidedRun(outcome).runId,
    resumed: resumeParams['resumeSessionId'] !== undefined,
  };
}
