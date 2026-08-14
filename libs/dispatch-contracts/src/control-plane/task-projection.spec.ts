import { describe, expect, it } from 'vitest';

import { taskPresentationPlanSchema } from './task-projection';

const SHA = 'a'.repeat(64);
const plan = {
  schema: 'agent-lcars.task-presentation-plan/v1',
  version: 1,
  operationId: 'task-park:1',
  tenant: {
    tenantId: 'tenant-1',
    repositoryId: 1,
    repository: 'octo/repo',
    installationId: 2,
  },
  task: { tenantId: 'tenant-1', repositoryId: 1, issueNumber: 3 },
  taskRevision: 4,
  sourceFactId: 'fact-1',
  taskEffectKey: 'fact-1:park-projection',
  effectDigest: SHA,
  transitionDigest: SHA,
  activation: {
    activationId: 'activation-1',
    taskClassId: 'github-issue',
    authorityEpoch: 1,
    mode: 'central-authoritative',
  },
  presentation: {
    disposition: 'parked',
    humanAttention: 'required',
    notice: { kind: 'task-parked' },
    intentId: 'intent-1',
    intentRevision: 1,
    reason: 'policy-rejected',
  },
} as const;

describe('taskPresentationPlanSchema', () => {
  it('accepts only the closed provider-neutral parked presentation', () => {
    expect(taskPresentationPlanSchema.parse(plan)).toEqual(plan);
  });

  it('rejects provider rendering, raw text, mismatched tenant, and partial intent identity', () => {
    expect(
      taskPresentationPlanSchema.safeParse({ ...plan, label: 'parked' })
        .success,
    ).toBe(false);
    expect(
      taskPresentationPlanSchema.safeParse({
        ...plan,
        presentation: { ...plan.presentation, body: 'please stop' },
      }).success,
    ).toBe(false);
    expect(
      taskPresentationPlanSchema.safeParse({
        ...plan,
        tenant: { ...plan.tenant, tenantId: 'other' },
      }).success,
    ).toBe(false);
    expect(
      taskPresentationPlanSchema.safeParse({
        ...plan,
        tenant: { ...plan.tenant, repositoryId: 99 },
      }).success,
    ).toBe(false);
    expect(
      taskPresentationPlanSchema.safeParse({
        ...plan,
        presentation: { ...plan.presentation, intentRevision: undefined },
      }).success,
    ).toBe(false);
  });
});
