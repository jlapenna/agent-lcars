import 'server-only';

import { SESSION_AGENTS } from '@agent-lcars/telemetry';
import { z } from 'zod';

import { getSessionArchive, parseSessionArchiveQuery } from './session-archive';
import { costBudgetAssessment, parseCostBudget } from './session-spend';
import type { WorkPrincipal } from './work-auth';

const selectionSchema = z.strictObject({
  days: z.string().regex(/^(?:1h|[1-9]|[1-8][0-9]|90)$/),
  source: z.enum(['cli', 'issue-agent']).optional(),
  repo: z.string().min(1).max(200).optional(),
  agent: z.enum(SESSION_AGENTS).optional(),
  issue: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .max(15)
    .optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

/** Fixed-selection operator readout. It uses the Costs page's archive,
 * pricing and assessment; it neither writes monitoring nor sends alerts. */
export async function costBudgetResponse(
  request: Request,
  principal: WorkPrincipal | undefined,
) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!principal?.scopes.has('costs.reader'))
    return Response.json(
      { error: 'costs.reader scope required' },
      { status: 403, headers },
    );
  if (request.method !== 'GET')
    return new Response(null, { status: 405, headers });
  const params = new URL(request.url).searchParams;
  const raw = Object.fromEntries(params);
  const parsed = selectionSchema.safeParse(raw);
  if (!parsed.success || [...params.keys()].length !== Object.keys(raw).length)
    return Response.json(
      { error: 'An explicit valid Costs selection is required' },
      { status: 400, headers },
    );
  const query = {
    ...parseSessionArchiveQuery(parsed.data),
    ...(parsed.data.q ? { q: parsed.data.q } : {}),
  };
  if (parsed.data.repo && !query.repo)
    return Response.json(
      { error: 'Repository is not watched' },
      { status: 400, headers },
    );
  const budget = parseCostBudget(
    process.env['AGENT_LCARS_COST_BUDGET_USD'],
    process.env['AGENT_LCARS_COST_WARNING_PERCENT'],
  );
  try {
    const archive = await getSessionArchive(query, { includeSpend: true });
    const spend = archive.spend;
    return Response.json(
      {
        version: 1,
        selection: parsed.data,
        observedAt: new Date().toISOString(),
        basis: 'selected cumulative-session subtotal',
        rateSource: '@agent-lcars/telemetry:estimateCostUsd',
        budget,
        assessment:
          archive.available && spend
            ? costBudgetAssessment(spend, budget)
            : 'unavailable',
        coverageComplete:
          archive.available &&
          !!spend &&
          !spend.coverageLimited &&
          spend.totals.unpricedSessions === 0,
        totals: spend
          ? {
              knownUsd: spend.totals.costUsd ?? 0,
              reportedUsd: spend.totals.reportedCostUsd,
              estimatedUsd: spend.totals.estimatedCostUsd,
              unpricedSessions: spend.totals.unpricedSessions,
            }
          : null,
      },
      { headers },
    );
  } catch {
    return Response.json(
      { error: 'Costs readout unavailable' },
      { status: 503, headers },
    );
  }
}
