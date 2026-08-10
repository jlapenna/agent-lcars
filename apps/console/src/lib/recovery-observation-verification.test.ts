import {
  buildRecoveryObservation,
  type RecoveryObservation,
} from '@agent-lcars/dispatch-contracts';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import {
  verifierForDomain,
  verifyCiRetryObservation,
} from './recovery-observation-verification';

function fakeOctokit(
  impl: (params: {
    owner: string;
    repo: string;
    run_id: number;
  }) => Promise<{ data: { run_attempt?: number } }>,
): Octokit {
  return {
    rest: { actions: { getWorkflowRun: vi.fn(impl) } },
  } as unknown as Octokit;
}

function observationFixture(
  overrides: Partial<Parameters<typeof buildRecoveryObservation>[0]> = {},
): RecoveryObservation {
  return buildRecoveryObservation({
    target: {
      domain: 'ci_retry',
      repositoryId: 1_307_149_765,
      repository: 'jlapenna/agent-lcars',
      anchor: 42,
      exactIdentity: 'run:99:2',
    },
    sourceKind: 'webhook',
    observedAt: '2026-08-09T00:00:00.000Z',
    evidence: 'https://example.invalid/evidence',
    ...overrides,
  });
}

describe('verifyCiRetryObservation', () => {
  it('confirms when GitHub reports run_attempt at least the claimed one', async () => {
    const octokit = fakeOctokit(async ({ owner, repo, run_id }) => {
      expect(owner).toBe('jlapenna');
      expect(repo).toBe('agent-lcars');
      expect(run_id).toBe(99);
      return { data: { run_attempt: 2 } };
    });
    const outcome = await verifyCiRetryObservation(
      observationFixture(),
      octokit,
    );
    expect(outcome.state).toBe('confirmed');
  });

  it('confirms when GitHub reports an attempt HIGHER than claimed (a later rerun happened since)', async () => {
    const octokit = fakeOctokit(async () => ({ data: { run_attempt: 5 } }));
    const outcome = await verifyCiRetryObservation(
      observationFixture(),
      octokit,
    );
    expect(outcome.state).toBe('confirmed');
  });

  it('flags a mismatch when GitHub reports fewer attempts than claimed', async () => {
    const octokit = fakeOctokit(async () => ({ data: { run_attempt: 1 } }));
    const outcome = await verifyCiRetryObservation(
      observationFixture(),
      octokit,
    );
    expect(outcome.state).toBe('mismatch');
    expect(outcome.detail).toMatch(/attempt 1/u);
  });

  it('flags a mismatch (not unavailable) on a definitive 404 -- GitHub has no record of the claimed run', async () => {
    const octokit = fakeOctokit(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const outcome = await verifyCiRetryObservation(
      observationFixture(),
      octokit,
    );
    expect(outcome.state).toBe('mismatch');
    expect(outcome.detail).toMatch(/no run 99/u);
  });

  it('flags unavailable (not mismatch) on a transient GitHub failure', async () => {
    const octokit = fakeOctokit(async () => {
      throw Object.assign(new Error('service unavailable'), { status: 503 });
    });
    const outcome = await verifyCiRetryObservation(
      observationFixture(),
      octokit,
    );
    expect(outcome.state).toBe('unavailable');
  });

  it('flags unavailable on a plain network error with no status code', async () => {
    const octokit = fakeOctokit(async () => {
      throw new Error('ECONNRESET');
    });
    const outcome = await verifyCiRetryObservation(
      observationFixture(),
      octokit,
    );
    expect(outcome.state).toBe('unavailable');
  });

  it('flags a mismatch for an exactIdentity outside the run:<id>:<attempt> shape, without calling GitHub at all', async () => {
    const getWorkflowRun = vi.fn();
    const octokit = {
      rest: { actions: { getWorkflowRun } },
    } as unknown as Octokit;
    const outcome = await verifyCiRetryObservation(
      observationFixture({
        target: {
          domain: 'ci_retry',
          repositoryId: 1_307_149_765,
          repository: 'jlapenna/agent-lcars',
          anchor: 42,
          exactIdentity: 'not-a-run-identity',
        },
      }),
      octokit,
    );
    expect(outcome.state).toBe('mismatch');
    expect(getWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('verifierForDomain', () => {
  it('returns the ci_retry verifier for the ci_retry domain', () => {
    expect(verifierForDomain('ci_retry')).toBe(verifyCiRetryObservation);
  });

  it('returns undefined for every domain without a real caller yet', () => {
    expect(verifierForDomain('pr_healing')).toBeUndefined();
    expect(verifierForDomain('merge_follow_through')).toBeUndefined();
    expect(verifierForDomain('deployment_follow_through')).toBeUndefined();
    expect(verifierForDomain('post_deploy_verification')).toBeUndefined();
  });
});
