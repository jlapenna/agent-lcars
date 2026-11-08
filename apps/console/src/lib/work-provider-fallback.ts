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
import { repositoryForbiddenReason } from './work-authorization';
import { grantForPrincipal, type WorkGrant, workGrants } from './work-grants';

/** Synthetic principal recorded on signed GitHub webhook PR review admissions
 * so quota/cooldown fallback can re-verify repository admission andreview-mode
 * scope without requiring an operator Work grant. */
export const GITHUB_PR_REVIEW_PRINCIPAL = 'svc:github-pr-review';

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

export function authorizeGithubReviewProviderFallback(
  repository: string,
  pipeline: string,
  alternatives: readonly string[] | undefined,
): ProviderFallbackRequest | undefined {
  return authorizeProviderFallback(
    {
      principal: GITHUB_PR_REVIEW_PRINCIPAL,
      pipelines: PIPELINES,
      sourceRepository: repository,
    },
    pipeline,
    alternatives,
  );
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
  const payload = workPayloadSchema.safeParse(task.work);
  if (!payload.success) return [];
  const repository = payload.data.spec.target.repo;
  if (
    repositoryForbiddenReason(policy, repository, repositoryAdmitted) !==
      undefined ||
    (!isWorkAnchor(task.task) && task.task.repo !== repository)
  )
    return [];
  if (policy.principal === GITHUB_PR_REVIEW_PRINCIPAL) {
    if (
      run.params?.['mode'] !== 'review' ||
      payload.data.origin.channel !== 'github' ||
      isWorkAnchor(task.task)
    )
      return [];
    return PIPELINES.filter((pipeline) =>
      policy.allowedPipelines.includes(pipeline),
    );
  }
  const grant = grantForPrincipal(policy.principal, grants);
  if (grant === undefined || !grant.scopes.includes('work.operator')) return [];
  return grant.pipelines.filter((pipeline) =>
    policy.allowedPipelines.includes(pipeline),
  );
}

export const providerFallbackAuthority: ProviderFallbackAuthority = {
  pipelines: PIPELINES,
  allowedPipelines: (task, run) =>
    currentFallbackPipelines(task, run, workGrants(), isControlPlaneRepository),
};
