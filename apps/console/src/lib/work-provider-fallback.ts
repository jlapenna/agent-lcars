import 'server-only';

import {
  isWorkAnchor,
  type ProviderFallbackAuthority,
  type ProviderFallbackRequest,
  type Run,
  type Task,
} from '@agent-lcars/orchestrator';
import {
  fallbackPipelinesSchema,
  PIPELINES,
  workPayloadSchema,
} from '@agent-lcars/work';

import { isControlPlaneRepository } from './deployment';
import { grantForPrincipal, type WorkGrant, workGrants } from './work-grants';

/** A trusted ingress supplies identity; callers supply only ordered choices. */
export function authorizeProviderFallback(
  principal: {
    principal: string;
    pipelines: readonly string[];
    sourceRepository?: string;
  },
  pipeline: string,
  alternatives: readonly string[] | undefined,
): ProviderFallbackRequest | undefined {
  if (alternatives === undefined) return undefined;
  const allowedPipelines = fallbackPipelinesSchema
    .parse(alternatives)
    .filter(
      (candidate) =>
        candidate !== pipeline && principal.pipelines.includes(candidate),
    );
  if (allowedPipelines.length === 0) return undefined;
  return {
    principal: principal.principal,
    allowedPipelines,
    ...(principal.sourceRepository === undefined
      ? {}
      : { sourceRepository: principal.sourceRepository }),
  };
}

/** Re-resolve authority for each decision, including scope/repository removal.
 * The original policy is an upper bound, never a grant for a future attempt. */
export function currentFallbackPipelines(
  task: Task,
  run: Run,
  grants: WorkGrant[],
  repositoryAdmitted: (repository: string) => boolean,
): readonly string[] {
  const policy = run.providerFallback;
  if (policy === undefined) return [];
  const grant = grantForPrincipal(policy.principal, grants);
  if (grant === undefined || !grant.scopes.includes('work.operator')) return [];
  const payload = workPayloadSchema.safeParse(task.work);
  if (!payload.success) return [];
  const repository = payload.data.spec.target.repo;
  if (
    !repositoryAdmitted(repository) ||
    (!isWorkAnchor(task.task) && task.task.repo !== repository) ||
    (policy.sourceRepository !== undefined &&
      policy.sourceRepository !== repository)
  )
    return [];
  return grant.pipelines.filter((pipeline) =>
    policy.allowedPipelines.includes(pipeline),
  );
}

export const providerFallbackAuthority: ProviderFallbackAuthority = {
  pipelines: PIPELINES,
  allowedPipelines: (task, run) =>
    currentFallbackPipelines(task, run, workGrants(), isControlPlaneRepository),
};
