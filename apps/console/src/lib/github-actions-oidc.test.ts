import { errors as joseErrors } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { JWTClaimValidationFailed, JWTExpired } = joseErrors;

// OIDC verification needs to be exercised end-to-end -- including the
// jwtVerify call -- without a real GitHub OIDC token or network JWKS fetch.
// Only `jwtVerify` is replaced; the real
// `createRemoteJWKSet` is harmless to construct (it fetches lazily, only on
// first `jwtVerify` call) and every other test in this file already relies
// on it working unmocked.
const { jwtVerify } = vi.hoisted(() => ({ jwtVerify: vi.fn() }));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, jwtVerify };
});

import {
  assertReconcileOidcClaims,
  assertRequestOidcClaims,
  assertSessionPinTickOidcClaims,
  verifyReconcileOidcToken,
  verifyRequestOidcToken,
} from './github-actions-oidc';

// Matches the constants inlined into github-actions-oidc.ts (formerly
// @agent-lcars/dispatch-reconcile, deleted in #1015 Wave 4).
const RECONCILE_OIDC_AUDIENCE = 'agent-lcars-dispatch-reconcile';
const RECONCILE_WORKFLOW_PATH = '.github/workflows/dispatch-reconcile.yml';

// Matches the constant inlined into github-actions-oidc.ts for #1215's
// internal-workflow request path.
const REQUEST_OIDC_AUDIENCE = 'agent-lcars-dispatch-request';

const repository = 'jlapenna/agent-lcars';
// #1190: a second repository admitted only once it is added to the
// allow-list -- see deployment.ts's `controlPlaneRepositories`/
// `isControlPlaneRepository`. Not the home repo, so unset env in these
// tests still resolves `controlPlaneRepository()` (the control plane's home)
// to `repository` above.
const secondRepo = 'other-org/other-repo';

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

// `verifyReconcileOidcToken` never wraps `jwtVerify`'s own rejection -- these
// guard that a token jose itself
// refuses (wrong audience, expired) propagates as a rejection rather than
// being swallowed or mis-mapped. Real claim-shape enforcement (repository,
// ref, event_name, ...) is exercised directly against `assertReconcileOidcClaims`
// above; jose's own audience/expiry checks are its own library's concern, not
// this repo's.
describe('verifyReconcileOidcToken', () => {
  afterEach(() => {
    jwtVerify.mockReset();
  });

  it('rejects a token bearing the wrong audience', async () => {
    jwtVerify.mockRejectedValue(
      new JWTClaimValidationFailed(
        'unexpected "aud" claim value',
        validClaims,
        'aud',
        'check_failed',
      ),
    );
    await expect(verifyReconcileOidcToken('token', repository)).rejects.toThrow(
      'aud',
    );
  });

  it('rejects an expired token', async () => {
    jwtVerify.mockRejectedValue(
      new JWTExpired(
        '"exp" claim timestamp check failed',
        validClaims,
        'exp',
        'check_failed',
      ),
    );
    await expect(verifyReconcileOidcToken('token', repository)).rejects.toThrow(
      'exp',
    );
  });
});

// Sub-project 6 (Task 8): the session-pin-tick trigger for the session
// reaper sweep -- same claim shape as the schedule-tick trigger above,
// pinned to its own workflow file.
const SESSION_PIN_TICK_OIDC_AUDIENCE = 'agent-lcars-session-pin-tick';
const SESSION_PIN_TICK_WORKFLOW_PATH =
  '.github/workflows/work-session-pin-tick.yml';

const sessionPinTickClaims = {
  aud: SESSION_PIN_TICK_OIDC_AUDIENCE,
  repository,
  repository_id: '1307149765',
  run_id: '93099054200',
  job_workflow_ref: `${repository}/${SESSION_PIN_TICK_WORKFLOW_PATH}@refs/heads/main`,
  ref: 'refs/heads/main',
  event_name: 'schedule',
};

describe('GitHub Actions session-pin-tick OIDC claims', () => {
  it('accepts the scheduled and manual tick workflow on main', () => {
    expect(
      assertSessionPinTickOidcClaims(sessionPinTickClaims, repository),
    ).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_200,
    });
  });

  it.each([
    [{ ...sessionPinTickClaims, repository: 'attacker/fork' }, 'repository'],
    [
      {
        ...sessionPinTickClaims,
        job_workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      },
      'job_workflow_ref',
    ],
    [{ ...sessionPinTickClaims, ref: 'refs/heads/feature' }, 'ref'],
    [{ ...sessionPinTickClaims, event_name: 'pull_request' }, 'event_name'],
  ])('rejects a caller with the wrong %s claim', (claims, field) => {
    expect(() => assertSessionPinTickOidcClaims(claims, repository)).toThrow(
      field,
    );
  });
});

// #1215: the internal-workflow request path. Unlike the reconciler's pinned
// workflow, `workflow_ref` here is deliberately NOT pinned to a specific
// file -- any of the caller repository's own main-branch workflows may
// request work. See `isOwnWorkflowRefOnMain`'s doc comment for why that's
// safe (branch-protected `main` means repo-maintainer-controlled code).
const requestClaims = {
  aud: REQUEST_OIDC_AUDIENCE,
  repository,
  repository_id: '1307149765',
  run_id: '93099054125',
  workflow_ref: `${repository}/.github/workflows/pr-heal.yml@refs/heads/main`,
  ref: 'refs/heads/main',
  event_name: 'schedule',
};

describe('GitHub Actions request OIDC claims (#1215)', () => {
  it('accepts any of the repository’s own main-branch workflows', () => {
    expect(assertRequestOidcClaims(requestClaims, repository)).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
    for (const workflowPath of [
      'playbook-unstick-prs.yml',
      'visual-refresh.yml',
      'post-deploy-verify.yml',
    ]) {
      expect(
        assertRequestOidcClaims(
          {
            ...requestClaims,
            workflow_ref: `${repository}/.github/workflows/${workflowPath}@refs/heads/main`,
          },
          repository,
        ),
      ).toEqual({
        repository,
        repositoryId: 1_307_149_765,
        runId: 93_099_054_125,
      });
    }
  });

  it.each(['schedule', 'workflow_dispatch', 'workflow_run', 'push'])(
    'accepts the %s internal-caller event shape',
    (eventName) => {
      expect(
        assertRequestOidcClaims(
          { ...requestClaims, event_name: eventName },
          repository,
        ),
      ).toMatchObject({ repository });
    },
  );

  it.each([
    [{ ...requestClaims, repository: 'attacker/fork' }, 'repository'],
    [{ ...requestClaims, ref: 'refs/heads/feature' }, 'ref'],
    [{ ...requestClaims, event_name: 'pull_request' }, 'event_name'],
    [{ ...requestClaims, event_name: 'issue_comment' }, 'event_name'],
    [{ ...requestClaims, repository_id: 'not-a-number' }, 'repository_id'],
    [{ ...requestClaims, run_id: '0' }, 'run_id'],
    [
      // Another repo's workflow file, even with the right name -- the
      // caller repo's own workflow_ref never actually takes this shape,
      // but this proves the check compares against the CLAIMED
      // repository, not just any repository.
      {
        ...requestClaims,
        workflow_ref: `attacker/fork/.github/workflows/pr-heal.yml@refs/heads/main`,
      },
      'workflow_ref',
    ],
    [
      // A nested path under workflows/ -- not a real GitHub Actions claim
      // shape, but guards the parser against it anyway.
      {
        ...requestClaims,
        workflow_ref: `${repository}/.github/workflows/nested/pr-heal.yml@refs/heads/main`,
      },
      'workflow_ref',
    ],
    [
      // A reusable-workflow-call style `workflow_ref` pointing outside
      // `.github/workflows/` entirely.
      {
        ...requestClaims,
        workflow_ref: `${repository}/.github/actions/pr-heal.yml@refs/heads/main`,
      },
      'workflow_ref',
    ],
    [{ ...requestClaims, workflow_ref: undefined }, 'workflow_ref'],
  ])('rejects a request caller with the wrong %s claim', (claims, field) => {
    expect(() => assertRequestOidcClaims(claims, repository)).toThrow(field);
  });
});

describe('verifyRequestOidcToken repository allow-list (#1215)', () => {
  afterEach(() => {
    jwtVerify.mockReset();
  });

  it('admits the default single home-repo token', async () => {
    jwtVerify.mockResolvedValue({ payload: requestClaims });

    await expect(
      verifyRequestOidcToken('token', [repository]),
    ).resolves.toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
  });

  it('admits an allow-listed second repo, held to its own workflow_ref', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        ...requestClaims,
        repository: secondRepo,
        workflow_ref: `${secondRepo}/.github/workflows/pr-heal.yml@refs/heads/main`,
      },
    });

    await expect(
      verifyRequestOidcToken('token', [repository, secondRepo]),
    ).resolves.toEqual({
      repository: secondRepo,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
  });

  it('rejects a token claiming a repository outside the configured allow-list', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        ...requestClaims,
        repository: secondRepo,
        workflow_ref: `${secondRepo}/.github/workflows/pr-heal.yml@refs/heads/main`,
      },
    });

    // Allow-list omits secondRepo entirely.
    await expect(verifyRequestOidcToken('token', [repository])).rejects.toThrow(
      'allow-listed',
    );
  });

  it('requests the dispatch-request audience, not the reconciler one', async () => {
    jwtVerify.mockResolvedValue({ payload: requestClaims });

    await verifyRequestOidcToken('token', [repository]);

    expect(jwtVerify).toHaveBeenCalledWith(
      'token',
      expect.anything(),
      expect.objectContaining({ audience: REQUEST_OIDC_AUDIENCE }),
    );
  });
});
