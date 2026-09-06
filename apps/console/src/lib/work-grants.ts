import 'server-only';

import { PIPELINES, WORK_CHANNELS } from '@agent-lcars/work';
import { z } from 'zod';

const workScopeSchema = z.enum(['work.operator', 'work.executor', 'work.cron']);

/** A pipeline name checked against the same closed set `workSpecSchema`
 *  requires (`libs/work/src/spec.ts`'s `PIPELINES`) -- so a typo in
 *  `AGENT_LCARS_WORK_GRANTS` is a startup config error, not a silently inert
 *  grant discovered later by a principal who mysteriously has no access. */
const pipelineNameSchema = z.enum(PIPELINES);

/** A channel checked against the same closed set `workOriginSchema.channel`
 *  requires (`libs/work/src/spec.ts`'s `WORK_CHANNELS`) -- the same
 *  drift-proofing `pipelineNameSchema` gives pipeline names. Declaring it
 *  here (rather than accepting one from the request body -- see
 *  `itemsContract.create`'s `thread` doc comment) is what keeps the
 *  delivery channel a property of the authenticated identity instead of
 *  something a caller can name for itself. */
const channelSchema = z.enum(WORK_CHANNELS);

const grantSchema = z.strictObject({
  principal: z.string().min(1).max(128),
  subjects: z.array(z.string().min(1).max(256)).min(1),
  pipelines: z.array(pipelineNameSchema).min(1),
  /** Every grant must name the non-empty authority it confers. */
  scopes: z.array(workScopeSchema).min(1),
  /** Absent means "derive it the old way" (`session ? 'console' : 'api'`)
   *  -- see `work-router.ts`'s `create` handler. Declared only for
   *  principals whose outbound delivery target isn't one of those two,
   *  e.g. a Slack-bound service grant. */
  channel: channelSchema.optional(),
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
