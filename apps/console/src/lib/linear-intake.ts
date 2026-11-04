import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  storedWorkPayloadSchema,
  ulid,
  WORK_TITLE_MAX,
} from '@agent-lcars/work';
import { z } from 'zod';

import type { LinearConfig } from './linear-config';
import { normalizeWorkPayload } from './work-from-github';
import { grantForPrincipal } from './work-grants';
import { mintItem, type WorkContext } from './work-mint';

const envelopeSchema = z.object({
  type: z.string(),
  action: z.string(),
  organizationId: z.uuid(),
  webhookTimestamp: z.number().int(),
});
const issueSchema = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  identifier: z.string().min(1).max(128),
  title: z.string().min(1),
  description: z.string().nullish(),
  url: z.url().refine((url) => new URL(url).origin === 'https://linear.app'),
  labelIds: z.array(z.uuid()),
  archivedAt: z.string().nullish(),
  completedAt: z.string().nullish(),
  canceledAt: z.string().nullish(),
  trashed: z.boolean().optional(),
});

export function verifyLinearSignature(
  body: Buffer,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^[a-f\d]{64}$/iu.test(signature)) return false;
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    createHmac('sha256', secret).update(body).digest(),
  );
}

export type LinearIntakeResult = {
  status: number;
  body: Record<string, unknown>;
};

/** One immutable Work item per Linear issue, including after webhook retries,
 * edits, label removal/re-addition, and concurrent deliveries. */
export async function admitLinearWebhook(
  rawBody: Buffer,
  config: LinearConfig,
  runtime: WorkContext['runtime'],
  now = Date.now(),
): Promise<LinearIntakeResult> {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'Malformed JSON' } };
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success)
    return { status: 400, body: { error: 'Malformed Linear event' } };
  if (Math.abs(now - envelope.data.webhookTimestamp) > 60_000)
    return { status: 401, body: { error: 'Stale Linear event' } };
  const ignored = (reason: string): LinearIntakeResult => ({
    status: 200,
    body: { outcome: 'ignored', reason },
  });
  if (envelope.data.organizationId !== config.organizationId)
    return ignored('organization outside integration');
  if (
    envelope.data.type !== 'Issue' ||
    !['create', 'update'].includes(envelope.data.action)
  )
    return ignored('unsupported event');
  const issue = issueSchema.safeParse(
    (json as Record<string, unknown>)['data'],
  );
  if (!issue.success)
    return { status: 400, body: { error: 'Malformed Linear issue' } };
  const data = issue.data;
  if (data.archivedAt || data.completedAt || data.canceledAt || data.trashed)
    return ignored('inactive issue');
  const routes = config.routes.filter(
    (route) =>
      route.teamId === data.teamId && data.labelIds.includes(route.labelId),
  );
  if (routes.length === 0) return ignored('no matching route');
  if (routes.length !== 1)
    return ignored('multiple matching routes; select one dispatch label');
  const route = routes[0];
  const grant = grantForPrincipal(route.principal);
  if (grant?.channel !== 'linear' || !grant.scopes.includes('work.operator'))
    return {
      status: 403,
      body: { error: 'Linear work.operator grant required' },
    };
  // Source mapping is transactionally resolved by the existing durable store.
  const id = await runtime.store.resolveSourceWorkId(
    `linear:${config.organizationId}:${data.id}`,
    ulid(),
  );
  const thread = JSON.stringify({
    organizationId: config.organizationId,
    issueId: data.id,
  });
  const existingResult = async (): Promise<LinearIntakeResult | undefined> => {
    const existing = await runtime.store.readTask({ workId: id });
    if (existing === undefined) return undefined;
    const origin = storedWorkPayloadSchema.parse(existing.task.work).origin;
    if (origin.channel !== 'linear' || origin.thread !== thread)
      throw new Error(
        'Linear source mapping does not match stored Work origin',
      );
    return { status: 200, body: { outcome: 'existing', itemId: id } };
  };
  const existing = await existingResult();
  if (existing !== undefined) return existing;
  const work = normalizeWorkPayload({
    origin: { principal: grant.principal, channel: 'linear', thread },
    spec: {
      title: `${data.identifier}: ${data.title}`.slice(0, WORK_TITLE_MAX),
      description: `Linear issue: ${data.url}\n\n${data.description ?? '(No description provided.)'}`,
      pipeline: route.pipeline,
      target: { repo: route.repo },
    },
  });
  // Admission is durable before acknowledging Linear. The route drains after
  // the response so external dispatch does not consume Linear's response budget.
  const result = await mintItem(
    {
      runtime: {
        ...runtime,
        drain: async () => ({ dispatched: [], reported: [], failed: [] }),
      },
    },
    {
      id,
      spec: work.spec,
      origin: work.origin,
      grantsPrincipal: grant,
    },
  );
  if (result.kind === 'forbidden')
    return { status: 403, body: { error: result.message } };
  if (result.kind === 'conflict') {
    // Another delivery can win between our read and the mint transaction.
    const winner = await existingResult();
    if (winner !== undefined) return winner;
    throw new Error(`Linear admission conflict: ${result.message}`);
  }
  // A concurrent mint may have observed an existing task after our read.
  // Bind that result to the Linear source as well as the Work specification.
  const admitted = await existingResult();
  if (admitted === undefined)
    throw new Error('Linear Work admission was not durable');
  return {
    status: 200,
    body: { outcome: result.kind, itemId: id },
  };
}
