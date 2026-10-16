import { z } from 'zod';

export const runPlacementSchema = z.strictObject({
  phase: z.enum(['waiting-for-placement', 'bootstrapping', 'unavailable']),
  // Allowlisted scheduler categories only; never raw node names/events.
  reason: z.enum([
    'pending',
    'unschedulable',
    'scheduled',
    'inventory-unavailable',
    'launch-pending',
  ]),
  observedAt: z.iso.datetime({ offset: false }).max(32),
  jobCreatedAt: z.iso.datetime({ offset: false }).max(32).optional(),
});
export type RunPlacement = z.infer<typeof runPlacementSchema>;
