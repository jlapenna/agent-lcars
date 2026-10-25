import { z } from 'zod';

export const FLEET_TRIAGE_OPERATION = 'fleet-triage:v1' as const;
export const fleetTriageInputSchema = z.strictObject({
  operation: z.literal(FLEET_TRIAGE_OPERATION),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  issue: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});

/** A report proposes effects; it never grants its own authority to write. */
export const fleetTriageReportSchema = z
  .strictObject({
    sourceRevision: z.string().min(1).max(128),
    disposition: z.enum([
      'ready',
      'needs-evidence',
      'needs-owner',
      'duplicate',
      'not-a-bug',
    ]),
    summary: z.string().trim().min(1).max(2_000),
    evidence: z.array(z.string().trim().min(1).max(1_000)).min(1).max(8),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(8),
    labels: z.array(z.string().trim().min(1).max(100)).max(12),
  })
  .refine(
    (value) =>
      value.disposition !== 'ready' || value.acceptanceCriteria.length > 0,
    {
      message: 'Ready triage needs concrete acceptance criteria',
    },
  );
export type FleetTriageInput = z.infer<typeof fleetTriageInputSchema>;
export type FleetTriageReport = z.infer<typeof fleetTriageReportSchema>;

/** Triage effects use the existing outbox's leases and retries. These receipts
 * describe external effects, not a second delivery queue. */
export const triagePublicationSchema = z.strictObject({
  state: z.enum(['pending', 'complete', 'superseded', 'failed']),
  commentBody: z.string().max(16_384).optional(),
  commentId: z.number().int().positive().optional(),
  sourceComment: z
    .strictObject({
      id: z.number().int().positive(),
      body: z.string().max(65_536),
      updatedAt: z.iso.datetime(),
    })
    .optional(),
  addedLabels: z.array(z.string().min(1).max(100)).max(20).optional(),
  dispatchRequested: z.iso.datetime().optional(),
  dispatchObserved: z.boolean().optional(),
  error: z.string().max(400).optional(),
});
export type TriagePublication = z.infer<typeof triagePublicationSchema>;
