import 'server-only';

import {
  RECONCILE_OIDC_AUDIENCE,
  RECONCILE_WORKFLOW_PATH,
} from '@agent-lcars/dispatch-reconcile';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';

const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const githubActionsJwks = createRemoteJWKSet(
  new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`),
);

export function assertReconcileOidcClaims(
  claims: JWTPayload,
  repository: string,
): void {
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
}

export async function verifyReconcileOidcToken(
  token: string,
  repository: string,
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, githubActionsJwks, {
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: RECONCILE_OIDC_AUDIENCE,
  });
  assertReconcileOidcClaims(payload, repository);
  return payload;
}
