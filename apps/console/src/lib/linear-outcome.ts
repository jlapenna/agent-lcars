import 'server-only';

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { issueTracker, parseLinearIssueThread } from './issue-trackers';
import { linearQuery } from './linear-client';
import type { OutcomeWebhookPayload } from './outcome-webhook';

const lookupSchema = z.object({
  organization: z.object({ id: z.uuid() }),
  comments: z.object({
    nodes: z.array(
      z.object({ id: z.uuid(), issue: z.object({ id: z.uuid() }).nullable() }),
    ),
  }),
});

/** Stable UUID v4 per outbox event: a successful API write followed by a lost
 * response is found on retry, including when two drain leases overlap. */
function commentId(payload: OutcomeWebhookPayload): string {
  const bytes = createHash('sha256')
    .update(
      JSON.stringify([
        'lcars-linear-outcome',
        payload.itemId,
        payload.runId,
        payload.eventId ?? 'execution',
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function deliverLinearOutcome(
  payload: OutcomeWebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const thread = parseLinearIssueThread(payload.thread);
  const id = commentId(payload);
  const lookup = lookupSchema.parse(
    await linearQuery(
      `query LcarsOutcome($id: ID!, $includeArchived: Boolean!) {
    organization { id }
    comments(filter: { id: { eq: $id } }, first: 1, includeArchived: $includeArchived) { nodes { id issue { id } } }
  }`,
      { id, includeArchived: true },
      fetchImpl,
    ),
  );
  if (lookup.organization.id !== thread.organizationId)
    throw new Error('Linear outcome token belongs to a different organization');
  if (lookup.comments.nodes.length > 0) {
    if (
      lookup.comments.nodes[0].id !== id ||
      lookup.comments.nodes[0].issue?.id !== thread.issueId
    )
      throw new Error('Linear outcome comment belongs to a different issue');
    return;
  }
  const status =
    payload.deliveryStage === 'complete'
      ? 'Delivery complete'
      : payload.reroutedTo
        ? `Rerouted to ${payload.reroutedTo.pipeline}`
        : payload.parked
          ? 'Needs input'
          : payload.state === 'canceled'
            ? 'Canceled'
            : payload.ok
              ? 'Execution finished'
              : 'Execution failed';
  const body = [
    '<!-- agent-lcars:outcome -->',
    `**LCARS — ${status}**`,
    payload.message,
    payload.ref ? `Result: ${payload.ref}` : undefined,
    `Work: ${payload.consoleUrl}`,
    `Run: \`${payload.runId}\``,
  ]
    .filter((part) => part !== undefined)
    .join('\n\n');
  await issueTracker({ fetchImpl }).comment(thread, id, body);
}
