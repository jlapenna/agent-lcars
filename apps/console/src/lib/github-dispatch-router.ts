import 'server-only';

import { decidedRun, isRefusal } from '@agent-lcars/orchestrator';
import { dispatchesContract } from '@agent-lcars/work';
import { implement, ORPCError } from '@orpc/server';

import { truncatedDescription } from './work-from-github';
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
    // GitHub permits a body larger than the durable Work spec. Normalize at
    // this single GitHub-anchor boundary before authorization or storage, so
    // every caller gets the same character/UTF-8-byte clamp and visible
    // marker as webhook/console GitHub derivation. Under-bound bodies pass
    // through byte-for-byte; valid empty bodies become the shared placeholder.
    const spec = {
      ...input.spec,
      description: truncatedDescription(input.spec.description),
    };
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

    // A caller can retry after the run has settled (for example after losing
    // the original HTTP response), when readActiveRun no longer sees it.
    // The task's durable run history is therefore the idempotency ledger for
    // this operation, not merely its live mutex.
    const previous = (await context.runtime.store.listRuns(input.anchor)).find(
      (run) => run.requestId === input.requestId,
    );
    if (previous !== undefined) {
      return { outcome: 'duplicate' as const, runId: previous.runId };
    }

    const outcome = await context.runtime.orchestrator.request({
      taskId: input.anchor,
      requestId: input.requestId,
      pipeline: spec.pipeline,
      params,
      work: {
        origin: {
          principal: principal.principal,
          channel: principal.via === 'session' ? 'console' : 'api',
        },
        spec,
      },
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
