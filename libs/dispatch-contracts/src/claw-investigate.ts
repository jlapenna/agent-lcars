import { z } from 'zod';

/** The read-only `claw/investigator` operation (unified-dataflow design,
 * "`claw`", phase 3a). Admitted only through the Work API's internal
 * admission route; public mutation routes reject it. */
export const CLAW_INVESTIGATE_OPERATION = 'investigate:v1' as const;

/** The `claw/oncall` operation (unified-dataflow design, phase 3b): one
 * Alertmanager group investigation, admitted only by `oncall-alert-gate`
 * through `POST /claw/oncall/alerts`. Its input is the same `{question}`
 * shape, so the launcher hands both operations to the agent identically. */
export const CLAW_ONCALL_INVESTIGATE_OPERATION =
  'oncall-investigate:v1' as const;

export const CLAW_OPERATIONS = Object.freeze([
  CLAW_INVESTIGATE_OPERATION,
  CLAW_ONCALL_INVESTIGATE_OPERATION,
] as const);
export type ClawOperation = (typeof CLAW_OPERATIONS)[number];

/** Alertmanager's group identity as `oncall-alert-gate` digests it. */
export const ONCALL_GROUP_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/u;
/** Alertmanager alert fingerprints: 16 lowercase hex digits. */
export const ONCALL_FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/u;
export const ONCALL_FINGERPRINTS_MAX = 64;
/** The firing episode: the group's earliest alert `startsAt` (RFC 3339),
 * so a group that resolves and re-fires with the same fingerprints is a new
 * round. */
export const ONCALL_EPISODE_PATTERN = /^[0-9TZ:.+-]{1,40}$/u;

export const CLAW_INVESTIGATE_QUESTION_MAX = 4_000;

/** The Work Console stores and the executor's brief carries. The launcher
 * hands `question` to the agent's single turn; nothing else in it selects
 * the agent, its zone, tools or credentials. */
export const clawInvestigateInputSchema = z.strictObject({
  question: z
    .string()
    .min(1)
    .max(CLAW_INVESTIGATE_QUESTION_MAX)
    .refine((value) => value.trim().length > 0, {
      message: 'Question must not be blank',
    }),
});
export type ClawInvestigateInput = z.infer<typeof clawInvestigateInputSchema>;

/** The report is the completion message itself, with no structured
 * artifact. Equal to the existing `/runs/{runId}/complete` and stored
 * `Run.result.message` bound, so a report is never silently truncated. */
export const CLAW_REPORT_MAX = 16_384;
