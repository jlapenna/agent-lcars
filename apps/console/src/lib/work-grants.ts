import 'server-only';

import { z } from 'zod';

const workScopeSchema = z.enum(['work.operator', 'work.executor']);

const grantSchema = z.strictObject({
  principal: z.string().min(1).max(128),
  subjects: z.array(z.string().min(1).max(256)).min(1),
  pipelines: z.array(z.string().min(1).max(64)).min(1),
  /** Absent means `['work.operator']` -- every grant written before this
   *  field existed keeps its exact current meaning. */
  scopes: z.array(workScopeSchema).optional(),
});
const grantsSchema = z.array(grantSchema);

export type WorkGrant = z.infer<typeof grantSchema>;

export function parseWorkGrants(raw: string | undefined): WorkGrant[] {
  if (raw === undefined || raw.trim() === '') return [];
  return grantsSchema.parse(JSON.parse(raw));
}

let cached: WorkGrant[] | undefined;
export function workGrants(): WorkGrant[] {
  cached ??= parseWorkGrants(process.env['AGENT_LCARS_WORK_GRANTS']);
  return cached;
}

/** Subjects are compared case-insensitively (emails and GitHub logins are). */
export function resolvePrincipal(
  subject: string,
  grants: WorkGrant[] = workGrants(),
): WorkGrant | undefined {
  const needle = subject.toLowerCase();
  return grants.find((g) => g.subjects.some((s) => s.toLowerCase() === needle));
}

/** Looks up a grant by its canonical LCARS principal (`user:jlapenna`,
 *  `svc:lcars-admin`) rather than by subject -- what a schedule's
 *  `createdBy` field already stores. Used only by the schedule tick, which
 *  must re-check the schedule creator's grant, never the tick caller's own
 *  (`cron:tick` has no grant of its own). */
export function grantForPrincipal(
  principal: string,
  grants: WorkGrant[] = workGrants(),
): WorkGrant | undefined {
  return grants.find((g) => g.principal === principal);
}

/** Pipelines routed to the `queue` executor at request time. Default `[]`:
 *  with nothing configured, `work-mint.ts`'s `executorFor` never returns
 *  `'queue'` and every run dispatches through GitHub Actions exactly as
 *  before this sub-project. */
export function queuePipelines(
  raw: string | undefined = process.env['AGENT_LCARS_QUEUE_PIPELINES'],
): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return z.array(z.string().min(1).max(64)).parse(JSON.parse(raw));
}

export function workMaxLiveRuns(): number {
  const raw = process.env['AGENT_LCARS_WORK_MAX_LIVE_RUNS'];
  if (raw === undefined || raw === '') return 4;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(
      'AGENT_LCARS_WORK_MAX_LIVE_RUNS must be a positive integer',
    );
  return n;
}

export function _resetWorkGrantsForTesting(): void {
  cached = undefined;
}
