import {
  COMPLETION_FINALIZER_WORKFLOW_PATH,
  COMPLETION_OIDC_AUDIENCE,
} from '@agent-lcars/dispatch-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `verifyCompletionOidcToken`'s allow-list gate (#1190) needs to be exercised
// end-to-end -- including the jwtVerify call -- without a real GitHub OIDC
// token or network JWKS fetch. Only `jwtVerify` is replaced; the real
// `createRemoteJWKSet` is harmless to construct (it fetches lazily, only on
// first `jwtVerify` call) and every other test in this file already relies
// on it working unmocked.
const { jwtVerify } = vi.hoisted(() => ({ jwtVerify: vi.fn() }));

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, jwtVerify };
});

import {
  assertCompletionOidcClaims,
  assertReconcileOidcClaims,
  assertRequestOidcClaims,
  assertScheduleTickOidcClaims,
  verifyCompletionOidcToken,
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
// tests still resolves `controlPlaneRepository()` (the finalizer's home)
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

// #1502 sub-project 3: the scheduled tick trigger for cron-ingressed work.
// One canonical caller, like the reconciler -- pinned to the control-plane
// home via `job_workflow_ref`, not the request path's allow-list.
const SCHEDULE_TICK_OIDC_AUDIENCE = 'agent-lcars-work-schedules';
const SCHEDULE_TICK_WORKFLOW_PATH = '.github/workflows/work-schedules-tick.yml';

const scheduleTickClaims = {
  aud: SCHEDULE_TICK_OIDC_AUDIENCE,
  repository,
  repository_id: '1307149765',
  run_id: '93099054125',
  job_workflow_ref: `${repository}/${SCHEDULE_TICK_WORKFLOW_PATH}@refs/heads/main`,
  ref: 'refs/heads/main',
  event_name: 'schedule',
};

describe('GitHub Actions schedule-tick OIDC claims', () => {
  it('accepts the scheduled and manual tick workflow on main', () => {
    expect(
      assertScheduleTickOidcClaims(scheduleTickClaims, repository),
    ).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
    expect(
      assertScheduleTickOidcClaims(
        { ...scheduleTickClaims, event_name: 'workflow_dispatch' },
        repository,
      ),
    ).toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
    });
  });

  it.each([
    [{ ...scheduleTickClaims, repository: 'attacker/fork' }, 'repository'],
    [
      {
        ...scheduleTickClaims,
        job_workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
      },
      'job_workflow_ref',
    ],
    [{ ...scheduleTickClaims, ref: 'refs/heads/feature' }, 'ref'],
    [{ ...scheduleTickClaims, event_name: 'pull_request' }, 'event_name'],
    [{ ...scheduleTickClaims, repository_id: 'not-a-number' }, 'repository_id'],
    [{ ...scheduleTickClaims, run_id: '0' }, 'run_id'],
  ])('rejects a caller with the wrong %s claim', (claims, field) => {
    expect(() => assertScheduleTickOidcClaims(claims, repository)).toThrow(
      field,
    );
  });
});

// The shared, fleet-wide completion finalizer (jlapenna/agent-lcars's own
// .github/workflows/agent-fallback-finalize.yml) is called as a reusable
// `workflow_call` by every onboarded repo's worker -- there is no per-repo
// copy. GitHub's OIDC token therefore claims `job_workflow_ref` from the
// CALLED workflow's own repo/path/ref (always the home repo), while
// `repository`/`workflow_ref` continue to name the CALLER.
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

describe('GitHub Actions completion OIDC claims', () => {
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

// #1190: a second allow-listed repo is held to its OWN workflow_ref formula
// but the CANONICAL (home-repo) job_workflow_ref -- there is only ever one
// shared finalizer, so a token whose job_workflow_ref names ITS OWN repo's
// copy of that filename must be rejected, not accepted.
describe('GitHub Actions completion OIDC claims: multi-repo allow-list (#1190)', () => {
  const secondRepoClaims = {
    ...completionClaims,
    repository: secondRepo,
    workflow_ref: `${secondRepo}/.github/workflows/codex.yml@refs/heads/main`,
    // job_workflow_ref intentionally left as completionClaims' home-repo
    // finalizer ref -- the canonical shared one, not secondRepo's own.
  };

  it('accepts a second repo whose job_workflow_ref is the canonical home-repo finalizer', () => {
    expect(assertCompletionOidcClaims(secondRepoClaims, secondRepo)).toEqual({
      repository: secondRepo,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
      workflow: 'codex.yml',
    });
  });

  it('rejects a second repo whose job_workflow_ref points at its OWN finalizer copy', () => {
    const ownFinalizerClaims = {
      ...secondRepoClaims,
      job_workflow_ref: `${secondRepo}/${COMPLETION_FINALIZER_WORKFLOW_PATH}@refs/heads/main`,
    };
    expect(() =>
      assertCompletionOidcClaims(ownFinalizerClaims, secondRepo),
    ).toThrow('job_workflow_ref');
  });
});

describe('verifyCompletionOidcToken repository allow-list (#1190)', () => {
  afterEach(() => {
    jwtVerify.mockReset();
  });

  it('admits the default single home-repo token unchanged', async () => {
    jwtVerify.mockResolvedValue({ payload: completionClaims });

    await expect(
      verifyCompletionOidcToken('token', [repository]),
    ).resolves.toEqual({
      repository,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
      workflow: 'codex.yml',
    });
  });

  it('admits an allow-listed second repo, held to its own workflow_ref and the canonical finalizer', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        ...completionClaims,
        repository: secondRepo,
        workflow_ref: `${secondRepo}/.github/workflows/codex.yml@refs/heads/main`,
      },
    });

    await expect(
      verifyCompletionOidcToken('token', [repository, secondRepo]),
    ).resolves.toEqual({
      repository: secondRepo,
      repositoryId: 1_307_149_765,
      runId: 93_099_054_125,
      workflow: 'codex.yml',
    });
  });

  it('rejects a second-repo token whose job_workflow_ref points at its own finalizer', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        ...completionClaims,
        repository: secondRepo,
        workflow_ref: `${secondRepo}/.github/workflows/codex.yml@refs/heads/main`,
        job_workflow_ref: `${secondRepo}/${COMPLETION_FINALIZER_WORKFLOW_PATH}@refs/heads/main`,
      },
    });

    await expect(
      verifyCompletionOidcToken('token', [repository, secondRepo]),
    ).rejects.toThrow('job_workflow_ref');
  });

  it('rejects a token claiming a repository outside the configured allow-list', async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        ...completionClaims,
        repository: secondRepo,
        workflow_ref: `${secondRepo}/.github/workflows/codex.yml@refs/heads/main`,
      },
    });

    // Allow-list omits secondRepo entirely.
    await expect(
      verifyCompletionOidcToken('token', [repository]),
    ).rejects.toThrow('allow-listed');
  });
});

// #1215: the internal-workflow request path. Unlike the reconciler
// (one pinned workflow) or completion's `job_workflow_ref` (one shared
// finalizer), `workflow_ref` here is deliberately NOT pinned to a specific
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
    for (const workflowFile of [
      'playbook-unstick-prs.yml',
      'visual-refresh.yml',
      'post-deploy-verify.yml',
    ]) {
      expect(
        assertRequestOidcClaims(
          {
            ...requestClaims,
            workflow_ref: `${repository}/.github/workflows/${workflowFile}@refs/heads/main`,
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

  it('requests the dispatch-request audience, not the reconciler or completion one', async () => {
    jwtVerify.mockResolvedValue({ payload: requestClaims });

    await verifyRequestOidcToken('token', [repository]);

    expect(jwtVerify).toHaveBeenCalledWith(
      'token',
      expect.anything(),
      expect.objectContaining({ audience: REQUEST_OIDC_AUDIENCE }),
    );
  });
});
