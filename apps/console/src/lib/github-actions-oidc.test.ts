import {
  COMPLETION_FINALIZER_WORKFLOW_PATH,
  COMPLETION_OIDC_AUDIENCE,
} from '@agent-lcars/dispatch-contracts';
import {
  RECONCILE_OIDC_AUDIENCE,
  RECONCILE_WORKFLOW_PATH,
} from '@agent-lcars/dispatch-reconcile';
import { describe, expect, it } from 'vitest';

import {
  assertCompletionOidcClaims,
  assertReconcileOidcClaims,
} from './github-actions-oidc';

const repository = 'jlapenna/agent-lcars';
const validClaims = {
  aud: RECONCILE_OIDC_AUDIENCE,
  repository,
  repository_id: '1307149765',
  run_id: '93099054125',
  workflow_ref: `${repository}/${RECONCILE_WORKFLOW_PATH}@refs/heads/main`,
  ref: 'refs/heads/main',
  event_name: 'schedule',
};

describe('GitHub Actions reconciler OIDC claims', () => {
  it('accepts the scheduled and manual reconciler workflow on main', () => {
    expect(assertReconcileOidcClaims(validClaims, repository)).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
    expect(
      assertReconcileOidcClaims(
        { ...validClaims, event_name: 'workflow_dispatch' },
        repository,
      ),
    ).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
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
    [{ ...validClaims, repository_id: 'not-a-number' }, 'repository_id'],
    [{ ...validClaims, run_id: '0' }, 'run_id'],
  ])('rejects a caller with the wrong %s claim', (claims, field) => {
    expect(() => assertReconcileOidcClaims(claims, repository)).toThrow(field);
  });
});

describe('GitHub Actions completion OIDC claims', () => {
  const completionClaims = {
    aud: COMPLETION_OIDC_AUDIENCE,
    repository,
    repository_id: '1307149765',
    run_id: '93099054125',
    workflow_ref: `${repository}/.github/workflows/codex.yml@refs/heads/main`,
    job_workflow_ref: `${repository}/${COMPLETION_FINALIZER_WORKFLOW_PATH}@refs/heads/main`,
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
  };

  it('derives immutable worker identity from signed claims', () => {
    expect(assertCompletionOidcClaims(completionClaims, repository)).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
      workflow: 'codex.yml',
    });
  });

  it.each([
    [{ ...completionClaims, repository: 'attacker/fork' }, 'repository'],
    [{ ...completionClaims, ref: 'refs/heads/feature' }, 'ref'],
    [{ ...completionClaims, event_name: 'pull_request' }, 'event_name'],
    [{ ...completionClaims, job_workflow_ref: undefined }, 'job_workflow_ref'],
    [
      {
        ...completionClaims,
        job_workflow_ref: `${repository}/.github/workflows/codex.yml@refs/heads/main`,
      },
      'job_workflow_ref',
    ],
    [
      {
        ...completionClaims,
        workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      },
      'workflow_ref',
    ],
    [{ ...completionClaims, repository_id: 'not-a-number' }, 'repository_id'],
    [{ ...completionClaims, run_id: '0' }, 'run_id'],
  ])('rejects a completion caller with the wrong %s claim', (claims, field) => {
    expect(() => assertCompletionOidcClaims(claims, repository)).toThrow(field);
  });
});
