import 'server-only';

import {
  storedWorkPayloadSchema,
  WORK_ID_PATTERN,
  workRepository,
} from '@agent-lcars/work';

import { isControlPlaneRepository } from './deployment';
import type { WorkPrincipal } from './work-auth';

export interface WorkAuthority {
  principal: string;
  pipelines: readonly string[];
  sourceRepository?: string;
}

/** Repository identity is a restriction on authority, never another grant.
 * Use this for every resource, including persisted resources and replay. */
export function repositoryForbiddenReason(
  authority: { sourceRepository?: string },
  repository: string,
  admitted: (repository: string) => boolean = isControlPlaneRepository,
): string | undefined {
  if (!admitted(repository))
    return `native work items can only target a control-plane repository (${repository} is not admitted)`;
  if (
    authority.sourceRepository !== undefined &&
    authority.sourceRepository.toLowerCase() !== repository.toLowerCase()
  )
    return 'Caller repository does not match target repository';
  return undefined;
}

/** Shared capability policy for native work and platform adapters. */
export function workForbiddenReason(
  authority: WorkAuthority,
  spec: { pipeline: string; target?: { repo: string } },
): string | undefined {
  if (!authority.pipelines.includes(spec.pipeline))
    return `${authority.principal} may not request pipeline ${spec.pipeline}`;
  return repositoryForbiddenReason(authority, workRepository(spec));
}

/** Bind a service's live grant lookup to one request without changing its
 * shared runtime. Both restrictions apply on every call/transaction. */
export function scopedWorkGrant(
  authority: WorkAuthority,
  granted: (principal: string, repository: string) => boolean,
): (principal: string, repository: string) => boolean {
  return (principal, repository) =>
    principal === authority.principal &&
    repositoryForbiddenReason(authority, repository) === undefined &&
    granted(principal, repository);
}

/** Operations whose resource access is bound to the common policy below.
 * A new API operation is unavailable to repository-bound identities until its
 * resource binding is declared here. This is admission, not a replacement for
 * the transaction-time policy checks in its owning service. */
const workIdPattern = WORK_ID_PATTERN.source.slice(1, -1);
const repositoryBoundOperations: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/(?:items|schedules|jobs)$/u],
  ['GET', /^\/anchors\/github\/owner$/u],
  ['GET', new RegExp(`^/items/${workIdPattern}$`, 'u')],
  ['PUT', new RegExp(`^/items/${workIdPattern}$`, 'u')],
  ['PATCH', new RegExp(`^/items/${workIdPattern}$`, 'u')],
  [
    'POST',
    new RegExp(`^/items/${workIdPattern}/(?:cancel|redispatch|reply)$`, 'u'),
  ],
  ['GET', new RegExp(`^/schedules/${workIdPattern}$`, 'u')],
  ['PUT', new RegExp(`^/schedules/${workIdPattern}$`, 'u')],
  ['PATCH', new RegExp(`^/schedules/${workIdPattern}$`, 'u')],
  ['DELETE', new RegExp(`^/schedules/${workIdPattern}$`, 'u')],
  ['POST', new RegExp(`^/schedules/${workIdPattern}/(?:enable|disable)$`, 'u')],
  ['POST', /^\/dispatches\/github(?:\/redispatch)?$/u],
  ['GET', /^\/jobs\/occurrences\/[a-f0-9]{64}$/u],
  ['POST', /^\/jobs\/(?:refresh|invoke)$/u],
  ['POST', /^\/jobs\/[a-f0-9]{64}\/(?:enable|invoke)$/u],
];

/** Cookie authority requires same-origin writes across the entire Work API.
 * Bearer and run-token authentication retain their existing contracts. */
export function workRequestForbiddenReason(
  request: Request,
  principal: WorkPrincipal | undefined,
): string | undefined {
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    principal?.via === 'session' &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return 'Same-origin request required';
  if (principal?.sourceRepository !== undefined) {
    const path = new URL(request.url).pathname.slice('/api/work/v1'.length);
    if (
      !repositoryBoundOperations.some(
        ([method, pattern]) => method === request.method && pattern.test(path),
      )
    )
      return 'Operation does not declare repository-bound access';
  }
  return undefined;
}

/** Repository-bound callers cannot inspect or mutate another repository's
 * persisted work. Unbound operators/reapers retain their existing read scope,
 * including source-managed summaries that have no repository target. */
export function mayAccessStoredWork(
  authority: { sourceRepository?: string },
  work: unknown,
): boolean {
  if (authority.sourceRepository === undefined) return true;
  const parsed = storedWorkPayloadSchema.safeParse(work);
  return (
    parsed.success &&
    repositoryForbiddenReason(authority, workRepository(parsed.data.spec)) ===
      undefined
  );
}
