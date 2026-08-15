import {
  LIFECYCLE_DURABILITY_LIMITS,
  serializedDurableByteLength,
} from '@agent-lcars/dispatch-contracts';
import { describe, expect, it } from 'vitest';

const SHA = 'a'.repeat(64);
const tenant = {
  tenantId: 'tenant-characterization',
  repositoryId: 123,
  repository: 'octo/characterization',
  installationId: 456,
};
const task = { tenantId: tenant.tenantId, repositoryId: 123, issueNumber: 9 };
const activation = {
  activationId: 'activation-1',
  taskClassId: 'github-issue',
  authorityEpoch: 1,
  mode: 'central-authoritative',
};
const timestamp = '2026-08-15T12:00:00.000Z';

function repeatedRecord(kind: string, index: number): Record<string, unknown> {
  return { kind, id: `${kind}-${index}`, content: 'x'.repeat(3_500) };
}

/** Intentionally max-shaped v1 aggregates; no production path truncates them. */
const taskFixture = {
  schema: 'agent-lcars.task-intent-state/v1',
  version: 1,
  tenant,
  task,
  revision: 200,
  activation,
  facts: Array.from({ length: 100 }, (_, index) =>
    repeatedRecord('fact', index),
  ),
  intents: Array.from({ length: 200 }, (_, index) =>
    repeatedRecord('intent', index),
  ),
  desired: { intentId: 'intent-199', intentRevision: 199 },
  attempt: { kind: 'none' },
  updatedAt: timestamp,
};

const attemptFixture = {
  schema: 'agent-lcars.attempt-state/v1',
  version: 1,
  spec: repeatedRecord('accepted-attempt-spec', 1),
  specDigest: SHA,
  revision: 400,
  phase: 'result-observed',
  launch: { operationId: 'operation-1', executionEpoch: 1, state: 'accepted' },
  executionEpoch: 1,
  facts: Array.from({ length: 200 }, (_, index) =>
    repeatedRecord('attempt-fact', index),
  ),
  commands: Array.from({ length: 200 }, (_, index) =>
    repeatedRecord('command', index),
  ),
  pendingClaims: Array.from({ length: 100 }, (_, index) =>
    repeatedRecord('claim', index),
  ),
  futureGrantsDenied: false,
  updatedAt: timestamp,
};

const characterizationFixtures = {
  task: taskFixture,
  attempt: attemptFixture,
  admission: {
    task: taskFixture,
    attempt: attemptFixture,
    launch: repeatedRecord('launch', 1),
  },
  taskEffect: {
    kind: 'cancel-or-drain',
    effectKey: 'effect-1',
    task: taskFixture,
    attempt: attemptFixture,
    attemptId: 'A'.repeat(22),
    activation,
  },
  cancellation: {
    eventId: 'cancel-1',
    task: taskFixture,
    attempt: attemptFixture,
    attemptId: 'A'.repeat(22),
    reason: 'operator-requested',
    observedAt: timestamp,
  },
  terminalPresentation: {
    kind: 'attempt-finalized',
    task,
    attemptId: 'A'.repeat(22),
    terminalState: 'succeeded',
    result: 'pull-request',
    reference: { kind: 'pull-request', number: 9 },
    evidence: repeatedRecord('terminal-evidence', 1),
  },
};

describe('durability characterization fixtures', () => {
  it('keeps max-shaped aggregate history observable and proves inline history is unsafe', () => {
    const sizes = Object.fromEntries(
      Object.entries(characterizationFixtures).map(([name, fixture]) => [
        name,
        serializedDurableByteLength(fixture),
      ]),
    );
    expect(sizes.task).toBeGreaterThan(
      LIFECYCLE_DURABILITY_LIMITS.taskHeadBytes,
    );
    expect(sizes.attempt).toBeGreaterThan(
      LIFECYCLE_DURABILITY_LIMITS.attemptHeadBytes,
    );
    for (const name of ['admission', 'taskEffect', 'cancellation']) {
      expect(sizes[name]).toBeGreaterThan(
        LIFECYCLE_DURABILITY_LIMITS.replayReceiptBytes,
      );
    }
    expect(sizes.terminalPresentation).toBeLessThan(
      LIFECYCLE_DURABILITY_LIMITS.replayReceiptBytes,
    );
    expect(Object.keys(sizes)).toEqual([
      'task',
      'attempt',
      'admission',
      'taskEffect',
      'cancellation',
      'terminalPresentation',
    ]);
  });
});
