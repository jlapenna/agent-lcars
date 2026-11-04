import 'server-only';

import { PIPELINES, workTargetSchema } from '@agent-lcars/work';
import { z } from 'zod';

import { workForbiddenReason } from './work-authorization';
import { grantForPrincipal } from './work-grants';

const configSchema = z.strictObject({
  organizationId: z.uuid(),
  routes: z
    .array(
      z.strictObject({
        teamId: z.uuid(),
        labelId: z.uuid(),
        repo: workTargetSchema.shape.repo,
        pipeline: z.enum(PIPELINES),
        principal: z.string().min(1).max(128),
      }),
    )
    .min(1),
});
export type LinearConfig = z.infer<typeof configSchema>;

/** Optional integration; a partially configured integration fails at boot. */
export function linearConfig(): LinearConfig | undefined {
  const raw = process.env['AGENT_LCARS_LINEAR'];
  if (!raw?.trim()) return undefined;
  const parsed = configSchema.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new Error('AGENT_LCARS_LINEAR is invalid', { cause: parsed.error });
  const keys = parsed.data.routes.map(
    (route) => `${route.teamId}/${route.labelId}`,
  );
  if (new Set(keys).size !== keys.length)
    throw new Error('AGENT_LCARS_LINEAR has duplicate team/label routes');
  for (const name of [
    'AGENT_LCARS_LINEAR_WEBHOOK_SECRET',
    'AGENT_LCARS_LINEAR_API_KEY',
  ]) {
    if (!process.env[name]?.trim())
      throw new Error(`${name} is required when AGENT_LCARS_LINEAR is enabled`);
  }
  for (const route of parsed.data.routes) {
    const grant = grantForPrincipal(route.principal);
    if (
      grant?.channel !== 'linear' ||
      !grant.scopes.includes('work.operator')
    ) {
      throw new Error(
        `Linear route ${route.teamId}/${route.labelId} requires a linear work.operator grant`,
      );
    }
    const forbidden = workForbiddenReason(grant, {
      pipeline: route.pipeline,
      target: { repo: route.repo },
    });
    if (forbidden !== undefined) throw new Error(`Linear route: ${forbidden}`);
  }
  return parsed.data;
}
