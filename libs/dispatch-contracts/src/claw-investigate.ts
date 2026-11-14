import { z } from 'zod';

/** The read-only `claw/investigator` operation (unified-dataflow design,
 * "`claw`", phase 3a). Admitted only through the Work API's internal
 * admission route; public mutation routes reject it. */
export const CLAW_INVESTIGATE_OPERATION = 'investigate:v1' as const;

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
