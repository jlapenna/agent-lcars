import 'server-only';

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

/** GitHub Actions Work-dispatch event shapes. Not `pull_request`/
 *  `issue_comment`/etc -- those already have a trusted path via the webhook
 *  route; this is for repository automation with no human-authored event to
 *  admit against. */
const WORK_API_EVENT_NAMES: ReadonlySet<string> = new Set([
  'schedule',
  'workflow_dispatch',
  'workflow_run',
  'push',
]);

/** GitHub Actions callers of the public Work API use its normal audience,
 * then become a normal `github-actions:<repository>` Work grant subject. */
const WORK_API_OIDC_AUDIENCE = 'agent-lcars-work';

const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`),
);

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

// The session-expiry workflow: applies a native work item's lifecycle to
// its telemetry session docs (no expireAt while open, close + retention
// once closed). Dispatched by the console on item close or reopen, never
// scheduled. One canonical caller, pinned to the control-plane home, not
// the allow-list.
const SESSION_EXPIRY_OIDC_AUDIENCE = 'agent-lcars-session-expiry';
export const SESSION_EXPIRY_WORKFLOW_FILE = 'work-session-expiry.yml';
const SESSION_EXPIRY_WORKFLOW_PATH = `.github/workflows/${SESSION_EXPIRY_WORKFLOW_FILE}`;

export interface SessionExpiryOidcIdentity {
  repository: string;
  repositoryId: number;
  runId: number;
}

export function assertSessionExpiryOidcClaims(
  claims: JWTPayload,
  repository: string,
): SessionExpiryOidcIdentity {
  const expectedJobWorkflowRef = `${repository}/${SESSION_EXPIRY_WORKFLOW_PATH}@refs/heads/main`;
  if (claims['repository'] !== repository) {
    throw new Error('OIDC repository claim does not match the control plane');
  }
  if (claims['job_workflow_ref'] !== expectedJobWorkflowRef) {
    throw new Error(
      'OIDC job_workflow_ref claim is not the session expiry workflow on main',
    );
  }
  if (claims['ref'] !== 'refs/heads/main') {
    throw new Error('OIDC ref claim is not main');
  }
  if (claims['event_name'] !== 'workflow_dispatch') {
    throw new Error(
      'OIDC event_name claim is not an allowed session-expiry event',
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

export async function verifySessionExpiryOidcToken(
  token: string,
  repository: string,
): Promise<SessionExpiryOidcIdentity> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: SESSION_EXPIRY_OIDC_AUDIENCE,
  });
  return assertSessionExpiryOidcClaims(payload, repository);
}

/**
 * `workflow_ref` names ANY workflow file in this repository's own
 * `.github/workflows/` on `main` -- not one pinned path, unlike the
 * reconciler's canonical scheduler. GitHub-anchor Work dispatch supports an
 * open-ended set of a repository's own maintained automation.
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
function isWorkApiWorkflowRefOnMain(
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

/** Any protected-main workflow belonging to an allow-listed repository may
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
  if (!WORK_API_EVENT_NAMES.has(String(claims['event_name']))) {
    throw new Error('OIDC event_name claim is not an allowed Work API event');
  }
  if (!isWorkApiWorkflowRefOnMain(claims['workflow_ref'], repository)) {
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
      'OIDC repository claim is not an allow-listed Work API repository',
    );
  }
  return assertWorkApiOidcClaims(payload, claimedRepository);
}
