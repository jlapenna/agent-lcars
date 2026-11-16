import { z } from 'zod';

import {
  serializedJsonBytes,
  WORK_PAYLOAD_MAX_BYTES,
  WORK_PAYLOAD_TOO_LARGE,
} from './work-budgets';

/** The read-only `claw/investigator` operation (unified-dataflow design,
 * "`claw`", phase 3a). Admitted only through the Work API's internal
 * admission route; public mutation routes reject it. */
export const CLAW_INVESTIGATE_OPERATION = 'investigate:v1' as const;

export const CLAW_OPERATIONS = Object.freeze([
  CLAW_INVESTIGATE_OPERATION,
] as const);
export type ClawOperation = (typeof CLAW_OPERATIONS)[number];

/** The Work Console stores and the executor's brief carries. The launcher
 * hands `question` to the agent's single turn through a file; nothing else in
 * it selects the agent, its zone, tools or credentials. The question has no
 * character cap: it is stored as the round's source revision input, so only
 * that input's serialized Work payload budget bounds it. */
export const clawInvestigateInputSchema = z.strictObject({
  question: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, {
      message: 'Question must not be blank',
    })
    .refine(
      (question) =>
        serializedJsonBytes({
          operation: CLAW_INVESTIGATE_OPERATION,
          question,
        }) <= WORK_PAYLOAD_MAX_BYTES,
      { message: `Question ${WORK_PAYLOAD_TOO_LARGE}` },
    ),
});
export type ClawInvestigateInput = z.infer<typeof clawInvestigateInputSchema>;

/* The report is the completion message itself, with no structured artifact.
 * It shares every run's message contract (`./run-message`): stored whole,
 * never truncated, bounded only by `RUN_MESSAGE_MAX_BYTES`. */
