import 'server-only';

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

// Inlined from the now-deleted @agent-lcars/dispatch-reconcile (#1015 Wave
// 4: that lib's scan/discovery/dispatch machinery was only ever consumed by
// the deleted apps/console/src/lib/hosted-reconciler.ts -- these two
// constants were its only surviving live use, verifying the scheduled
// reconciler's OIDC identity for /api/control-plane/reconcile, now served
// by the orchestrator's handleReconcile).
const RECONCILE_OIDC_AUDIENCE = 'agent-lcars-dispatch-reconcile';
const RECONCILE_WORKFLOW_PATH = '.github/workflows/dispatch-reconcile.yml';

// #1215: the internal-workflow request path (any onboarded repo's own
// main-branch automation asking the control plane to work a task, carrying
// `runbook`/`context` dispatch parameters the label-admission webhook has no
// way to express). Audience/claims verified the same way as the reconciler
// route -- see `verifyRequestOidcToken` below.
const REQUEST_OIDC_AUDIENCE = 'agent-lcars-dispatch-request';
/** Internal-caller trigger shapes covered today: sprinkles's four surviving
 *  `agent-router.yml` callers (pr-heal, playbook-unstick-prs, visual-refresh,
 *  post-deploy-verify) run as a mix of these. Not `pull_request`/
 *  `issue_comment`/etc -- those already have a trusted path via the webhook
 *  route; this one is for internal automation with no human-authored event
 *  to admit against. */
const REQUEST_EVENT_NAMES: ReadonlySet<string> = new Set([
  'schedule',
  'workflow_dispatch',
  'workflow_run',
  'push',
]);

/** GitHub Actions callers of the public Work API use its normal audience,
 * then become a normal `github-actions:<repository>` Work grant subject.
 * This is deliberately separate from #1215's legacy request-route audience:
 * phase one is additive so existing callers can migrate without an alias. */
const WORK_API_OIDC_AUDIENCE = 'agent-lcars-work';

const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`),
);

export interface ReconcileOidcIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
}

export interface RequestOidcIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
}

export interface WorkApiOidcIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
}

/** Canonical grant subject for a GitHub Actions caller. The repository is
 * still checked from the signed claims before this value is ever resolved
 * against `AGENT_LCARS_WORK_GRANTS`; there is no provider-specific identity
 * or special-case member repository in the Work API. */
export function githubActionsWorkSubject(repository: string): string {
  return `github-actions:${repository}`;
}

function positiveIntegerClaim(value: unknown, name: string): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`OIDC ${name} claim is not a positive safe integer`);
  }
  return parsed;
}

export function assertReconcileOidcClaims(
  claims: JWTPayload,
  repository: string,
): ReconcileOidcIdentity {
  const expectedWorkflowRef = `${repository}/${RECONCILE_WORKFLOW_PATH}@refs/heads/main`;
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the control plane');
  }
  if (claims['workflow_ref'] !== expectedWorkflowRef) {
    throw new Error('OIDC workflow_ref claim is not the reconciler on main');
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  if (
    !['schedule', 'workflow_dispatch'].includes(String(claims['event_name']))
  ) {
    throw new Error('OIDC event_name claim is not an allowed reconciler event');
  }
  return {
    repository,
    repositoryId: positiveIntegerClaim(
      claims['repository_id'],
      'repository_id',
    ),
    runId: positiveIntegerClaim(claims['run_id'], 'run_id'),
  };
}

export async function verifyReconcileOidcToken(
  token: string,
  repository: string,
): Promise<ReconcileOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: RECONCILE_OIDC_AUDIENCE,
  });
  return assertReconcileOidcClaims(payload, repository);
}

// Sub-project 6 (2026-08-27-native-work-items-8-sessions, Task 8): the
// session-pin-tick trigger for the session reaper sweep -- rewrites
// expireAt forward on sessions belonging to still-open items so the
// collection's Firestore TTL policy never reaps them out from under a
// live item. Same shape as the schedule-tick verifier above: one
// canonical caller, pinned to the control-plane home, not the allow-list.
const SESSION_PIN_TICK_OIDC_AUDIENCE = 'agent-lcars-session-pin-tick';
const SESSION_PIN_TICK_WORKFLOW_PATH =
  '.github/workflows/work-session-pin-tick.yml';

export interface SessionPinTickOidcIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
}

export function assertSessionPinTickOidcClaims(
  claims: JWTPayload,
  repository: string,
): SessionPinTickOidcIdentity {
  const expectedJobWorkflowRef = `${repository}/${SESSION_PIN_TICK_WORKFLOW_PATH}@refs/heads/main`;
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the control plane');
  }
  if (claims['job_workflow_ref'] !== expectedJobWorkflowRef) {
    throw new Error(
      'OIDC job_workflow_ref claim is not the session pin tick workflow on main',
    );
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  if (
    !['schedule', 'workflow_dispatch'].includes(String(claims['event_name']))
  ) {
    throw new Error(
      'OIDC event_name claim is not an allowed session-pin-tick event',
    );
  }
  return {
    repository,
    repositoryId: positiveIntegerClaim(
      claims['repository_id'],
      'repository_id',
    ),
    runId: positiveIntegerClaim(claims['run_id'], 'run_id'),
  };
}

export async function verifySessionPinTickOidcToken(
  token: string,
  repository: string,
): Promise<SessionPinTickOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: SESSION_PIN_TICK_OIDC_AUDIENCE,
  });
  return assertSessionPinTickOidcClaims(payload, repository);
}

/**
 * `workflow_ref` names ANY workflow file in this repository's own
 * `.github/workflows/` on `main` -- not one pinned path, unlike the
 * reconciler's canonical scheduler. #1215's request endpoint
 * exists precisely because the callers are NOT one shared workflow: they are
 * an open-ended set of a repo's own internal automation (sprinkles's
 * pr-heal, playbook-unstick-prs, visual-refresh, post-deploy-verify today;
 * more later without a change here).
 *
 * This is safe to leave open because `main` is protected by this
 * deployment's own branch-protection ruleset (required review, required
 * `Verify` check -- see AGENTS.md) for every allow-listed repository: a
 * workflow file that reached `main` is repo-maintainer-controlled code, not
 * attacker-controlled input. Trusting "some workflow this repo's maintainer
 * reviewed onto main" is not materially weaker than trusting one specific
 * pinned filename -- both ultimately rest on the same protected-branch
 * guarantee. Requiring `ref: refs/heads/main` (checked separately) is what
 * makes this guarantee hold: a workflow file on an unprotected branch or in
 * a fork PR never reaches this claim shape.
 */
function isOwnWorkflowRefOnMain(
  workflowRef: unknown,
  repository: string,
): boolean {
  if (typeof workflowRef !== 'string') return false;
  const prefix = `${repository}/.github/workflows/`;
  const suffix = '@refs/heads/main';
  if (!workflowRef.startsWith(prefix) || !workflowRef.endsWith(suffix)) {
    return false;
  }
  const file = workflowRef.slice(
    prefix.length,
    workflowRef.length - suffix.length,
  );
  // Exactly one path segment (no nested `/`), naming a real workflow file --
  // guards against a claim shape this repo's own workflows would never
  // produce rather than defending against a signed-token forgery (the
  // signature already rules that out).
  return file.length > 0 && !file.includes('/') && /\.ya?ml$/u.test(file);
}

export function assertRequestOidcClaims(
  claims: JWTPayload,
  repository: string,
): RequestOidcIdentity {
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the control plane');
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  if (!REQUEST_EVENT_NAMES.has(String(claims['event_name']))) {
    throw new Error('OIDC event_name claim is not an allowed request event');
  }
  if (!isOwnWorkflowRefOnMain(claims['workflow_ref'], repository)) {
    throw new Error(
      'OIDC workflow_ref claim is not a workflow of this repository on main',
    );
  }
  return {
    repository,
    repositoryId: positiveIntegerClaim(
      claims['repository_id'],
      'repository_id',
    ),
    runId: positiveIntegerClaim(claims['run_id'], 'run_id'),
  };
}

/**
 * Verifies signature/issuer/audience, then checks the *claimed* repository
 * against the allow-list before running the per-repo claim assertions.
 * Every allow-listed repository is trusted to request work through its own workflows on
 * `main`; see {@link isOwnWorkflowRefOnMain} for why that's safe.
 */
export async function verifyRequestOidcToken(
  token: string,
  allowedRepositories: string[],
): Promise<RequestOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: REQUEST_OIDC_AUDIENCE,
  });
  const claimedRepository = payload['repository'];
  if (
    typeof claimedRepository !== 'string' ||
    !allowedRepositories.includes(claimedRepository)
  ) {
    throw new Error(
      'OIDC repository claim is not an allow-listed control-plane repository',
    );
  }
  return assertRequestOidcClaims(payload, claimedRepository);
}

/** Work API equivalent of the legacy request-route claim policy: any
 * protected-main workflow belonging to an allow-listed repository may ask to
 * dispatch its own GitHub anchor. Authorization after this cryptographic
 * verification is the ordinary Work principal/grant lookup. */
export function assertWorkApiOidcClaims(
  claims: JWTPayload,
  repository: string,
): WorkApiOidcIdentity {
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the Work API caller');
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  if (!REQUEST_EVENT_NAMES.has(String(claims['event_name']))) {
    throw new Error('OIDC event_name claim is not an allowed Work API event');
  }
  if (!isOwnWorkflowRefOnMain(claims['workflow_ref'], repository)) {
    throw new Error(
      'OIDC workflow_ref claim is not a workflow of this repository on main',
    );
  }
  return {
    repository,
    repositoryId: positiveIntegerClaim(
      claims['repository_id'],
      'repository_id',
    ),
    runId: positiveIntegerClaim(claims['run_id'], 'run_id'),
  };
}

export async function verifyWorkApiOidcToken(
  token: string,
  allowedRepositories: string[],
): Promise<WorkApiOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: WORK_API_OIDC_AUDIENCE,
  });
  const claimedRepository = payload['repository'];
  if (
    typeof claimedRepository !== 'string' ||
    !allowedRepositories.includes(claimedRepository)
  ) {
    throw new Error(
      'OIDC repository claim is not an allow-listed control-plane repository',
    );
  }
  return assertWorkApiOidcClaims(payload, claimedRepository);
}
