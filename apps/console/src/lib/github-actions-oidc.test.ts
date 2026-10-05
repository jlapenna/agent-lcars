import { afterEach, describe, expect, it, vi } from 'vitest';

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
  assertSessionPinTickOidcClaims,
  assertWorkApiOidcClaims,
  githubActionsWorkSubject,
  verifyWorkApiOidcToken,
} from './github-actions-oidc';

const WORK_API_OIDC_AUDIENCE = 'agent-lcars-work';

const repository = 'jlapenna/agent-lcars';
// #1190: a second repository admitted only once it is added to the
// allow-list -- see deployment.ts's `controlPlaneRepositories`/
// `isControlPlaneRepository`. Not the home repo, so unset env in these
// tests still resolves `controlPlaneRepository()` (the control plane's home)
// to `repository` above.
const secondRepo = 'other-org/other-repo';

// Sub-project 6 (Task 8): the session-pin-tick trigger for the session
// reaper sweep, pinned to its own workflow file.
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

// Unlike the reconciler's pinned workflow, Work dispatch admits the caller
// repository's own protected-main workflows, so maintained automation can
// request an anchor without a provider or repository special case.
const workApiClaims = {
  aud: WORK_API_OIDC_AUDIENCE,
  repository,
  repository_id: '1307149765',
  run_id: '93099054125',
  workflow_ref: `${repository}/.github/workflows/pr-heal.yml@refs/heads/main`,
  ref: 'refs/heads/main',
  event_name: 'schedule',
};

describe('GitHub Actions Work API OIDC claims (#1633)', () => {
  afterEach(() => {
    jwtVerify.mockReset();
  });

  it('uses the normal Work API audience and returns the signed caller repository', async () => {
    expect(assertWorkApiOidcClaims(workApiClaims, repository)).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
    expect(githubActionsWorkSubject(repository)).toBe(
      'github-actions:jlapenna/agent-lcars',
    );

    jwtVerify.mockResolvedValue({ payload: workApiClaims });
    await expect(
      verifyWorkApiOidcToken('token', [repository]),
    ).resolves.toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
    expect(jwtVerify).toHaveBeenCalledWith(
      'token',
      expect.anything(),
      expect.objectContaining({ audience: WORK_API_OIDC_AUDIENCE }),
    );
  });

  it.each(['schedule', 'workflow_dispatch', 'workflow_run', 'push'])(
    'accepts the %s Work API caller event shape',
    (eventName) => {
      expect(
        assertWorkApiOidcClaims(
          { ...workApiClaims, event_name: eventName },
          repository,
        ),
      ).toMatchObject({ repository });
    },
  );

  it.each([
    [{ ...workApiClaims, repository: 'attacker/fork' }, 'repository'],
    [{ ...workApiClaims, ref: 'refs/heads/feature' }, 'ref'],
    [{ ...workApiClaims, event_name: 'pull_request' }, 'event_name'],
    [{ ...workApiClaims, event_name: 'issue_comment' }, 'event_name'],
    [{ ...workApiClaims, repository_id: 'not-a-number' }, 'repository_id'],
    [{ ...workApiClaims, run_id: '0' }, 'run_id'],
    [
      {
        ...workApiClaims,
        workflow_ref: `attacker/fork/.github/workflows/pr-heal.yml@refs/heads/main`,
      },
      'workflow_ref',
    ],
    [
      {
        ...workApiClaims,
        workflow_ref: `${repository}/.github/workflows/nested/pr-heal.yml@refs/heads/main`,
      },
      'workflow_ref',
    ],
    [
      {
        ...workApiClaims,
        workflow_ref: `${repository}/.github/actions/pr-heal.yml@refs/heads/main`,
      },
      'workflow_ref',
    ],
    [{ ...workApiClaims, workflow_ref: undefined }, 'workflow_ref'],
  ])('rejects a Work API caller with the wrong %s claim', (claims, field) => {
    expect(() => assertWorkApiOidcClaims(claims, repository)).toThrow(field);
  });

  it('admits an allow-listed second repository held to its own workflow', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        ...workApiClaims,
        repository: secondRepo,
        workflow_ref: `${secondRepo}/.github/workflows/pr-heal.yml@refs/heads/main`,
      },
    });

    await expect(
      verifyWorkApiOidcToken('token', [repository, secondRepo]),
    ).resolves.toEqual({
      repository: secondRepo,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
  });

  it('requires both an allow-listed repository and a protected-main workflow', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        ...workApiClaims,
        repository: secondRepo,
        workflow_ref: `${secondRepo}/.github/workflows/pr-heal.yml@refs/heads/main`,
      },
    });
    await expect(verifyWorkApiOidcToken('token', [repository])).rejects.toThrow(
      'allow-listed',
    );
    expect(() =>
      assertWorkApiOidcClaims(
        { ...workApiClaims, ref: 'refs/heads/feature' },
        repository,
      ),
    ).toThrow('ref');
  });
});
