import 'server-only';

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { OutcomeWebhookPayload } from './outcome-webhook';

const threadSchema = z.strictObject({
  organizationId: z.uuid(),
  issueId: z.uuid(),
});
const lookupSchema = z.object({
  organization: z.object({ id: z.uuid() }),
  comments: z.object({
    nodes: z.array(
      z.object({ id: z.uuid(), issue: z.object({ id: z.uuid() }).nullable() }),
    ),
  }),
});
const createSchema = z.object({
  commentCreate: z.object({
    success: z.boolean(),
    comment: z
      .object({ id: z.uuid(), issue: z.object({ id: z.uuid() }).nullable() })
      .nullable(),
  }),
});

async function linearQuery(
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const token = process.env['AGENT_LCARS_LINEAR_API_KEY']?.trim();
  if (!token)
    throw new Error(
      'AGENT_LCARS_LINEAR_API_KEY is required for Linear outcome delivery',
    );
  const response = await fetchImpl('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Linear API returned ${response.status}`);
  const result = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.unknown()).optional(),
    })
    .parse(await response.json());
  // Do not log API error bodies, which may contain issue content or credentials.
  if (result.errors?.length || result.data === undefined)
    throw new Error('Linear GraphQL operation failed');
  return result.data;
}

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
  const thread = threadSchema.parse(JSON.parse(payload.thread));
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
    `**LCARS — ${status}**`,
    payload.message,
    payload.ref ? `Result: ${payload.ref}` : undefined,
    `Work: ${payload.consoleUrl}`,
    `Run: \`${payload.runId}\``,
  ]
    .filter((part) => part !== undefined)
    .join('\n\n');
  const created = createSchema.parse(
    await linearQuery(
      `mutation LcarsOutcomeComment($input: CommentCreateInput!) {
    commentCreate(input: $input) { success comment { id issue { id } } }
  }`,
      { input: { id, issueId: thread.issueId, body } },
      fetchImpl,
    ),
  );
  if (
    !created.commentCreate.success ||
    created.commentCreate.comment?.id !== id ||
    created.commentCreate.comment.issue?.id !== thread.issueId
  )
    throw new Error('Linear outcome comment was not confirmed');
}
