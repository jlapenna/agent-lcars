import { z } from 'zod';

/** The trusted source sends identifiers only; all Outline reads stay on pike. */
export const outlineEventNoticeSchema = z.strictObject({
  deliveryId: z.uuid(),
  event: z.enum([
    'comments.create',
    'comments.update',
    'documents.update',
    'revisions.create',
  ]),
  actorId: z.uuid(),
  documentId: z.uuid(),
  objectId: z.uuid(),
  occurredAt: z.iso.datetime(),
});
export type OutlineEventNotice = z.infer<typeof outlineEventNoticeSchema>;

export const OUTLINE_SOURCE_OUTCOMES = [
  'accepted',
  'own-change',
  'untrusted-actor',
  'foreign-document',
  'no-text-change',
] as const;
export const outlineSourceReportSchema = z.strictObject({
  noticeId: z.uuid(),
  outcome: z.enum(OUTLINE_SOURCE_OUTCOMES),
  /** Positive only after auth.info and documents.info agree on the creator. */
  agentCreated: z.boolean(),
});
export type OutlineSourceReport = z.infer<typeof outlineSourceReportSchema>;

export const outlineSourceJobSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('outline-event'),
    notice: outlineEventNoticeSchema,
  }),
  z.strictObject({
    type: z.literal('outline-observe'),
    documentId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal('outline-fallback'),
    /** Stable UUID used as the Outline comment id across retries. */
    id: z.uuid(),
    documentId: z.uuid(),
    parentCommentId: z.uuid().optional(),
  }),
]);
export type OutlineSourceJob = z.infer<typeof outlineSourceJobSchema>;
