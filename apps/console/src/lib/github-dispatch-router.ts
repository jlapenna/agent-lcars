import 'server-only';

import { dispatchesContract } from '@agent-lcars/work';
import { implement, ORPCError } from '@orpc/server';

import { admitGithubWork } from './github-work-admission';
import type { WorkContext } from './work-mint';

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
    const params: Record<string, string> = { mode: input.mode };
    if (input.reply !== undefined) params['reply'] = input.reply;
    if (input.runbook !== undefined) params['runbook'] = input.runbook;
    if (input.context !== undefined) params['context'] = input.context;

    const outcome = await admitGithubWork(context.runtime, {
      anchor: input.anchor,
      requestId: input.requestId,
      params,
      work: {
        origin: {
          principal: principal.principal,
          channel: principal.via === 'session' ? 'console' : 'api',
        },
        spec: input.spec,
      },
      authorization: {
        ...(principal.sourceRepository === undefined
          ? {}
          : { sourceRepository: principal.sourceRepository }),
        grantsPrincipal: principal,
      },
    });
    if (outcome.kind === 'invalid') {
      throw errors.BAD_REQUEST({ message: outcome.message });
    }
    if (outcome.kind === 'forbidden') {
      throw errors.FORBIDDEN({ message: outcome.message });
    }
    if (outcome.kind === 'duplicate' || outcome.kind === 'busy') {
      return {
        outcome: outcome.kind,
        runId: outcome.runId,
      };
    }
    return {
      outcome: 'accepted' as const,
      runId: outcome.runId,
      dispatched: outcome.dispatched,
    };
  }),
});
