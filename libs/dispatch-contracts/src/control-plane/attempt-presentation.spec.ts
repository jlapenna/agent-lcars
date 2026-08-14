import { describe, expect, it } from 'vitest';

import { attemptPresentationPlanSchema } from './attempt-presentation';

const sha = 'a'.repeat(64);
const plan = {
  schema: 'agent-lcars.attempt-presentation-plan/v1' as const,
  version: 1 as const,
  operationId: `attempt-final:${sha}`,
  tenant: {
    tenantId: 'tenant-1',
    repositoryId: 123,
    repository: 'octo/example',
    installationId: 456,
  },
  task: { tenantId: 'tenant-1', repositoryId: 123, issueNumber: 9 },
  attemptId: 'A'.repeat(22),
  attemptRevision: 9,
  finalizationCommandId: 'finalize-1',
  terminalFactId: 'terminal-1',
  outcomeDigest: sha,
  activation: {
    activationId: 'activation-1',
    taskClassId: 'github-issue',
    authorityEpoch: 1,
    mode: 'central-authoritative' as const,
  },
  presentation: {
    kind: 'attempt-finalized' as const,
    terminalState: 'succeeded' as const,
    execution: 'exited' as const,
    result: 'pull-request' as const,
    evidenceValidation: 'validated' as const,
  },
};

describe('AttemptPresentationPlanV1', () => {
  it('accepts only the closed provider-neutral finalized summary', () => {
    expect(attemptPresentationPlanSchema.parse(plan)).toEqual(plan);
    expect(
      attemptPresentationPlanSchema.safeParse({
        ...plan,
        presentation: {
          ...plan.presentation,
          commentBody: 'render me',
          githubRunId: 123,
          token: 'secret',
        },
      }).success,
    ).toBe(false);
  });

  it('requires exact tenant scope, central provenance, and closed failure truth', () => {
    expect(
      attemptPresentationPlanSchema.safeParse({
        ...plan,
        task: { ...plan.task, tenantId: 'tenant-2' },
      }).success,
    ).toBe(false);
    expect(
      attemptPresentationPlanSchema.safeParse({
        ...plan,
        activation: { ...plan.activation, mode: 'shadow' },
      }).success,
    ).toBe(false);
    expect(
      attemptPresentationPlanSchema.safeParse({
        ...plan,
        presentation: {
          ...plan.presentation,
          terminalState: 'failed',
          result: 'outcome-gate-failure',
          evidenceValidation: 'absent',
        },
      }).success,
    ).toBe(false);
    expect(
      attemptPresentationPlanSchema.safeParse({
        ...plan,
        presentation: {
          ...plan.presentation,
          failure: {
            owningSystem: 'finalizer',
            phase: 'validation',
            reason: 'deliverable_absent',
            retryDisposition: 'manual',
            evidenceRef: 'must-not-leak',
          },
        },
      }).success,
    ).toBe(false);
  });
});
