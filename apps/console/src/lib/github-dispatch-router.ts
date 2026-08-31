import 'server-only';

import { decidedRun, isRefusal } from '@agent-lcars/orchestrator';
import { dispatchesContract } from '@agent-lcars/work';
import { implement, ORPCError } from '@orpc/server';

import { normalizeGithubWorkPayload } from './work-from-github';
import { forbiddenReason, type WorkContext } from './work-mint';

const os = implement(dispatchesContract).$context<WorkContext>();

/** The GitHub-anchor admission route has the same structural operator gate
 * as items.create. Keeping it here makes the public operation independently
 * auditable: no handler can accidentally skip scope validation. */
const operator = os.use(async ({ context, next }) => {
  const { principal } = context;
  if (principal === undefined || !principal.scopes.has('work.operator')) {
    throw new ORPCError('UNAUTHORIZED', {
      message: 'work.operator scope required',
    });
  }
  return next({ context: { principal } });
});

/**
 * Work API admission for a GitHub issue or pull-request anchor. The anchor
 * and Work target must agree, and a GitHub Actions OIDC principal is further
 * bound to the repository its signed token named. This preserves the legacy
 * route's caller-repository boundary while using normal Work grants rather
 * than a dispatch-route-specific authorization rule.
 */
export const githubDispatchRouter = os.router({
  github: operator.github.handler(async ({ input, context, errors }) => {
    const { principal } = context;
    // GitHub permits a body larger than the durable Work spec. Build and
    // normalize the complete payload before authorization or storage, so
    // JSON escapes and multi-byte text count against the exact serialized
    // byte cap just as they do for webhook/console GitHub derivation.
    const work = normalizeGithubWorkPayload({
      origin: {
        principal: principal.principal,
        channel: principal.via === 'session' ? 'console' : 'api',
      },
      spec: input.spec,
    });
    const { spec } = work;
    if (input.anchor.repo !== spec.target.repo) {
      throw errors.BAD_REQUEST();
    }
    if (
      principal.sourceRepository !== undefined &&
      principal.sourceRepository !== input.anchor.repo
    ) {
      throw errors.FORBIDDEN({
        message:
          'GitHub Actions principal may only dispatch its own repository',
      });
    }

    const forbidden = forbiddenReason(principal, spec);
    if (forbidden !== undefined) {
      throw errors.FORBIDDEN({ message: forbidden });
    }

    const params: Record<string, string> = { mode: input.mode };
    if (input.reply !== undefined) params['reply'] = input.reply;
    if (input.runbook !== undefined) params['runbook'] = input.runbook;
    if (input.context !== undefined) params['context'] = input.context;

    const outcome = await context.runtime.orchestrator.request({
      taskId: input.anchor,
      requestId: input.requestId,
      pipeline: spec.pipeline,
      params,
      work,
    });

    if (isRefusal(outcome)) {
      const existing = outcome.existingRun;
      if (existing === undefined) {
        console.error(
          'agent-lcars: GitHub dispatch received unexpected orchestrator refusal',
          outcome.reason,
        );
        throw new ORPCError('INTERNAL_SERVER_ERROR', {
          message: 'GitHub dispatch refusal had no existing run',
        });
      }
      return {
        outcome:
          outcome.reason === 'duplicate-request'
            ? ('duplicate' as const)
            : ('busy' as const),
        runId: existing.runId,
      };
    }

    const { runId } = decidedRun(outcome);
    const drained = await context.runtime.drain();
    return {
      outcome: 'accepted' as const,
      runId,
      dispatched: drained.dispatched.includes(runId),
    };
  }),
});
