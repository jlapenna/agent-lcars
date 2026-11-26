import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/** Outline signs the exact body with a millisecond timestamp. Five-minute
 * freshness matches the existing bridge contract; it is not event age. */
export const OUTLINE_SIGNATURE_SKEW_MS = 5 * 60_000;
export const OUTLINE_AGENT_EVENTS = [
  'comments.create',
  'comments.update',
  'documents.update',
  'revisions.create',
] as const;
export type OutlineAgentEventName = (typeof OUTLINE_AGENT_EVENTS)[number];

export function verifyOutlineSignature(
  body: Buffer,
  header: string | null,
  secret: string,
  now: number,
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((part) => part.trim());
  if (parts.length !== 2) return false;
  const fields = new Map<string, string>();
  for (const part of parts) {
    const match = /^(t|s)=([^=]+)$/u.exec(part);
    if (!match || fields.has(match[1])) return false;
    fields.set(match[1], match[2]);
  }
  const timestamp = fields.get('t'),
    signature = fields.get('s');
  if (
    !timestamp ||
    !/^\d+$/u.test(timestamp) ||
    !signature ||
    !/^[a-f0-9]{64}$/iu.test(signature)
  )
    return false;
  const at = Number(timestamp);
  if (
    !Number.isSafeInteger(at) ||
    Math.abs(now - at) > OUTLINE_SIGNATURE_SKEW_MS
  )
    return false;
  const actual = Buffer.from(signature, 'hex');
  const expected = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const envelope = z.object({
  id: z.uuid(),
  actorId: z.uuid(),
  createdAt: z.iso.datetime(),
  event: z.string(),
  payload: z.object({
    model: z.object({ id: z.uuid(), documentId: z.uuid().optional() }),
  }),
});
export interface OutlineAgentNotice {
  readonly deliveryId: string;
  readonly event: OutlineAgentEventName;
  readonly actorId: string;
  readonly documentId: string;
  readonly objectId: string;
  readonly occurredAt: string;
}

/** Only identifiers survive source normalization. Comment bodies, titles,
 * document Markdown, embeds and links never enter LCARS storage or logs. */
export function outlineAgentNotice(
  input: unknown,
):
  | { readonly outcome: 'accepted'; readonly notice: OutlineAgentNotice }
  | { readonly outcome: 'ignored' }
  | { readonly outcome: 'invalid' } {
  const p = envelope.safeParse(input);
  if (!p.success) return { outcome: 'invalid' };
  const {
    id,
    actorId,
    createdAt,
    event,
    payload: { model },
  } = p.data;
  const known: readonly string[] = OUTLINE_AGENT_EVENTS;
  if (!known.includes(event)) return { outcome: 'ignored' };
  const documentId = event === 'documents.update' ? model.id : model.documentId;
  if (!documentId) return { outcome: 'invalid' };
  return {
    outcome: 'accepted',
    notice: {
      deliveryId: id,
      event: event as OutlineAgentEventName,
      actorId,
      documentId,
      objectId: model.id,
      occurredAt: createdAt,
    },
  };
}
