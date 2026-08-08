import {
  RECONCILE_OIDC_AUDIENCE,
  RECONCILE_WORKFLOW_PATH,
} from '@agent-lcars/dispatch-reconcile';
import { describe, expect, it } from 'vitest';

import { assertReconcileOidcClaims } from './github-actions-oidc';

const repository = 'jlapenna/agent-lcars';
const validClaims = {
  aud: RECONCILE_OIDC_AUDIENCE,
  repository,
  workflow_ref: `${repository}/${RECONCILE_WORKFLOW_PATH}@refs/heads/main`,
  ref: 'refs/heads/main',
  event_name: 'schedule',
};

describe('GitHub Actions reconciler OIDC claims', () => {
  it('accepts the scheduled and manual reconciler workflow on main', () => {
    expect(() =>
      assertReconcileOidcClaims(validClaims, repository),
    ).not.toThrow();
    expect(() =>
      assertReconcileOidcClaims(
        { ...validClaims, event_name: 'workflow_dispatch' },
        repository,
      ),
    ).not.toThrow();
  });

  it.each([
    [{ ...validClaims, repository: 'attacker/fork' }, 'repository'],
    [
      {
        ...validClaims,
        workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      },
      'workflow_ref',
    ],
    [{ ...validClaims, ref: 'refs/heads/feature' }, 'ref'],
    [{ ...validClaims, event_name: 'pull_request' }, 'event_name'],
  ])('rejects a caller with the wrong %s claim', (claims, field) => {
    expect(() => assertReconcileOidcClaims(claims, repository)).toThrow(field);
  });
});
