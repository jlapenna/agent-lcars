import { z } from 'zod';

/** Server-generated reading aid; never an authorization or executable plan. */
export const humanNeededActionsSchema = z
  .array(
    z.strictObject({
      text: z.string().trim().min(1).max(400),
      /** An exact excerpt from the handoff, never a synthesized command. */
      command: z.string().trim().min(1).max(2_000).optional(),
    }),
  )
  .min(2)
  .max(3);

export type HumanNeededActions = z.infer<typeof humanNeededActionsSchema>;
