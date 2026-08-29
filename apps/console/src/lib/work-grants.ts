import 'server-only';

import { PIPELINES } from '@agent-lcars/work';
import { z } from 'zod';

const workScopeSchema = z.enum(['work.operator', 'work.executor', 'work.cron']);

/** A pipeline name checked against the same closed set `workSpecSchema`
 *  requires (`libs/work/src/spec.ts`'s `PIPELINES`) -- so a typo in
 *  `AGENT_LCARS_WORK_GRANTS` is a startup config error, not a silently inert
 *  grant discovered later by a principal who mysteriously has no access. */
const pipelineNameSchema = z.enum(PIPELINES);

const grantSchema = z.strictObject({
  principal: z.string().min(1).max(128),
  subjects: z.array(z.string().min(1).max(256)).min(1),
  pipelines: z.array(pipelineNameSchema).min(1),
  /** Absent means `['work.operator']` -- every grant written before this
   *  field existed keeps its exact current meaning. Explicitly empty is
   *  refused (`.min(1)`), not silently treated as "no scopes": there is no
   *  reading of `scopes: []` in a config file that means anything other
   *  than a mistake -- it is either absent (the operator default) or a
   *  deliberate non-empty list. */
  scopes: z.array(workScopeSchema).min(1).optional(),
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
 *  must re-check the schedule creator's grant, not the tick caller's
 *  separate `work.cron` authority. */
export function grantForPrincipal(
  principal: string,
  grants: WorkGrant[] = workGrants(),
): WorkGrant | undefined {
  return grants.find((g) => g.principal === principal);
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
