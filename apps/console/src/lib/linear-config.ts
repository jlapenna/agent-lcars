import 'server-only';

import type { TrackerIssue } from '@agent-lcars/dispatch-contracts';
import { PIPELINES, workTargetSchema } from '@agent-lcars/work';
import { z } from 'zod';

import { workForbiddenReason } from './work-authorization';
import { grantForPrincipal } from './work-grants';

const configSchema = z.strictObject({
  organizationId: z.uuid(),
  operatorIds: z.array(z.uuid()).max(256).optional(),
  teams: z
    .array(
      z.strictObject({
        teamId: z.uuid(),
        name: z.string().min(1).max(128).optional(),
        repo: workTargetSchema.shape.repo.optional(),
        repositories: z
          .array(
            z.strictObject({
              repo: workTargetSchema.shape.repo,
              labelId: z.uuid(),
            }),
          )
          .max(256)
          .optional(),
        states: z
          .strictObject({
            started: z.uuid(),
            parked: z.uuid(),
            failed: z.uuid(),
            canceled: z.uuid(),
            completed: z.uuid(),
          })
          .optional(),
        triage: z
          .strictObject({
            bugLabelIds: z.array(z.uuid()).min(1).max(256),
            readyLabelId: z.uuid(),
            pipeline: z.enum(PIPELINES),
            principal: z.string().min(1).max(128),
          })
          .optional(),
      }),
    )
    .max(256)
    .optional(),
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

/** Metadata can be projected before dispatch. Explicit team bindings also
 * resolve issues which do not yet carry a provider's dispatch label. */
export function linearTeam(config: LinearConfig, teamId: string) {
  const explicit = config.teams?.find((team) => team.teamId === teamId);
  if (explicit) return explicit;
  const repos = [
    ...new Set(
      config.routes
        .filter((route) => route.teamId === teamId)
        .map((route) => route.repo),
    ),
  ];
  return repos.length === 1
    ? { teamId, repo: repos[0] }
    : repos.length > 1
      ? { teamId }
      : undefined;
}

/** Repository labels route metadata/triage independently of provider dispatch
 * labels. Multiple repositories can share a Linear team without guessing. */
export function linearIssueRepository(
  config: LinearConfig,
  issue: TrackerIssue,
): string | undefined {
  const team = linearTeam(config, issue.teamId ?? '');
  if (!team) return undefined;
  const labels = new Set(issue.labels.map((label) => label.id));
  const matches = [
    ...new Set([
      ...config.routes
        .filter(
          (route) => route.teamId === issue.teamId && labels.has(route.labelId),
        )
        .map((route) => route.repo),
      ...('repositories' in team ? (team.repositories ?? []) : [])
        .filter((binding) => labels.has(binding.labelId))
        .map((binding) => binding.repo),
    ]),
  ];
  return matches.length === 1
    ? matches[0]
    : matches.length === 0
      ? team.repo
      : undefined;
}

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
  const teams = parsed.data.teams ?? [];
  if (new Set(teams.map((team) => team.teamId)).size !== teams.length)
    throw new Error('AGENT_LCARS_LINEAR has duplicate team bindings');
  for (const team of teams) {
    for (const binding of team.repositories ?? []) {
      if (
        !parsed.data.routes.some(
          (route) =>
            route.teamId === team.teamId && route.repo === binding.repo,
        )
      )
        throw new Error(
          'Linear repository binding requires a matching dispatch route',
        );
    }
    if (
      !parsed.data.routes.some(
        (route) =>
          route.teamId === team.teamId &&
          (team.repo === undefined || route.repo === team.repo),
      )
    )
      throw new Error('Linear team binding must match a dispatch repository');
  }
  for (const team of teams) {
    if (!team.triage) continue;
    const grant = grantForPrincipal(team.triage.principal);
    if (grant?.channel !== 'linear' || !grant.scopes.includes('work.operator'))
      throw new Error('Linear triage requires a linear work.operator grant');
    const route = parsed.data.routes.find(
      (route) =>
        route.teamId === team.teamId &&
        route.labelId === team.triage?.readyLabelId,
    );
    if (!route || (team.repo !== undefined && route.repo !== team.repo))
      throw new Error(
        'Linear triage ready label requires a matching dispatch route',
      );
    const forbidden = workForbiddenReason(grant, {
      pipeline: team.triage.pipeline,
      target: { repo: route.repo },
    });
    if (forbidden) throw new Error(`Linear triage: ${forbidden}`);
  }
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
